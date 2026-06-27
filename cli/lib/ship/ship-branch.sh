#!/usr/bin/env bash
# Commit <path...> onto a NEW branch and open a PR WITHOUT switching this checkout.
#
# Why: parallel agents share one working tree, so HEAD/branch is global to it. A
# normal `git checkout -b` + commit moves HEAD for every agent in the tree, and
# the multi-minute hook chain widens the window for a parallel commit to land on
# the wrong branch. Instead we commit inside an ephemeral linked worktree: the
# shared tree's HEAD never moves (parallel work undisturbed) and the gates still
# run (the commit happens in the worktree, not via plumbing that skips hooks).
#
# A fresh linked worktree checks out clean at HEAD, so it lacks the gitignored
# deps the gates need (node_modules, and whatever else a repo passes via --link:
# e.g. a search index, a graph). We symlink them from the main checkout so the
# gates actually run instead of failing open.
#
# QA stays in the shared tree — the worktree exists only for the commit instant
# and is removed on exit. Scope is explicit paths; never auto-detect, because in a
# shared tree your files are indistinguishable from parallel work.
#
# NOTE on markers: the pre-commit reviewer-approval check reads gitignored .*-passed
# markers from disk. These are shared-tree-GLOBAL booleans, so the shipping agent
# MUST have just run its own reviewers — otherwise it could inherit a parallel
# agent's stale approval. Marker dirs default to .claude/.cursor; override/extend
# with --markers-dir. The reviewer-name SET is a devkit constant (devkit's own agents).
#
# Usage:   ship-branch.sh <branch> "<title>" [--markers-dir <d>]... [--link <d>]... [--] <path...>
#          # PR body via stdin; bare positional paths (no --) are also accepted.
# Preview: SHIP_DRY_RUN=1 ship-branch.sh ...   # local commit, no push/PR
set -euo pipefail

BR=${1:?branch}; TITLE=${2:?title}; shift 2

# Arg grammar: branch + title are the first two positionals (above). The rest is a mix of
# repeatable --markers-dir/--link flags and file paths; `--` forces everything after it to be a
# path (so a file literally named like a flag, or starting with `-`, ships safely). A bare arg
# that is not a known flag is also a path — preserving the old `<branch> <title> <path...>` form.
LINK_EXTRA=()      # extra symlink dirs beyond the universal base
MARKER_DIRS=()     # reviewer-marker dirs to carry (default .claude/.cursor)
PATHS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --link) LINK_EXTRA+=("${2:?--link requires a directory}"); shift 2 ;;
    --markers-dir) MARKER_DIRS+=("${2:?--markers-dir requires a directory}"); shift 2 ;;
    --) shift; while [ "$#" -gt 0 ]; do PATHS+=("$1"); shift; done; break ;;
    -*) echo "unknown flag: $1 (pass a dash-leading file path after --)" >&2; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

[ "${#PATHS[@]}" -gt 0 ] || { echo "no paths given" >&2; exit 1; }
# Files only: `git diff/ls-files -- <dir>` recurses and would sweep in a parallel
# agent's edits under that directory, defeating the per-file isolation. (A deleted
# file is not a dir, so it still passes — deletions are valid pathspecs.)
for p in "${PATHS[@]}"; do
  [ -d "$p" ] && { echo "directory path not allowed (pass individual files): $p" >&2; exit 1; }
done

# Default the marker dirs + assemble the symlink set (universal base + --link extras).
[ "${#MARKER_DIRS[@]}" -gt 0 ] || MARKER_DIRS=(.claude .cursor)
LINK_DIRS=(.husky/_ node_modules)
[ "${#LINK_EXTRA[@]}" -gt 0 ] && LINK_DIRS+=("${LINK_EXTRA[@]}")

# Preflight, fail fast before touching anything.
if git show-ref --verify -q "refs/heads/$BR"; then
  echo "branch already exists: $BR" >&2; exit 1
