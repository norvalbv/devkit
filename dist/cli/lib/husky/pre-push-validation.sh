#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ZERO_OID=0000000000000000000000000000000000000000
# sc-1508: the exact commit sha a `devkit ship` is pushing (set command-scoped by ship-branch.sh /
# reship.sh). Only a 40/64-hex non-zero oid is honoured; anything else — including a plain `git push`
# where the env is unset — is treated as absent, so the branch path falls through to the full suite.
SHIP_SKIP_SHA="${DEVKIT_SHIP_PREPUSH_SKIP_SHA:-}"
if ! { [[ "$SHIP_SKIP_SHA" =~ ^[0-9a-f]{40}$ ]] || [[ "$SHIP_SKIP_SHA" =~ ^[0-9a-f]{64}$ ]]; }; then
  SHIP_SKIP_SHA=
fi
NON_TAG_UPDATE_COUNT=0
NON_TAG_MATCH_COUNT=0
UPDATES_FILE=$(mktemp "${TMPDIR:-/tmp}/devkit-pre-push-updates.XXXXXX")
TAG_TEMP_ROOT=
TAG_WORKTREE=
TAG_COMMITS=()
HAS_UPDATES=0
HAS_NON_TAG_UPDATE=0

. "$SCRIPT_DIR/../ship/prepare-gate-worktree.sh"

cleanup_tag_worktree() {
  if [ -n "$TAG_WORKTREE" ]; then
    git -C "$ROOT" worktree remove --force "$TAG_WORKTREE" >/dev/null 2>&1 || true
  fi
  if [ -n "$TAG_TEMP_ROOT" ]; then
    rm -rf -- "$TAG_TEMP_ROOT"
  fi
  TAG_WORKTREE=
  TAG_TEMP_ROOT=
}

cleanup() {
  cleanup_tag_worktree
  rm -f -- "$UPDATES_FILE"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

run_checks() {
  local worktree=$1
  (
    cd "$worktree"
    bun run typecheck
    bun run test:run
  )
}

append_tag_commit() {
  local candidate=$1 existing
  if [ "${#TAG_COMMITS[@]}" -gt 0 ]; then
    for existing in "${TAG_COMMITS[@]}"; do
      [ "$existing" = "$candidate" ] && return 0
    done
  fi
  TAG_COMMITS+=("$candidate")
}

cat > "$UPDATES_FILE"
while read -r local_ref local_oid remote_ref remote_oid; do
  [ -n "${remote_ref:-}" ] || continue
  HAS_UPDATES=1
  if [[ "$remote_ref" != refs/tags/* ]]; then
    HAS_NON_TAG_UPDATE=1
    NON_TAG_UPDATE_COUNT=$((NON_TAG_UPDATE_COUNT + 1))
    if [ -n "$SHIP_SKIP_SHA" ] && [ "$local_oid" = "$SHIP_SKIP_SHA" ]; then
      NON_TAG_MATCH_COUNT=$((NON_TAG_MATCH_COUNT + 1))
    fi
    continue
  fi
  [ "$local_oid" = "$ZERO_OID" ] && continue
  tag_commit=$(git -C "$ROOT" rev-parse --verify "${local_oid}^{commit}")
  append_tag_commit "$tag_commit"
done < "$UPDATES_FILE"

# Branch and mixed pushes retain the existing contract: validate the caller's exact worktree.
if [ "$HAS_UPDATES" -eq 0 ] || [ "$HAS_NON_TAG_UPDATE" -eq 1 ]; then
  # sc-1508: skip the heavy suite ONLY for a devkit ship of the exact commit(s) it just built — every
  # non-tag ref being pushed must be the ship sha, and there must be at least one. Anything else fails
  # closed to the full suite: a plain `git push` (SHIP_SKIP_SHA unset), a branch DELETION (local_oid is
  # ZERO_OID, never the sha), or a piggybacked second branch (count > matches). The skip is content-keyed,
  # not "a ship is running", and CI's .github/workflows/gate.yml re-runs typecheck + test:run on the PR —
  # so the check is not dropped, only moved server-side. A skipped run is announced (never silent).
  if [ -n "$SHIP_SKIP_SHA" ] && [ "$NON_TAG_UPDATE_COUNT" -gt 0 ] \
     && [ "$NON_TAG_MATCH_COUNT" -eq "$NON_TAG_UPDATE_COUNT" ]; then
    echo "devkit pre-push: $SHIP_SKIP_SHA is a devkit ship — typecheck + test:run are gated by CI" >&2
    echo "  (.github/workflows/gate.yml) on the PR; skipping the local pre-push suite." >&2
    echo "  A plain git push still runs the full suite." >&2
    exit 0
  fi
  run_checks "$ROOT"
  exit 0
fi

# A tag deletion has no source tree to validate.
[ "${#TAG_COMMITS[@]}" -gt 0 ] || exit 0

for tag_commit in "${TAG_COMMITS[@]}"; do
  TAG_TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/devkit-pre-push-tag.XXXXXX")
  TAG_WORKTREE="$TAG_TEMP_ROOT/worktree"
  echo "devkit pre-push: validating tagged commit $tag_commit in an isolated worktree" >&2
  git -C "$ROOT" worktree add -q --detach "$TAG_WORKTREE" "$tag_commit"
  prepare_gate_worktree "$TAG_WORKTREE" "$ROOT" "tag validation"
  run_checks "$TAG_WORKTREE"
  cleanup_tag_worktree
done
