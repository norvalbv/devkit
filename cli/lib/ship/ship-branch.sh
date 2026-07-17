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
# Usage:   ship-branch.sh <branch> "<title>" [--base <b>] [--link <d>]... [--] <path...>
#          # PR body via stdin; bare positional paths (no --) are also accepted.
# Preview: SHIP_DRY_RUN=1 ship-branch.sh ...   # local commit, no push/PR
set -euo pipefail

BR=${1:?branch}; TITLE=${2:?title}; shift 2

# Arg grammar: branch + title are the first two positionals (above). The rest is a mix of
# repeatable --link flags and file paths; `--` forces everything after it to be a
# path (so a file literally named like a flag, or starting with `-`, ships safely). A bare arg
# that is not a known flag is also a path — preserving the old `<branch> <title> <path...>` form.
LINK_EXTRA=()      # extra symlink dirs beyond the universal base
PATHS=()
BODY_SET=0         # --body given? else the body comes from stdin (back-compat)
BASE_FLAG=""       # --base <branch>? else base off this checkout's HEAD/current branch
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) BASE_FLAG="${2:?--base requires a branch}"; shift 2 ;;
    --link) LINK_EXTRA+=("${2:?--link requires a directory}"); shift 2 ;;
    --body) BODY_FLAG="${2:?--body requires text}"; BODY_SET=1; shift 2 ;;
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
  [ -d "$p" ] && {
    echo "directory path not allowed (pass individual files): $p" >&2
    echo "  list its tracked files: git ls-files -- \"$p\"" >&2
    exit 1
  }
done

