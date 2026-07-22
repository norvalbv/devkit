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

_review_snapshot_git_root() (
  local emitted physical
  IFS= read -r -d '' emitted < <(
    git -C "$1" rev-parse --path-format=absolute --show-toplevel && printf '\0'
  ) || exit 1
  case "$emitted" in
    *$'\n') emitted=${emitted%$'\n'} ;;
    *) exit 1 ;;
  esac
  IFS= read -r -d '' physical < <(_review_snapshot_physical_path "$emitted") || exit 1
  printf '%s\0' "$physical"
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
  echo "devkit review: no writable temporary directory exists outside the repository checkout." >&2
  return 1
}

_review_snapshot_write_excludes() {
  local target_root=$1 destination=$2 configured='' config_status
  if git -C "$target_root" config --null --path --get core.excludesFile > "$destination" 2>/dev/null; then
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
    *) configured="$target_root/$configured" ;;
  esac
  : > "$destination"
  if [ -n "$configured" ] && [ -f "$configured" ]; then
    cat "$configured" >> "$destination"
    printf '\n' >> "$destination"
  fi
  return 0
}

_review_snapshot_write_projection_paths() {
  local git_root=$1 target_root=$2 target_relative=$3 candidate_manifest=$4 destination=$5
  local candidate scoped
  : > "$destination" || return 1
  if [ -L "$git_root/.husky" ]; then
    printf '%s\0' .husky >> "$destination" || return 1
  else
    printf '%s\0' .husky/_ >> "$destination" || return 1
  fi
  if [ -L "$target_root/.devkit" ]; then
    scoped=.devkit
  else
    scoped=.devkit/review-runs
  fi
  [ -z "$target_relative" ] || scoped="$target_relative/$scoped"
  printf '%s\0' "$scoped" >> "$destination" || return 1

  while IFS= read -r -d '' candidate; do
    [ -L "$target_root/$candidate" ] || continue
    scoped=$candidate
    [ -z "$target_relative" ] || scoped="$target_relative/$scoped"
    printf '%s\0' "$scoped" >> "$destination" || return 1
  done < "$candidate_manifest"
}

_review_snapshot_entry_type() {
  local path=$1
  [ -L "$path" ] && { printf 'symlink\n'; return 0; }
  [ -f "$path" ] && { printf 'file\n'; return 0; }
  [ -d "$path" ] && { printf 'directory\n'; return 0; }
  [ ! -e "$path" ] && { printf 'missing\n'; return 0; }
  return 1
}

