#!/usr/bin/env bash
# Review a trusted local checkout/worktree through its complete devkit pre-commit chain without
# creating a branch or commit. The target snapshot is frozen as a Git tree using an alternate index;
# the ephemeral review worktree keeps HEAD at merge-base so every existing `git diff --cached` gate
# sees merge-base → final target state unchanged.
set -euo pipefail

TARGET=.
BASE_REF=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET=${2:?--target requires a path}; shift 2 ;;
    --base) BASE_REF=${2:?--base requires a ref}; shift 2 ;;
    *) echo "devkit review: unknown argument: $1" >&2; exit 1 ;;
  esac
done

ROOT=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null) || {
  echo "devkit review: target is not inside a Git repository: $TARGET" >&2
  exit 1
}
ROOT=$(cd "$ROOT" && pwd -P)
echo "⚠️  devkit review: trusted target only — repository hooks and package scripts will execute: $ROOT" >&2

# A no-diff cron run must still detect a dark/missing install rather than claim review readiness.
[ -f "$ROOT/.devkit/config.json" ] || {
  echo "devkit review: missing $ROOT/.devkit/config.json — run 'devkit doctor --fix'." >&2
  exit 1
}
[ -x "$ROOT/.husky/_/pre-commit" ] || {
  echo "devkit review: effective pre-commit hook is missing/non-executable — run 'devkit doctor --fix'." >&2
  exit 1
}
OVERLAY=0
if grep -Eq '"overlay"[[:space:]]*:[[:space:]]*true' "$ROOT/.devkit/config.json" 2>/dev/null; then
  OVERLAY=1
  [ -x "$ROOT/.devkit/hooks/pre-commit" ] && grep -q 'devkit-gates: chain start' "$ROOT/.devkit/hooks/pre-commit" || {
    echo "devkit review: overlay gate hook is missing or stale — run 'devkit doctor --fix'." >&2
    exit 1
  }
else
  grep -q 'devkit-guards' "$ROOT/.husky/pre-commit" 2>/dev/null || {
    echo "devkit review: devkit pre-commit block is missing or stale — run 'devkit doctor --fix'." >&2
    exit 1
  }
  HOOKS_PATH=$(git -C "$ROOT" config --get core.hooksPath 2>/dev/null || true)
  [ "$HOOKS_PATH" = .husky/_ ] || {
    echo "devkit review: core.hooksPath does not select the installed Husky runner — run 'devkit doctor --fix'." >&2
    exit 1
  }
fi

[ -z "$(git -C "$ROOT" ls-files -u)" ] || {
  echo "devkit review: target has unmerged paths — resolve them before review." >&2
  exit 1
}
TARGET_HEAD=$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null) || {
  echo "devkit review: target has no commit yet; a merge base is required." >&2
  exit 1
}

if [ -z "$BASE_REF" ]; then
  if git -C "$ROOT" rev-parse --verify 'origin/HEAD^{commit}' >/dev/null 2>&1; then BASE_REF=origin/HEAD
  elif git -C "$ROOT" rev-parse --verify 'refs/heads/main^{commit}' >/dev/null 2>&1; then BASE_REF=main
  elif git -C "$ROOT" rev-parse --verify 'refs/heads/master^{commit}' >/dev/null 2>&1; then BASE_REF=master
  else
    echo "devkit review: could not infer a base (tried origin/HEAD, main, master); pass --base <ref>." >&2
    exit 1
  fi
fi
BASE_COMMIT=$(git -C "$ROOT" rev-parse --verify "${BASE_REF}^{commit}" 2>/dev/null) || {
  echo "devkit review: could not resolve base '$BASE_REF' locally (review never fetches)." >&2
  exit 1
}
MERGE_BASE=$(git -C "$ROOT" merge-base "$BASE_COMMIT" "$TARGET_HEAD" 2>/dev/null) || {
  echo "devkit review: '$BASE_REF' and target HEAD have no merge base." >&2
  exit 1
}

# Nested dirty submodule content cannot be represented by the superproject tree. A changed gitlink
# is captured normally; only uncommitted contents below the gitlink are intentionally excluded.
DIRTY_SUBMODULES=$(git -C "$ROOT" submodule foreach --quiet --recursive \
  'test -z "$(git status --porcelain)" || printf "%s\n" "$displaypath"' 2>/dev/null || true)
[ -z "$DIRTY_SUBMODULES" ] || {
  echo "⚠️  devkit review: dirty nested submodule contents are excluded:" >&2
  printf '%s\n' "$DIRTY_SUBMODULES" | sed 's/^/   - /' >&2
}

