#!/usr/bin/env bash
# devkit ship --pr <branch>: add the current changes to an EXISTING PR's branch as a NEW commit,
# fast-forward push (NEVER --force) — iterate on an open PR without overwriting its history.
#
# Why a separate flow from new-ship (ship-branch.sh): the base is the EXISTING remote branch tip
# (origin/<branch>), not this checkout's HEAD; the branch must already exist (the opposite preflight);
# the new commit is the DELTA between that tip and your current files (so we copy current content
# over the fetched tip rather than replay a HEAD-relative patch, which could conflict with the
# first ship's content); and we push ff to the branch (no -u, no new PR). The shared worktree +
# symlink + marker ceremony is duplicated rather than shared so this flow can't perturb new-ship.
# fallow-ignore-next-line code-duplication
#
# Usage:  ship --pr <branch> "<title>" [--markers-dir <d>]... [--link <d>]... [--] <path...>
#         # body via stdin. The <branch> is the existing PR's head branch.
set -euo pipefail

BR=${1:?branch}; TITLE=${2:?title}; shift 2

LINK_EXTRA=()
MARKER_DIRS=()
PATHS=()
BODY_SET=0         # --body given? else the body comes from stdin (back-compat)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr) shift ;;                                                   # mode flag (already routed here) — ignore
    --link) LINK_EXTRA+=("${2:?--link requires a directory}"); shift 2 ;;
    --markers-dir) MARKER_DIRS+=("${2:?--markers-dir requires a directory}"); shift 2 ;;
    --body) BODY_FLAG="${2:?--body requires text}"; BODY_SET=1; shift 2 ;;
    --) shift; while [ "$#" -gt 0 ]; do PATHS+=("$1"); shift; done; break ;;
    -*) echo "unknown flag: $1 (pass a dash-leading file path after --)" >&2; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

[ "${#PATHS[@]}" -gt 0 ] || { echo "no paths given" >&2; exit 1; }
for p in "${PATHS[@]}"; do
  [ -d "$p" ] && { echo "directory path not allowed (pass individual files): $p" >&2; exit 1; }
done

[ "${#MARKER_DIRS[@]}" -gt 0 ] || MARKER_DIRS=(.claude .cursor)
LINK_DIRS=(.husky/_ node_modules)
[ "${#LINK_EXTRA[@]}" -gt 0 ] && LINK_DIRS+=("${LINK_EXTRA[@]}")

ROOT=$(git rev-parse --show-toplevel)
# Resolve owner/repo from origin (best-effort — only used for the final PR-URL print, which falls
# back to a plain message; a non-GitHub origin still re-pushes fine).
REPO=$(git remote get-url origin | sed -E 's#^.*github\.com[^:/]*[:/]##; s#\.git$##')

# Test seam: print the resolved target + repo, then exit BEFORE any side effect (no fetch / push).
[ -n "${SHIP_RESOLVE_ONLY:-}" ] && { printf 'BR=%s\nREPO=%s\n' "$BR" "$REPO"; exit 0; }

if [ -z "${SHIP_DRY_RUN:-}" ] && ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed (needed to resolve the PR URL)" >&2; exit 1
fi

# The PR branch MUST already exist on the remote — re-push targets it. Fetch its tip; that fetched
# commit is the BASE the new commit sits on (so the diff is exactly the new delta).
git fetch origin "$BR" 2>/dev/null || {
  echo "no remote branch origin/$BR to re-push to — open the PR first (ship without --pr)" >&2; exit 1
}
BASE=$(git rev-parse FETCH_HEAD)

WT="${TMPDIR:-/tmp}/devkit-reship-${BR//\//-}-$$"
# Body: --body "<text>" wins (explicit, no temp file); else stdin (back-compat).
if [ "$BODY_SET" -eq 1 ]; then BODY="$BODY_FLAG"
elif [ -t 0 ]; then BODY=""
else BODY=$(cat); fi

cleanup() {
  git worktree remove --force "$WT" 2>/dev/null || true
}
trap cleanup EXIT

# Detached worktree at the PR branch tip — the new commit is parented on origin/<branch>.
git worktree add --detach "$WT" "$BASE" >&2

# Same gate-dep symlinks + fail-closed husky guard as new-ship (the gates must actually run).
if [ ! -e "$ROOT/.husky/_" ]; then
  echo "missing $ROOT/.husky/_ — run dependency setup before shipping (gates must not fail open)" >&2
  exit 1
fi
for d in "${LINK_DIRS[@]}"; do
  [ -e "$ROOT/$d" ] && ln -s "$ROOT/$d" "$WT/$d"
done

# Copy the CURRENT content of each path over the fetched tip (add/modify), or delete it. The commit
# diff is therefore (origin/<branch> tip → your current files) = exactly the new delta, with no
# HEAD-relative patch that could clash with the first ship's content.
for p in "${PATHS[@]}"; do
  if [ -e "$ROOT/$p" ]; then
    mkdir -p "$WT/$(dirname "$p")"
    cp -Pp "$ROOT/$p" "$WT/$p"
    git -C "$WT" add -- "$p"
  else
    git -C "$WT" rm -q --ignore-unmatch -- "$p" || true
  fi
done

# Nothing to add? Abort before an empty commit (a re-push with no delta is a no-op, not a commit).
git -C "$WT" diff --cached --quiet && { echo "no changes vs origin/$BR — nothing to re-push" >&2; exit 1; }

for r in commit-guard api-security backend-performance frontend-security frontend-performance; do
  for d in "${MARKER_DIRS[@]}"; do
    m="$ROOT/$d/.$r-passed"
    [ -e "$m" ] && { mkdir -p "$WT/$d"; cp "$m" "$WT/$d/"; }
  done
done

# Commit (gates run HERE). Capture + surface the gate output for the shipping agent — git buries it on
# the commit's stderr. Shared with new-ship. See commit-with-gate-capture.sh.
. "$(dirname "${BASH_SOURCE[0]}")/commit-with-gate-capture.sh"
commit_with_gate_capture "$WT" "$ROOT" "$BR" "$TITLE" "$BODY"

if [ -n "${SHIP_DRY_RUN:-}" ]; then
  echo "DRY: committed locally onto $BR (worktree $WT), skipped push." >&2
  git -C "$WT" show --stat --oneline HEAD >&2
  trap - EXIT  # keep the worktree for inspection
  echo "DRY: worktree kept at $WT. Remove with: git worktree remove --force '$WT'" >&2
  exit 0
fi

# Fast-forward push to the existing branch (NO --force). If origin/<branch> advanced since the fetch,
# this is rejected — the human resolves rather than overwriting someone's commit.
git -C "$WT" push origin "HEAD:$BR" || {
  echo "push to origin/$BR rejected (not a fast-forward — the branch advanced). Re-run after fetching." >&2
  exit 1
}

gh pr view "$BR" --repo "$REPO" --json url -q .url 2>/dev/null || echo "re-pushed to origin/$BR"