fi
if [ -z "${SHIP_DRY_RUN:-}" ] && ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed (needed to open the PR)" >&2; exit 1
fi
# Also reject an existing REMOTE branch — otherwise `push -u` fast-forwards onto it,
# silently appending this commit to someone else's branch/PR. (Skipped under dry-run:
# no push happens, and it avoids a network round-trip.)
if [ -z "${SHIP_DRY_RUN:-}" ]; then
  set +e
  git ls-remote --exit-code --heads origin "$BR" >/dev/null 2>&1
  remote_check=$?
  set -e
  # ls-remote exits 2 for "no matching ref" but ALSO non-zero on auth/network error — only exit 2
  # is a safe "branch absent"; any other failure must fail closed, or push -u could append to a PR.
  case "$remote_check" in
    0) echo "remote branch already exists: origin/$BR" >&2; exit 1 ;;
    2) ;; # no matching remote branch → safe to create it
    *) echo "could not verify remote branch (ls-remote exit $remote_check) — refusing to push" >&2; exit 1 ;;
  esac
fi

ROOT=$(git rev-parse --show-toplevel)
BASE=$(git rev-parse HEAD)   # pin once: shared HEAD may advance mid-run
# PR merges back into the branch we branched from. A detached HEAD has no such branch,
# so fail fast rather than silently targeting `main` (wrong base + a bogus diff).
BASE_REF=$(git symbolic-ref --quiet --short HEAD) || {
  echo "detached HEAD — run ship-branch.sh from a branch (the PR targets that branch)" >&2; exit 1
}
# Resolve owner/repo from origin (NOT gh's default — a fork's upstream remote can hijack it).
REPO=$(git remote get-url origin | sed -E 's#^.*github\.com[^:/]*[:/]##; s#\.git$##')
# A malformed origin leaves a bad REPO that would only surface AFTER the push — validate the shape now.
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "could not resolve origin to owner/repo: '$REPO'" >&2; exit 1
}

# Test seam: print the resolved PR target + repo, then exit before any side effect
# (no worktree, no stdin read, no push). Lets the regression test that guards the
# fork-repo-resolution bug run hermetically. Never set in normal use.
[ -n "${SHIP_RESOLVE_ONLY:-}" ] && { printf 'BASE_REF=%s\nREPO=%s\n' "$BASE_REF" "$REPO"; exit 0; }

WT="${TMPDIR:-/tmp}/devkit-ship-${BR//\//-}-$$"
PATCH=$(mktemp "${TMPDIR:-/tmp}/ship.XXXXXX")
# stdin -> commit + PR body. Guard the TTY case: invoked interactively with no piped
# body, a bare `cat` would block waiting for terminal input. (Empty stdin already
# yields ""; no `|| true`, so a genuine read error fails loud instead of silently
# shipping an empty body — nothing is created yet, so aborting here is clean.)
if [ -t 0 ]; then BODY=""; else BODY=$(cat); fi