# Capture the exact final target state in an ALTERNATE index. This leaves the real index untouched,
# handles every Git pathname/mode/blob shape, includes non-ignored untracked files, and excludes
# ignored caches/secrets exactly like a real `git add -A`.
ALT_INDEX=
snapshot_tree() {
  ALT_INDEX=$(mktemp "${TMPDIR:-/tmp}/devkit-review-index.XXXXXX")
  rm -f "$ALT_INDEX" # a nonexistent GIT_INDEX_FILE means "new index"; an empty file is invalid
  GIT_INDEX_FILE="$ALT_INDEX" git -C "$ROOT" read-tree "$TARGET_HEAD" || {
    rm -f "$ALT_INDEX"; ALT_INDEX=; return 1
  }
  # review-runs is a generated cache. Add a temporary standard-ignore source so an older consumer
  # remains correct before doctor adds the repository ignore. A materializer may project `.devkit`
  # itself as a symlink; ignore that leaf wholesale because Git cannot traverse a child pathspec
  # beneath it. Pathspec-free `add -A` then captures every other tracked/untracked repository path.
  local capture_excludes
  capture_excludes=$(mktemp "${TMPDIR:-/tmp}/devkit-review-excludes.XXXXXX")
  # `.husky/_` may be a projected symlink leaf (not a directory) in a materialized PR worktree, so
  # exclude the path itself. The pattern also excludes descendants when it is an ordinary directory.
  printf '.devkit/review-runs/\n.husky/_\n' > "$capture_excludes"
  [ -L "$ROOT/.devkit" ] && printf '.devkit\n' >> "$capture_excludes"
  # A PR materializer may project current local-only gate inputs as symlinks into an old worktree.
  # They govern the review runtime and are linked AFTER staging; they are not PR content.
  local projected
  for projected in guard.config.json .co-occurrence-allowlist.json .fallowrc.jsonc .fallowrc.json fallow.toml .fallow.toml .fallow fallow-baselines .decisions eslint/baselines eslint.config.devkit.mjs biome.devkit.jsonc; do
    [ -L "$ROOT/$projected" ] && printf '/%s\n' "$projected" >> "$capture_excludes"
  done
  GIT_INDEX_FILE="$ALT_INDEX" git -C "$ROOT" -c core.excludesFile="$capture_excludes" add -A || {
    rm -f "$ALT_INDEX" "$capture_excludes"; ALT_INDEX=; return 1
  }
  rm -f "$capture_excludes"
  GIT_INDEX_FILE="$ALT_INDEX" git -C "$ROOT" write-tree || {
    rm -f "$ALT_INDEX"; ALT_INDEX=; return 1
  }
  rm -f "$ALT_INDEX"
  ALT_INDEX=
}

SNAPSHOT_TREE=$(snapshot_tree)
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$TARGET_HEAD" ] || {
  echo "devkit review: target HEAD changed during snapshot capture; retry." >&2
  exit 1
}