_review_snapshot_entry_mode() {
  local path=$1 type=$2 permissions
  [ "$type" = symlink ] && { printf '120000\n'; return 0; }
  permissions=$(stat -f '%Lp' -- "$path" 2>/dev/null) || \
    permissions=$(stat -c '%a' -- "$path" 2>/dev/null) || return 1
  case "$permissions" in
    '' | *[!0-7]*) return 1 ;;
  esac
  if (( (8#$permissions & 0111) != 0 )); then
    printf '100755\n'
  else
    printf '100644\n'
  fi
}

_review_snapshot_readlink() {
  local value
  IFS= read -r -d '' value < <(readlink -n "$1" && printf '\0') || return 1
  printf '%s\0' "$value"
}

_review_snapshot_hash_entry() {
  local git_root=$1 path=$2 type=$3 target oid
  if [ "$type" = symlink ]; then
    IFS= read -r -d '' target < <(_review_snapshot_readlink "$git_root/$path") || return 1
    oid=$(printf '%s' "$target" | \
      git -C "$git_root" hash-object -w --no-filters --stdin) || return 1
  else
    oid=$(git -C "$git_root" hash-object -w --no-filters -- "$path") || return 1
  fi
  case "$oid" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  printf '%s\n' "$oid"
}

_review_snapshot_write_candidate_records() {
  local git_root=$1 alternate_index=$2 excludes=$3 destination=$4 path
  local pipeline_status=()
  GIT_INDEX_FILE="$alternate_index" \
    git -C "$git_root" ls-files --stage -z > "$destination" || return 1
  GIT_INDEX_FILE="$alternate_index" \
    git -C "$git_root" -c core.excludesFile="$excludes" \
    ls-files --others --exclude-standard -z |
    while IFS= read -r -d '' path; do
      printf '?\t%s\0' "$path"
    done >> "$destination"
  pipeline_status=("${PIPESTATUS[@]}")
  [ "${pipeline_status[0]}" -eq 0 ] && [ "${pipeline_status[1]}" -eq 0 ]
}

_review_snapshot_stage_raw_files() {
  local git_root=$1 target_head=$2 alternate_index=$3 projection_manifest=$4 excludes=$5
  local candidate_manifest=$6 entry_manifest=$7 record metadata path indexed_mode indexed_oid
  local full type_before type_after mode_before mode_after oid
  local entry_index file_offset hash_index file_count
  local reset_paths=()
  local entry_paths=() entry_types=() entry_modes=() entry_oids=()
  local file_paths=() file_indexes=()
  while IFS= read -r -d '' path; do
    reset_paths+=("$path")
  done < "$projection_manifest"

  _review_snapshot_write_candidate_records \
    "$git_root" "$alternate_index" "$excludes" "$candidate_manifest" || return 1
  : > "$entry_manifest" || return 1
  while IFS= read -r -d '' record; do
    case "$record" in
      *$'\t'*) ;;
      *) return 1 ;;
    esac
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    [ -n "$path" ] || return 1
    indexed_mode=
    indexed_oid=
    if [ "$metadata" != '?' ]; then
      indexed_mode=${metadata%% *}
      metadata=${metadata#* }
      indexed_oid=${metadata%% *}
      [ "${metadata#* }" = 0 ] || return 1
    fi
    full=$git_root/$path
    type_before=$(_review_snapshot_entry_type "$full") || {
      printf 'devkit review: unsupported filesystem entry: %q\n' "$path" >&2
      return 1
    }
    case "$type_before" in
      missing) continue ;;
      directory)
        if [ "$indexed_mode" = 160000 ]; then
          printf '160000 %s\t%s\0' "$indexed_oid" "$path" >> "$entry_manifest" || return 1
        fi
        continue
        ;;
      file | symlink) ;;
      *) return 1 ;;
    esac
    mode_before=$(_review_snapshot_entry_mode "$full" "$type_before") || return 1
    entry_index=${#entry_paths[@]}
    entry_paths[$entry_index]=$path
    entry_types[$entry_index]=$type_before
    entry_modes[$entry_index]=$mode_before
    if [ "$type_before" = file ]; then
      file_paths[${#file_paths[@]}]=$path
      file_indexes[${#file_indexes[@]}]=$entry_index
    else
      entry_oids[$entry_index]=$(
        _review_snapshot_hash_entry "$git_root" "$path" "$type_before"
      ) || return 1
    fi
  done < "$candidate_manifest"

  # `hash-object` accepts literal path arguments, so bounded batches preserve newline-bearing paths
  # without paying one Git process per ordinary file. Symlinks use stdin above because Git follows
  # them when hashing a named path.
  : > "$candidate_manifest" || return 1
  file_count=${#file_paths[@]}
  file_offset=0
  while [ "$file_offset" -lt "$file_count" ]; do
    git -C "$git_root" hash-object -w --no-filters -- \
      "${file_paths[@]:$file_offset:256}" >> "$candidate_manifest" || return 1
    file_offset=$((file_offset + 256))
  done
  hash_index=0
  while IFS= read -r oid; do
    case "$oid" in
      '' | *[!0-9a-f]*) return 1 ;;
    esac
    [ "$hash_index" -lt "$file_count" ] || return 1
    entry_oids[${file_indexes[$hash_index]}]=$oid
    hash_index=$((hash_index + 1))
  done < "$candidate_manifest"
  [ "$hash_index" -eq "$file_count" ] || return 1

  entry_index=0
  while [ "$entry_index" -lt "${#entry_paths[@]}" ]; do
    path=${entry_paths[$entry_index]}
    type_before=${entry_types[$entry_index]}
    mode_before=${entry_modes[$entry_index]}
    oid=${entry_oids[$entry_index]}
    full=$git_root/$path
    type_after=$(_review_snapshot_entry_type "$full") || return 1
    mode_after=$(_review_snapshot_entry_mode "$full" "$type_after") || return 1
    if [ "$type_before" != "$type_after" ] || [ "$mode_before" != "$mode_after" ]; then
      printf 'devkit review: filesystem entry changed during snapshot capture: %q\n' "$path" >&2
      return 1
    fi
    printf '%s %s\t%s\0' "$mode_before" "$oid" "$path" >> "$entry_manifest" || return 1
    entry_index=$((entry_index + 1))
  done

  GIT_INDEX_FILE="$alternate_index" git -C "$git_root" read-tree --empty || return 1
  GIT_INDEX_FILE="$alternate_index" \
    git -C "$git_root" update-index -z --index-info < "$entry_manifest" || return 1
  GIT_INDEX_FILE="$alternate_index" GIT_LITERAL_PATHSPECS=1 \
    git -C "$git_root" reset -q "$target_head" -- "${reset_paths[@]}"
}

_review_snapshot_stage_canonical_files() {
  local git_root=$1 target_head=$2 alternate_index=$3 projection_manifest=$4 excludes=$5
  local candidate_manifest=$6 gitlink_manifest=$7 record metadata path mode oid stage
  local reset_paths=()
  while IFS= read -r -d '' path; do reset_paths+=("$path"); done < "$projection_manifest"

  # `git add` normally replaces an indexed gitlink with the submodule checkout's current HEAD.
  # Review deliberately excludes unstaged nested-repository state, so preserve the captured index
  # OID while the gitlink still exists as a directory. A removed gitlink or a file/symlink replacing
  # it remains an ordinary local change and is staged below.
  GIT_INDEX_FILE="$alternate_index" \
    git -C "$git_root" ls-files --stage -z > "$candidate_manifest" || return 1
  : > "$gitlink_manifest" || return 1
  while IFS= read -r -d '' record; do
    case "$record" in
      *$'\t'*) ;;
      *) return 1 ;;
    esac
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    mode=${metadata%% *}
    metadata=${metadata#* }
    oid=${metadata%% *}
    stage=${metadata#* }
    [ "$mode $oid $stage" = "${record%%$'\t'*}" ] || return 1
    [ "$mode" = 160000 ] && [ "$stage" = 0 ] || continue
    [ -d "$git_root/$path" ] && [ ! -L "$git_root/$path" ] || continue
    printf '160000 %s\t%s\0' "$oid" "$path" >> "$gitlink_manifest" || return 1
  done < "$candidate_manifest"

  GIT_INDEX_FILE="$alternate_index" git -C "$git_root" \
    -c core.fileMode=true -c core.excludesFile="$excludes" add -A -- . || return 1
  if [ -s "$gitlink_manifest" ]; then
    GIT_INDEX_FILE="$alternate_index" \
      git -C "$git_root" update-index -z --index-info < "$gitlink_manifest" || return 1
  fi
  GIT_INDEX_FILE="$alternate_index" GIT_LITERAL_PATHSPECS=1 \
    git -C "$git_root" reset -q "$target_head" -- "${reset_paths[@]}"
}

# review_snapshot_capture_trees <target-root> <target-head>
# Prints canonical-index and raw-filesystem tree OIDs on one line. The subshell owns temporary state.
# A caller that materializes these trees must call review_snapshot_trees_match afterwards: no
# filesystem snapshot can make a later target mutation atomic with work performed in another checkout.
review_snapshot_capture_trees() (
  local requested_target=$1 target_head=$2 target_root git_root target_relative='' temp_base
  local alternate_index='' capture_excludes='' candidate_manifest='' projection_manifest=''
  local entry_manifest=''
  local candidate='' real_index index_hash_before index_hash_after copied_hash staged_index_tree
  local pass current_staged_tree current_raw_tree current_excludes current_candidates current_projections
  local first_staged_tree='' first_raw_tree='' first_excludes='' first_candidates=''
  local first_projections=''
  _review_snapshot_clear_git_env
  IFS= read -r -d '' target_root < <(_review_snapshot_physical_path "$requested_target") || exit 1
  IFS= read -r -d '' git_root < <(_review_snapshot_git_root "$target_root") || exit 1
  _review_snapshot_path_is_within "$target_root" "$git_root" || exit 1
  [ "$target_root" = "$git_root" ] || target_relative=${target_root#"$git_root"/}

  cleanup_review_snapshot() {
    if [ -n "$alternate_index" ]; then rm -f "$alternate_index" "$alternate_index.lock" || true; fi
    if [ -n "$capture_excludes" ]; then rm -f "$capture_excludes" || true; fi
    if [ -n "$candidate_manifest" ]; then rm -f "$candidate_manifest" || true; fi
    if [ -n "$projection_manifest" ]; then rm -f "$projection_manifest" || true; fi
    if [ -n "$entry_manifest" ]; then rm -f "$entry_manifest" || true; fi
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

  [ "$(git -C "$git_root" rev-parse HEAD 2>/dev/null)" = "$target_head" ] || fail_review_snapshot
  if [ "$(git -C "$git_root" config --bool core.sparseCheckout 2>/dev/null || true)" = true ]; then
    echo "devkit review: sparse checkouts are not supported; materialize the full target first." >&2
    fail_review_snapshot
  fi

  IFS= read -r -d '' temp_base < <(_review_snapshot_temp_base "$git_root") || fail_review_snapshot
  alternate_index=$(mktemp "$temp_base/devkit-review-index.XXXXXX") || fail_review_snapshot
  rm -f "$alternate_index"
  capture_excludes=$(mktemp "$temp_base/devkit-review-excludes.XXXXXX") || fail_review_snapshot
  candidate_manifest=$(mktemp "$temp_base/devkit-review-candidates.XXXXXX") || fail_review_snapshot
  projection_manifest=$(mktemp "$temp_base/devkit-review-projections.XXXXXX") || fail_review_snapshot
  entry_manifest=$(mktemp "$temp_base/devkit-review-entries.XXXXXX") || fail_review_snapshot

  IFS= read -r -d '' real_index < <(_review_snapshot_git_index_path "$git_root") || fail_review_snapshot
  index_hash_before=$(git hash-object --no-filters "$real_index") || fail_review_snapshot
  cp -p "$real_index" "$alternate_index" || fail_review_snapshot
  index_hash_after=$(git hash-object --no-filters "$real_index") || fail_review_snapshot
  copied_hash=$(git hash-object --no-filters "$alternate_index") || fail_review_snapshot
  if [ "$index_hash_before" != "$index_hash_after" ] || [ "$index_hash_before" != "$copied_hash" ]; then
    echo "devkit review: target index changed during snapshot capture; retry." >&2
    fail_review_snapshot
  fi

  if ! git -C "$git_root" ls-files -v -z > "$candidate_manifest"; then
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
  if ! staged_index_tree=$(GIT_INDEX_FILE="$alternate_index" git -C "$git_root" write-tree); then
    echo "devkit review: could not capture the target index; resolve unmerged entries first." >&2
    fail_review_snapshot
  fi

  for pass in 1 2; do
    # Rebuild from the staged tree for every pass. Besides making the captures independent, this
    # clears copied stat-cache, fsmonitor, and assume-unchanged state so Git must inspect final bytes.
    rm -f "$alternate_index" "$alternate_index.lock" || fail_review_snapshot
    GIT_INDEX_FILE="$alternate_index" git -C "$git_root" read-tree "$staged_index_tree" || fail_review_snapshot
    _review_snapshot_write_excludes "$target_root" "$capture_excludes" || fail_review_snapshot
    emit_gate_projection_candidates "$target_root" > "$candidate_manifest" || fail_review_snapshot
    _review_snapshot_write_projection_paths \
      "$git_root" "$target_root" "$target_relative" "$candidate_manifest" \
      "$projection_manifest" || fail_review_snapshot
    current_excludes=$(git hash-object --no-filters "$capture_excludes") || fail_review_snapshot
    current_candidates=$(git hash-object --no-filters "$candidate_manifest") || fail_review_snapshot
    current_projections=$(git hash-object --no-filters "$projection_manifest") || fail_review_snapshot
    if ! _review_snapshot_stage_raw_files \
      "$git_root" "$target_head" "$alternate_index" "$projection_manifest" \
      "$capture_excludes" "$candidate_manifest" "$entry_manifest"; then
      fail_review_snapshot
    fi
    current_raw_tree=$(GIT_INDEX_FILE="$alternate_index" git -C "$git_root" write-tree) || fail_review_snapshot
    rm -f "$alternate_index" "$alternate_index.lock" || fail_review_snapshot
    GIT_INDEX_FILE="$alternate_index" git -C "$git_root" \
      read-tree "$staged_index_tree" || fail_review_snapshot
    _review_snapshot_stage_canonical_files \
      "$git_root" "$target_head" "$alternate_index" "$projection_manifest" \
      "$capture_excludes" "$candidate_manifest" "$entry_manifest" || fail_review_snapshot
    current_staged_tree=$(GIT_INDEX_FILE="$alternate_index" \
      git -C "$git_root" write-tree) || fail_review_snapshot

    if [ "$pass" -eq 1 ]; then
      first_staged_tree=$current_staged_tree
      first_raw_tree=$current_raw_tree
      first_excludes=$current_excludes
      first_candidates=$current_candidates
      first_projections=$current_projections
    elif [ "$first_staged_tree" != "$current_staged_tree" ] || \
      [ "$first_raw_tree" != "$current_raw_tree" ] || \
      [ "$first_excludes" != "$current_excludes" ] || \
      [ "$first_candidates" != "$current_candidates" ] || \
      [ "$first_projections" != "$current_projections" ]; then
      echo "devkit review: target files or review inputs changed during snapshot capture; retry." >&2
      fail_review_snapshot
    fi
  done
  [ "$(git -C "$git_root" rev-parse HEAD 2>/dev/null)" = "$target_head" ] || fail_review_snapshot
  index_hash_after=$(git hash-object --no-filters "$real_index") || fail_review_snapshot
  if [ "$index_hash_before" != "$index_hash_after" ]; then
    echo "devkit review: target index changed during snapshot capture; retry." >&2
    fail_review_snapshot
  fi
  cleanup_review_snapshot
  trap - HUP INT TERM EXIT
  printf '%s %s\n' "$first_staged_tree" "$first_raw_tree"
)

# Compatibility helper for callers that need only the exact raw filesystem tree.
review_snapshot_capture_tree() {
  local pair staged_tree raw_tree
  pair=$(review_snapshot_capture_trees "$1" "$2") || return $?
  read -r staged_tree raw_tree <<< "$pair"
  [ -n "$staged_tree" ] && [ -n "$raw_tree" ] || return 1
  printf '%s\n' "$raw_tree"
}

review_snapshot_trees_match() {
  local pair staged_tree raw_tree
  pair=$(review_snapshot_capture_trees "$1" "$2") || return $?
  read -r staged_tree raw_tree <<< "$pair"
  [ "$staged_tree" = "$3" ] && [ "$raw_tree" = "$4" ]
}

# review_snapshot_tree_matches <target-root> <target-head> <expected-tree>
review_snapshot_tree_matches() {
  local target_root=$1 target_head=$2 expected_tree=$3 current_tree
  current_tree=$(review_snapshot_capture_tree "$target_root" "$target_head") || return $?
  [ "$current_tree" = "$expected_tree" ]
}
