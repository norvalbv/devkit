#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ZERO_OID=0000000000000000000000000000000000000000
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
    continue
  fi
  [ "$local_oid" = "$ZERO_OID" ] && continue
  tag_commit=$(git -C "$ROOT" rev-parse --verify "${local_oid}^{commit}")
  append_tag_commit "$tag_commit"
done < "$UPDATES_FILE"

# Branch and mixed pushes retain the existing contract: validate the caller's exact worktree.
if [ "$HAS_UPDATES" -eq 0 ] || [ "$HAS_NON_TAG_UPDATE" -eq 1 ]; then
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