BRANCH=$(git -C "$ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
[ -n "$BRANCH" ] || BRANCH="detached-$(git -C "$ROOT" rev-parse --short HEAD)"
TOKEN=$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9._-' '-')
RUN_ID="${TOKEN}-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
WT="${TMPDIR:-/tmp}/devkit-review-run-${RUN_ID}"
BASE_WT="${TMPDIR:-/tmp}/devkit-review-base-${RUN_ID}"
LOG="$ROOT/.devkit/review-runs/${RUN_ID}.log"
PROGRESS="$ROOT/.devkit/review-runs/${RUN_ID}.progress.json"
ASSET_RUNTIME="/tmp/devkit-review-assets-${RUN_ID}"
BASELINE_RUNTIME="${TMPDIR:-/tmp}/devkit-review-baselines-${RUN_ID}"

cleanup() {
  [ -n "${ALT_INDEX:-}" ] && rm -f "$ALT_INDEX"
  [ -n "${PROGRESS:-}" ] && rm -f "$PROGRESS"
  [ -n "${ASSET_RUNTIME:-}" ] && rm -rf "$ASSET_RUNTIME"
  [ -n "${BASELINE_RUNTIME:-}" ] && rm -rf "$BASELINE_RUNTIME"
  git -C "$ROOT" worktree remove --force "$BASE_WT" 2>/dev/null || true
  git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# HEAD MUST remain merge-base: every unchanged gate compares the synthetic index to HEAD. Materialize
# the captured target tree into index + working tree without moving HEAD.
git -C "$ROOT" worktree add -q --detach "$WT" "$MERGE_BASE" >&2
git -C "$WT" read-tree --reset -u "$SNAPSHOT_TREE"

# Re-capture after materialization. Different HEAD/tree means target input changed mid-flight; abort
# rather than review a torn mixture. Once this matches, the review worktree is an immutable snapshot.
VERIFY_TREE=$(snapshot_tree)
if [ "$(git -C "$ROOT" rev-parse HEAD)" != "$TARGET_HEAD" ] || [ "$VERIFY_TREE" != "$SNAPSHOT_TREE" ]; then
  echo "devkit review: target changed during snapshot capture; retry." >&2
  exit 1
fi
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

if git -C "$WT" diff --cached --quiet; then
  CLEAN_MESSAGE="✓ devkit review: nothing to review against $BASE_REF ($MERGE_BASE). full output: $LOG"
  echo "$CLEAN_MESSAGE" | tee -a "$LOG" >&2
  exit 0
fi
BEFORE_HOOK_TREE=$(git -C "$WT" write-tree)

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_DIR/prepare-gate-worktree.sh"
prepare_gate_worktree "$WT" "$ROOT" review
. "$SCRIPT_DIR/link-gate-configs.sh"
link_untracked_gate_configs "$WT" "$ROOT"
. "$SCRIPT_DIR/run-gates-with-capture.sh"

# Reviewer governance comes from the CURRENT Devkit package, never from the PR snapshot being
# reviewed. A short isolated path keeps Claude's allowedTools grammar safe when the package itself
# lives under a path containing spaces. Only these two Devkit-owned asset trees are projected.
PACKAGE_ROOT=${DEVKIT_REVIEW_PACKAGE_ROOT:-}
[ -n "$PACKAGE_ROOT" ] && [ -d "$PACKAGE_ROOT/agents" ] && [ -d "$PACKAGE_ROOT/skills" ] || {
  echo "devkit review: packaged reviewer assets are missing — reinstall/rebuild Devkit." >&2
  exit 1
}
[ ! -e "$ASSET_RUNTIME" ] && [ ! -L "$ASSET_RUNTIME" ] || {
  echo "devkit review: isolated reviewer runtime already exists: $ASSET_RUNTIME" >&2
  exit 1
}
mkdir "$ASSET_RUNTIME"
ln -s "$PACKAGE_ROOT/agents" "$ASSET_RUNTIME/agents"
ln -s "$PACKAGE_ROOT/skills" "$ASSET_RUNTIME/skills"
export DEVKIT_REVIEW_ASSET_ROOT="$ASSET_RUNTIME"

# ESLint/Fallow review gates compare the final staged snapshot with this separate immutable
# merge-base checkout. Both worktrees receive the same local-only runtime projections, but neither
# generated baseline is persisted or copied back to the target.
BASELINE_GATE="$PACKAGE_ROOT/gate-engine/review/baseline-gate.mjs"
[ -f "$BASELINE_GATE" ] || BASELINE_GATE="$PACKAGE_ROOT/gate-engine/review/baseline-gate.mts"
[ -f "$BASELINE_GATE" ] || {
  echo "devkit review: merge-base baseline helper is missing — reinstall/rebuild Devkit." >&2
  exit 1
}
git -C "$ROOT" worktree add -q --detach "$BASE_WT" "$MERGE_BASE" >&2
prepare_gate_worktree "$BASE_WT" "$ROOT" review-baseline
link_untracked_gate_configs "$BASE_WT" "$ROOT"
node "$BASELINE_GATE" capture "$BASE_WT" "$WT" "$BASELINE_RUNTIME"
export DEVKIT_REVIEW_BASELINE_DIR="$BASELINE_RUNTIME"

export DEVKIT_REVIEW_ID="review-${RUN_ID}"
export DEVKIT_REVIEW_REPO="$(basename "$ROOT")"
export DEVKIT_REVIEW_BRANCH="$BRANCH"

HOOK_CMD=(git -C "$WT")
if [ "$OVERLAY" -eq 1 ]; then HOOK_CMD+=(-c core.hooksPath=.devkit/hooks); fi
HOOK_CMD+=(hook run pre-commit)

RC=0
run_gates_with_capture "$WT" "$ROOT" "devkit review" "$LOG" "$PROGRESS" -- "${HOOK_CMD[@]}" || RC=$?
rm -f "$PROGRESS"
if [ "$RC" -ne 0 ]; then
  echo "✗ devkit review: gate chain blocked (exit $RC) — full output: $LOG" >&2
  exit "$RC"
fi

AFTER_HOOK_TREE=$(git -C "$WT" write-tree)
if [ "$AFTER_HOOK_TREE" != "$BEFORE_HOOK_TREE" ] || ! git -C "$WT" diff --quiet; then
  echo "✗ devkit review: the pre-commit hook changed the ephemeral staged snapshot." >&2
  echo "   Format/update the target and re-run; target files were NOT modified. Full output: $LOG" >&2
  exit 1
fi

echo "✓ devkit review: pre-commit gates passed — full output: $LOG" >&2