cleanup() {
  rm -f "$PATCH"
  if [ -n "${SHIP_DRY_RUN:-}" ]; then
    echo "DRY: worktree kept at $WT (branch $BR). Inspect, then:" >&2
    echo "  git worktree remove --force '$WT' && git branch -D '$BR'" >&2
  else
    git worktree remove --force "$WT" 2>/dev/null || true
    # Drop the branch ONLY if it has no commit beyond BASE — i.e. the commit failed or
    # never ran, leaving an empty branch that would just block a retry at the preflight.
    # A branch that DID get the commit (e.g. the commit succeeded but the push failed) is
    # KEPT so the work stays recoverable; it is deleted explicitly after push + PR succeed.
    [ "$(git rev-parse -q --verify "$BR" 2>/dev/null)" = "$BASE" ] && git branch -D "$BR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

git worktree add -b "$BR" "$WT" "$BASE" >&2

# Symlink gitignored gate deps from the main checkout so the hooks actually run.
# .husky/_ is the husky RUNNER dir (gitignored, generated by `prepare`); without it
# core.hooksPath=.husky/_ resolves to nothing and the whole gate chain silently
# no-ops. node_modules -> bunx/eslint/guard-*; --link extras -> a repo's own gate deps.
# SYNC CONTRACT: the universal base (.husky/_, node_modules) + each repo's --link set must
# cover what its pre-commit hook needs — a missing gitignored dep makes that gate fail-open.
# Fail CLOSED if the husky runner is absent: without it the worktree commit runs with NO gates,
# silently shipping ungated code. Run dependency setup (`prepare` / `husky`) before shipping.
# ponytail: husky-assumed (.husky/_) — a lefthook / non-husky repo would need a hook-runner knob;
# every devkit-onboarded repo wires husky, so the realistic consumer set always has it.
if [ ! -e "$ROOT/.husky/_" ]; then
  echo "missing $ROOT/.husky/_ — run dependency setup before shipping (gates must not fail open)" >&2
  exit 1
fi
for d in "${LINK_DIRS[@]}"; do
  [ -e "$ROOT/$d" ] && ln -s "$ROOT/$d" "$WT/$d"
done

# Tracked edits (modify + delete, binary-safe) -> worktree index.
git -C "$ROOT" diff "$BASE" --binary -- "${PATHS[@]}" > "$PATCH"
[ -s "$PATCH" ] && git -C "$WT" apply --index "$PATCH"

# Untracked new files in scope -> copy + stage.
git -C "$ROOT" ls-files -o --exclude-standard -- "${PATHS[@]}" | while IFS= read -r f; do
  mkdir -p "$WT/$(dirname "$f")"
  cp -Pp "$ROOT/$f" "$WT/$f"   # -P: keep a symlink a symlink; -p: preserve mode (the +x bit) regardless of umask
  git -C "$WT" add -- "$f"
done

# Carry ONLY the markers the hook actually checks (by exact name, not a .*-passed
# glob) so the approval gate passes without dragging in unrelated/stale markers.
for r in commit-guard api-security backend-performance frontend-security frontend-performance; do
  for d in "${MARKER_DIRS[@]}"; do
    m="$ROOT/$d/.$r-passed"
    [ -e "$m" ] && { mkdir -p "$WT/$d"; cp "$m" "$WT/$d/"; }
  done
done

# Commit inside the worktree (hook gates run HERE). Capture + surface the gate output so the shipping
# agent reliably sees the verdicts — git buries them on the commit's stderr. See commit-with-gate-capture.sh.
. "$(dirname "${BASH_SOURCE[0]}")/commit-with-gate-capture.sh"
commit_with_gate_capture "$WT" "$ROOT" "$BR" "$TITLE" "$BODY"

if [ -n "${SHIP_DRY_RUN:-}" ]; then
  echo "DRY: committed locally on $BR, skipped push + PR." >&2
  git -C "$WT" show --stat --oneline HEAD >&2
  exit 0
fi

git -C "$WT" push -u origin "$BR"
PR_URL=$( cd "$WT" && gh pr create --repo "$REPO" --base "$BASE_REF" --head "$BR" --title "$TITLE" --body "$BODY" ) || {
  echo "push OK but PR create failed — branch is pushed. Retry:" >&2
  echo "  gh pr create --repo '$REPO' --base '$BASE_REF' --head '$BR'" >&2
  exit 1
}
echo "$PR_URL"   # surface the PR URL (we captured gh's stdout to recover the PR number below)

# Record what shipped so `devkit reconcile` can later replace these now-stale local copies in
# the shared tree with the merged-upstream version (no stash/pull). Best-effort: the PR already
# exists, so a manifest miss only costs a manual reconcile later — it must never unwind a PR.
# The PR number is the trailing path segment of the URL gh just printed (one gh call, not two).
PR_NUM=${PR_URL##*/}
[[ "$PR_NUM" =~ ^[0-9]+$ ]] || PR_NUM=""
# --git-root "$WT" hashes the just-COMMITTED blobs (what the PR shipped), not $ROOT's working tree —
# so a parallel agent's edit to a shipped file in this window can't be mis-recorded as the shipped blob.
# The manifest itself still lands in $ROOT (the persistent shared tree); $WT is removed right after.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$SCRIPT_DIR/reconcile-manifest-write.mjs" \
  --root "$ROOT" --git-root "$WT" --branch "$BR" --repo "$REPO" --base-ref "$BASE_REF" --base-sha "$BASE" --pr "$PR_NUM" -- "${PATHS[@]}" \
  || echo "ship-branch: reconcile manifest not recorded (non-fatal)" >&2

# Success: the branch is on the remote with its PR, so the local copy is redundant.
# Drop it now (worktree first — a branch checked out in a worktree can't be deleted).
# Only reached on full success; any earlier failure keeps the branch for recovery.
git worktree remove --force "$WT" 2>/dev/null || true
git branch -D "$BR" 2>/dev/null || true