# Assemble the symlink set (universal base + --link extras).
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
# The PR target branch. Default: the branch we branched from — the PR merges back into it. A detached
# HEAD has no such branch, so fail fast rather than silently targeting `main` (wrong base + a bogus
# diff). With --base <branch> the PR targets THAT branch instead, so a repo whose source-of-truth
# branch differs from its PR base can ship from either without checking out / juggling worktrees.
if [ -n "$BASE_FLAG" ]; then
  # `origin/x` and `x` both mean branch x: the PR base is a branch NAME, and the tip we branch off is
  # always origin's (below) — so the two spellings must not diverge into two different bases.
  BASE_REF=${BASE_FLAG#origin/}
else
  BASE_REF=$(git symbolic-ref --quiet --short HEAD) || {
    echo "detached HEAD — run ship-branch.sh from a branch (the PR targets that branch)" >&2; exit 1
  }
fi
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

# The commit the ephemeral worktree is cut from — and therefore what the gates judge and what the PR
# diffs against. Resolved AFTER the seam above: --base needs the network, and the seam promises no
# side effects. Nothing between there and here reads $BASE.
if [ -n "$BASE_FLAG" ]; then
  # origin's tip, not the local copy: in a shared parallel-agent checkout the local base branch is
  # routinely stale, and a worktree cut from a stale base makes the gates judge code GitHub will never
  # merge into. (The PR DIFF would still be right — GitHub diffs from the merge-base — so this buys
  # gate accuracy, not diff accuracy.) reship.sh sets the precedent: it fetches its base the same way.
  # The source ref is fully-qualified `refs/heads/` — NOT a bare ref, which would also match a tag: a
  # PR base must be a BRANCH, so a sha or tag has to fail HERE, not at `gh pr create` after the push.
  # One round-trip proves both (the branch exists AND it is a branch).
  git fetch -q origin "refs/heads/$BASE_REF" 2>/dev/null || {
    echo "--base: no branch origin/$BASE_REF (a PR base must be a remote branch — not a sha or a tag)" >&2
    exit 1
  }
  BASE=$(git rev-parse FETCH_HEAD)
else
  BASE=$(git rev-parse HEAD)   # pin once: shared HEAD may advance mid-run
fi

# Nothing to commit → say so NOW. Staging (below) has exactly two inputs: the tracked diff vs BASE
# and the untracked files in scope. Both empty ⇒ an empty index — which git only reports AFTER the
# whole gate chain has run ("nothing added to commit but untracked files present", the untracked ones
# being our own gate symlinks), whereupon the EXIT trap force-deletes the branch it just made and
# prints a bare "Deleted branch … (was …)" on stdout. The operator pays a multi-minute gate run for a
# cryptic failure. reship.sh's "no changes vs origin/$BR" guard already covers the re-push flow; here
# is its new-ship twin, hoisted ahead of the worktree so nothing is created to churn. Mirrors the two
# staging commands exactly (same BASE, same --exclude-standard, same pathspec) so the guard cannot
# disagree with what staging will do. A git ERROR (non-zero but not "differences found") reads as
# "has changes" and falls through to the old behaviour — fail toward the status quo, never toward a
# false abort. Says "no changes in" rather than "identical to": a misspelled path also lands here
# (`git diff --quiet -- nonexistent` exits 0), and the wording stays true for it.
if git -C "$ROOT" diff --quiet "$BASE" -- "${PATHS[@]}" &&
   [ -z "$(git -C "$ROOT" ls-files -o --exclude-standard -- "${PATHS[@]}")" ]; then
  echo "nothing to commit: no changes in ${PATHS[*]} vs $BASE_REF (${BASE:0:7})" >&2
  if [ -n "$BASE_FLAG" ]; then
    # --base already answers "your work is committed elsewhere" — the remaining causes are a base that
    # already has this content, or a typo. Never re-suggest checking out: not doing so is the point.
    echo "these paths are already identical on origin/$BASE_REF — wrong --base, or a misspelled path?" >&2
  else
    echo "already committed, wrong checkout, or a misspelled path? ship bases the PR on this checkout's branch ($BASE_REF) — check out the branch your work is on, or pass --base <branch> to diff your working tree against a different branch instead." >&2
  fi
  exit 1
fi

WT="${TMPDIR:-/tmp}/devkit-ship-${BR//\//-}-$$"
PATCH=$(mktemp "${TMPDIR:-/tmp}/ship.XXXXXX")
# Body: --body "<text>" wins (explicit, no temp file); else stdin (back-compat — a piped/here-doc
# body still works). Guard the TTY case: invoked interactively with no piped body, a bare `cat` would
# block on terminal input. (Empty stdin already yields ""; no `|| true`, so a genuine read error
# fails loud instead of silently shipping an empty body — nothing is created yet, so aborting is clean.)
if [ "$BODY_SET" -eq 1 ]; then BODY="$BODY_FLAG"
elif [ -t 0 ]; then BODY=""
else BODY=$(cat); fi

cleanup() {
  rm -f "$PATCH"
  # Reclaim the ephemeral worktree + branch whenever no commit landed beyond BASE — the commit
  # failed, never ran, or was reset by the honest-banner abort in commit-with-gate-capture.sh,
  # leaving an empty branch + throwaway worktree with nothing to inspect or recover. This fires on
  # EVERY exit, incl. DRY and the fail-closed preflight exits — otherwise a failed dry-run leaks a
  # devkit-ship-* worktree + branch (they then show as "checked out in a linked worktree" and block
  # deletion). An absent branch (worktree add failed) is treated the same. Keying on the commit —
  # not on SHIP_DRY_RUN — is what the sibling reship.sh already does. Worktree first: a branch
  # checked out in a worktree can't be deleted.
  local tip; tip=$(git rev-parse -q --verify "$BR" 2>/dev/null || true)
  if [ -z "$tip" ] || [ "$tip" = "$BASE" ]; then
    git worktree remove --force "$WT" 2>/dev/null || true
    [ -n "$tip" ] && git branch -D "$BR" 2>/dev/null || true
    return
  fi
  # A commit DID land beyond BASE.
  if [ -n "${SHIP_DRY_RUN:-}" ]; then
    # Dry-run success: keep the worktree so the operator can inspect the local commit.
    echo "DRY: worktree kept at $WT (branch $BR). Inspect, then:" >&2
    echo "  git worktree remove --force '$WT' && git branch -D '$BR'" >&2
  else
    # Non-dry: remove the worktree; KEEP the branch (commit succeeded but push/PR may have failed)
    # so the work stays recoverable — it is deleted explicitly after push + PR succeed (below).
    git worktree remove --force "$WT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

git worktree add -q -b "$BR" "$WT" "$BASE" >&2

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
#
# Overlay mode keeps the gate chain in .devkit/hooks/pre-commit — git-excluded, so it never
# materializes in a fresh worktree and the husky shim silently no-ops (shipping UNGATED code).
# Link it so the chain runs; fail CLOSED if the config declares overlay but the hook is missing
# (mirrors the .husky/_ contract — gates must not fail open). The commit itself forces
# core.hooksPath=.devkit/hooks so the overlay hook fires regardless of husky-reclaim state.
# ponytail: naive JSON grep for the flag; swap for a real parser if the config schema drifts.
if grep -Eq '"overlay"[[:space:]]*:[[:space:]]*true' "$ROOT/.devkit/config.json" 2>/dev/null; then
  [ -x "$ROOT/.devkit/hooks/pre-commit" ] || {
    echo "overlay mode but $ROOT/.devkit/hooks/pre-commit missing/non-executable — run 'devkit init --overlay' (gates must not fail open)" >&2
    exit 1
  }
  LINK_DIRS+=(.devkit)
fi
if [ ! -e "$ROOT/.husky/_" ]; then
  echo "missing $ROOT/.husky/_ — run dependency setup before shipping (gates must not fail open)" >&2
  exit 1
fi
for d in "${LINK_DIRS[@]}"; do
  [ -e "$ROOT/$d" ] && ln -s "$ROOT/$d" "$WT/$d"
done

# .claude/{agents,skills} are devkit sync artifacts (devkit sync-agents / sync-skills). In an overlay
# consumer they're git-ignored, so a fresh worktree lacks them and guard-review can't load reviewer
# briefs (.claude/agents/<name>.md) or run the judge checklist (.claude/skills/<skill>/scripts/
# checklist.mjs) — every reviewer INCONCLUSIVEs, which under ship strict (GUARD_AI_STRICT) fails CLOSED,
# aborting every overlay ship. Link the two SUBDIRS — not the whole .claude: the checklist writes
# per-run state to .claude/.<skill>-review.json in cwd, which must stay in the ephemeral worktree, not
# leak into the shared main tree. Skip a subdir already checked out (repos that TRACK .claude, e.g.
# devkit itself, get it via git checkout — a symlink onto it nests a bogus .../agents/agents).
# ponytail: .claude/agents is sync-agents' hardcoded write target AND guard-review's agentsDir default;
# a custom RELATIVE review.agentsDir isn't covered (still fails CLOSED, not open).
if [ -d "$ROOT/.claude/agents" ] || [ -d "$ROOT/.claude/skills" ]; then
  mkdir -p "$WT/.claude"
  for sub in agents skills; do
    if [ -e "$ROOT/.claude/$sub" ] && [ ! -e "$WT/.claude/$sub" ]; then
      ln -s "$ROOT/.claude/$sub" "$WT/.claude/$sub"
    fi
  done
fi

# Tracked edits (modify + delete, binary-safe) -> worktree index.
git -C "$ROOT" diff "$BASE" --binary -- "${PATHS[@]}" > "$PATCH"
[ -s "$PATCH" ] && git -C "$WT" apply --index "$PATCH"

# Untracked new files in scope -> copy + stage.
git -C "$ROOT" ls-files -o --exclude-standard -- "${PATHS[@]}" | while IFS= read -r f; do
  mkdir -p "$WT/$(dirname "$f")"
  cp -Pp "$ROOT/$f" "$WT/$f"   # -P: keep a symlink a symlink; -p: preserve mode (the +x bit) regardless of umask
  git -C "$WT" add -- "$f"
done

# Link gate configs that live in the repo but aren't in this fresh checkout (an untracked config, a
# gitignored index) so the worktree gates match a plain commit instead of silently running on defaults.
. "$(dirname "${BASH_SOURCE[0]}")/link-gate-configs.sh"
link_untracked_gate_configs "$WT" "$ROOT"

# Commit inside the worktree (hook gates run HERE). Capture + surface the gate output so the shipping
# agent reliably sees the verdicts — git buries them on the commit's stderr. See commit-with-gate-capture.sh.
. "$(dirname "${BASH_SOURCE[0]}")/commit-with-gate-capture.sh"
# The commit the worktree was cut from — lets in-chain gates (fallow) diff against IT, not their own
# main-autodetect. Unconditional (not just under --base): even the default case is more precise than
# a gate auto-detecting main, for any branch that isn't a fresh cut off main (DK-5).
export DEVKIT_SHIP_BASE_SHA="$BASE"
export DEVKIT_SHIP_MODE=ship   # tags the ship_attempt telemetry (new-ship vs reship retry)
commit_with_gate_capture "$WT" "$ROOT" "$BR" "$TITLE" "$BODY"

if [ -n "${SHIP_DRY_RUN:-}" ]; then
  echo "DRY: committed locally on $BR, skipped push + PR." >&2
  git -C "$WT" show --stat --oneline HEAD >&2
  exit 0
fi

git -C "$WT" push -u origin "$BR"

# Push succeeded → the branch is live on the remote and reconcilable NOW, whatever the PR step does.
# Open the PR, but a create FAILURE must NOT skip the manifest write below: recording on PR-create
# (not on push) orphans the pushed branch from reconcile forever on a single gh hiccup (wrong account,
# transient GraphQL error), so the merged work later lingers as stale local copies. Capture the
# failure instead of exiting; record the branch first, then surface the failure afterward.
PR_CREATE_FAILED=
PR_URL=$( cd "$WT" && gh pr create --repo "$REPO" --base "$BASE_REF" --head "$BR" --title "$TITLE" --body "$BODY" ) || PR_CREATE_FAILED=1
PR_NUM=""
if [ -z "$PR_CREATE_FAILED" ]; then
  echo "$PR_URL"   # surface the PR URL (we captured gh's stdout to recover the PR number below)
  # The PR number is the trailing path segment of the URL gh just printed (one gh call, not two).
  PR_NUM=${PR_URL##*/}
  [[ "$PR_NUM" =~ ^[0-9]+$ ]] || PR_NUM=""
fi

# Record what shipped the instant the PUSH succeeded — independent of `gh pr create` — so `devkit
# reconcile` can later replace these now-stale local copies in the shared tree with the merged-upstream
# version (no stash/pull). On a PR-create failure we record pr:null; reconcile self-heals it once a PR
# exists + merges (it resolves merge state by `gh pr view <branch>`, not by the stored number).
# Best-effort: a manifest miss only costs a manual reconcile later — it must never unwind the push.
# --git-root "$WT" hashes the just-COMMITTED blobs (what the PR shipped), not $ROOT's working tree —
# so a parallel agent's edit to a shipped file in this window can't be mis-recorded as the shipped blob.
# The manifest itself still lands in $ROOT (the persistent shared tree); $WT is removed right after.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# devkit's own modules are .mts in the source tree (Node strips types) and compiled .mjs in an
# installed consumer (dist). Prefer whichever exists beside this script.
RMW="$SCRIPT_DIR/reconcile-manifest-write.mts"; [ -f "$RMW" ] || RMW="$SCRIPT_DIR/reconcile-manifest-write.mjs"
node "$RMW" \
  --root "$ROOT" --git-root "$WT" --branch "$BR" --repo "$REPO" --base-ref "$BASE_REF" --base-sha "$BASE" --pr "$PR_NUM" -- "${PATHS[@]}" \
  || echo "ship-branch: reconcile manifest not recorded (non-fatal)" >&2

# PR-create failed but the push + manifest record both landed: the branch is recoverable AND known to
# reconcile. Tell the operator how to open the PR by hand; reconcile cleans the branch once it merges.
if [ -n "$PR_CREATE_FAILED" ]; then
  echo "push OK but PR create failed — branch is pushed AND recorded for reconcile." >&2
  echo "Open the PR by hand (reconcile cleans the branch once it merges):" >&2
  echo "  gh pr create --repo '$REPO' --base '$BASE_REF' --head '$BR'" >&2
  exit 1
fi

# Success: the branch is on the remote with its PR, so the local copy is redundant.
# Drop it now (worktree first — a branch checked out in a worktree can't be deleted).
# Only reached on full success; any earlier failure keeps the branch for recovery.
git worktree remove --force "$WT" 2>/dev/null || true
git branch -D "$BR" 2>/dev/null || true
