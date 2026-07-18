#!/usr/bin/env bash
# Capture a target checkout's final filesystem state as a Git tree without touching its real index.
# Sourced by the future review runner and directly by hermetic tests; this file has no side effects
# until one of its public functions is called.

SNAPSHOT_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$SNAPSHOT_LIB_DIR/../link-gate-configs.sh"

_review_snapshot_clear_git_env() {
  local name
  for name in \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT \
    GIT_OBJECT_DIRECTORY GIT_DIR GIT_WORK_TREE GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE \
    GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_PREFIX GIT_SHALLOW_FILE \
    GIT_COMMON_DIR GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_LITERAL_PATHSPECS \
    GIT_ICASE_PATHSPECS
  do
    unset "$name"
  done
}

_review_snapshot_path_is_within() {
  local path=$1 parent=$2 parent_prefix=${2%/}
  [ "$path" = "$parent" ] && return 0
  case "$path" in
    "$parent_prefix"/*) return 0 ;;
  esac
  return 1
}

_review_snapshot_physical_path() (
  cd -P "$1" 2>/dev/null || exit 1
  printf '%s\0' "$PWD"
)

_review_snapshot_git_index_path() (
  local emitted
  IFS= read -r -d '' emitted < <(
    git -C "$1" rev-parse --path-format=absolute --git-path index && printf '\0'
  ) || exit 1
  case "$emitted" in
    *$'\n') emitted=${emitted%$'\n'} ;;
    *) exit 1 ;;
  esac
  printf '%s\0' "$emitted"
)

_review_snapshot_temp_base() {
  local root=$1 candidate resolved
  for candidate in "${TMPDIR:-}" /tmp /var/tmp; do
    [ -n "$candidate" ] && [ -d "$candidate" ] && [ -w "$candidate" ] || continue
    IFS= read -r -d '' resolved < <(_review_snapshot_physical_path "$candidate") || continue
    _review_snapshot_path_is_within "$resolved" "$root" && continue
    printf '%s\0' "$resolved"
    return 0
  done
  echo "devkit review: no writable temporary directory exists outside the target checkout." >&2
  return 1
}

_review_snapshot_write_excludes() {
  local root=$1 destination=$2 configured='' config_status
  if git -C "$root" config --null --path --get core.excludesFile > "$destination" 2>/dev/null; then
    IFS= read -r -d '' configured < "$destination" || return 1
  else
    config_status=$?
    [ "$config_status" -eq 1 ] || return "$config_status"
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then
      configured="$XDG_CONFIG_HOME/git/ignore"
    elif [ -n "${HOME:-}" ]; then
      configured="$HOME/.config/git/ignore"
    fi
  fi
  case "$configured" in
    '' | /*) ;;
    *) configured="$root/$configured" ;;
  esac
  : > "$destination"
  if [ -n "$configured" ] && [ -f "$configured" ]; then
    cat "$configured" >> "$destination"
    printf '\n' >> "$destination"
  fi
  printf '.devkit/review-runs/\n.husky/_\n' >> "$destination"
  [ -L "$root/.husky" ] && printf '/.husky\n' >> "$destination"
  [ -L "$root/.devkit" ] && printf '/.devkit\n' >> "$destination"
  return 0
}

_review_snapshot_reset_projections() {
  local root=$1 target_head=$2 alternate_index=$3 candidate_manifest=$4 candidate
  local reset_paths=()
  if [ -L "$root/.husky" ]; then reset_paths+=(.husky); else reset_paths+=(.husky/_); fi
  if [ -L "$root/.devkit" ]; then reset_paths+=(.devkit); else reset_paths+=(.devkit/review-runs); fi

  while IFS= read -r -d '' candidate; do
    [ -L "$root/$candidate" ] && reset_paths+=("$candidate")
  done < "$candidate_manifest"

  GIT_INDEX_FILE="$alternate_index" GIT_LITERAL_PATHSPECS=1 \
    git -C "$root" reset -q "$target_head" -- "${reset_paths[@]}"
}

# review_snapshot_capture_tree <root> <target-head>
# Prints exactly one tree OID. The subshell owns all temporary state and cannot overwrite caller traps.
# A caller that materializes this tree must call review_snapshot_tree_matches afterwards: no filesystem
# snapshot can make a later target mutation atomic with work performed in another checkout.
review_snapshot_capture_tree() (
  local requested_root=$1 target_head=$2 root temp_base alternate_index='' capture_excludes=''
  local candidate='' candidate_manifest='' real_index index_hash_before index_hash_after copied_hash
  local staged_index_tree pass current_tree current_excludes current_candidates
  local first_tree='' first_excludes='' first_candidates='' tree
  _review_snapshot_clear_git_env
  IFS= read -r -d '' root < <(_review_snapshot_physical_path "$requested_root") || exit 1

  cleanup_review_snapshot() {
    if [ -n "$alternate_index" ]; then rm -f "$alternate_index" "$alternate_index.lock" || true; fi
    if [ -n "$capture_excludes" ]; then rm -f "$capture_excludes" || true; fi
    if [ -n "$candidate_manifest" ]; then rm -f "$candidate_manifest" || true; fi
    return 0
  }
  fail_review_snapshot() {
    local status=${1:-1}
    trap - HUP INT TERM EXIT
    cleanup_review_snapshot
    exit "$status"
  }
  trap cleanup_review_snapshot EXIT
  trap 'fail_review_snapshot 129' HUP
  trap 'fail_review_snapshot 130' INT
  trap 'fail_review_snapshot 143' TERM

  [ "$(git -C "$root" rev-parse HEAD 2>/dev/null)" = "$target_head" ] || fail_review_snapshot
  if [ "$(git -C "$root" config --bool core.sparseCheckout 2>/dev/null || true)" = true ]; then
    echo "devkit review: sparse checkouts are not supported; materialize the full target first." >&2
    fail_review_snapshot
  fi

  IFS= read -r -d '' temp_base < <(_review_snapshot_temp_base "$root") || fail_review_snapshot
  alternate_index=$(mktemp "$temp_base/devkit-review-index.XXXXXX") || fail_review_snapshot
  rm -f "$alternate_index"
  capture_excludes=$(mktemp "$temp_base/devkit-review-excludes.XXXXXX") || fail_review_snapshot
  candidate_manifest=$(mktemp "$temp_base/devkit-review-candidates.XXXXXX") || fail_review_snapshot

  IFS= read -r -d '' real_index < <(_review_snapshot_git_index_path "$root") || fail_review_snapshot
  index_hash_before=$(git hash-object --no-filters "$real_index") || fail_review_snapshot
  cp -p "$real_index" "$alternate_index" || fail_review_snapshot
  index_hash_after=$(git hash-object --no-filters "$real_index") || fail_review_snapshot
  copied_hash=$(git hash-object --no-filters "$alternate_index") || fail_review_snapshot
  if [ "$index_hash_before" != "$index_hash_after" ] || [ "$index_hash_before" != "$copied_hash" ]; then
    echo "devkit review: target index changed during snapshot capture; retry." >&2
    fail_review_snapshot
  fi

  if ! git -C "$root" ls-files -v -z > "$candidate_manifest"; then
    fail_review_snapshot
  fi
  while IFS= read -r -d '' candidate; do
    case "$candidate" in
      S\ * | s\ *)
        echo "devkit review: sparse or skip-worktree checkouts are not supported; materialize the full target first." >&2
        fail_review_snapshot
        ;;
    esac
  done < "$candidate_manifest"
  if ! staged_index_tree=$(GIT_INDEX_FILE="$alternate_index" git -C "$root" write-tree); then
    echo "devkit review: could not capture the target index; resolve unmerged entries first." >&2
    fail_review_snapshot
  fi

  for pass in 1 2; do
    # Rebuild from the staged tree for every pass. Besides making the captures independent, this
    # clears copied stat-cache, fsmonitor, and assume-unchanged state so Git must inspect final bytes.
    rm -f "$alternate_index" "$alternate_index.lock" || fail_review_snapshot
    GIT_INDEX_FILE="$alternate_index" git -C "$root" read-tree "$staged_index_tree" || fail_review_snapshot
    _review_snapshot_write_excludes "$root" "$capture_excludes" || fail_review_snapshot
    emit_gate_projection_candidates "$root" > "$candidate_manifest" || fail_review_snapshot
    current_excludes=$(git hash-object --no-filters "$capture_excludes") || fail_review_snapshot
    current_candidates=$(git hash-object --no-filters "$candidate_manifest") || fail_review_snapshot
    GIT_INDEX_FILE="$alternate_index" \
      git -C "$root" -c core.excludesFile="$capture_excludes" add -A || fail_review_snapshot
    _review_snapshot_reset_projections \
      "$root" "$target_head" "$alternate_index" "$candidate_manifest" || fail_review_snapshot
    current_tree=$(GIT_INDEX_FILE="$alternate_index" git -C "$root" write-tree) || fail_review_snapshot

    if [ "$pass" -eq 1 ]; then
      first_tree=$current_tree
      first_excludes=$current_excludes
      first_candidates=$current_candidates
    elif [ "$first_tree" != "$current_tree" ] || \
      [ "$first_excludes" != "$current_excludes" ] || \
      [ "$first_candidates" != "$current_candidates" ]; then
      echo "devkit review: target files or review inputs changed during snapshot capture; retry." >&2
      fail_review_snapshot
    fi
  done
  tree=$first_tree
  [ "$(git -C "$root" rev-parse HEAD 2>/dev/null)" = "$target_head" ] || fail_review_snapshot
  index_hash_after=$(git hash-object --no-filters "$real_index") || fail_review_snapshot
  if [ "$index_hash_before" != "$index_hash_after" ]; then
    echo "devkit review: target index changed during snapshot capture; retry." >&2
    fail_review_snapshot
  fi
  cleanup_review_snapshot
  trap - HUP INT TERM EXIT
  printf '%s\n' "$tree"
)

# review_snapshot_tree_matches <root> <target-head> <expected-tree>
review_snapshot_tree_matches() {
  local root=$1 target_head=$2 expected_tree=$3 current_tree
  current_tree=$(review_snapshot_capture_tree "$root" "$target_head") || return 1
  [ "$current_tree" = "$expected_tree" ]
}
