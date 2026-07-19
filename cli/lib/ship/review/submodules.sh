#!/usr/bin/env bash
# Local-only submodule projection for devkit review. The target checkout supplies initialized
# object stores; every reviewed submodule is a detached temporary worktree at the staged gitlink.

_REVIEW_SUBMODULE_MANIFEST_MAGIC=devkit-review-submodules-v1
_REVIEW_SUBMODULE_MAX_DEPTH=32
_REVIEW_SUBMODULE_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

_review_submodule_clear_git_env() {
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

_review_submodule_git() (
  _review_submodule_clear_git_env
  export GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 HUSKY=0
  git \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    -c protocol.allow=never \
    -c gc.auto=0 \
    "$@"
)

_review_submodule_git_line() {
  local value=''
  IFS= read -r -d '' value < <(_review_submodule_git "$@" && printf '\0') || return 1
  case "$value" in
    *$'\n') value=${value%$'\n'} ;;
    *) return 1 ;;
  esac
  printf '%s\0' "$value"
}

_review_submodule_physical_dir() (
  [ -d "$1" ] && [ ! -L "$1" ] || exit 1
  cd -P -- "$1" 2>/dev/null || exit 1
  printf '%s\0' "$PWD"
)

_review_submodule_path_is_within() {
  local path=$1 parent=${2%/}
  [ "$path" = "$parent" ] && return 0
  case "$path" in
    "$parent"/*) return 0 ;;
  esac
  return 1
}

_review_submodule_safe_relative_path() {
  local path=$1
  case "$path" in
    '' | /*) return 1 ;;
  esac
  case "/$path/" in
    *'/../'* | *'/./'* | *'//'* ) return 1 ;;
  esac
  return 0
}

_review_submodule_valid_oid() {
  local oid=$1
  case "$oid" in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#oid}" -eq 40 ] || [ "${#oid}" -eq 64 ]
}

_review_submodule_make_temp() {
  local base=$1 label=$2 path=''
  IFS= read -r -d '' path < <(
    (umask 077 && mktemp "$base/devkit-review-submodules-$label.XXXXXX") && printf '\0'
  ) || return 1
  case "$path" in
    *$'\n') path=${path%$'\n'} ;;
    *) return 1 ;;
  esac
  printf '%s\0' "$path"
}

_review_submodule_temp() {
  local label=${1:-scratch} base
  case "$label" in
    '' | *[!a-z-]*) return 1 ;;
  esac
  if [ -n "${DEVKIT_REVIEW_TEMP_ROOT:-}" ]; then
    IFS= read -r -d '' base < <(
      _review_submodule_physical_dir "$DEVKIT_REVIEW_TEMP_ROOT"
    ) || {
      echo 'devkit review: DEVKIT_REVIEW_TEMP_ROOT is not a private physical directory.' >&2
      return 1
    }
    [ -w "$base" ] || {
      echo 'devkit review: DEVKIT_REVIEW_TEMP_ROOT is not writable.' >&2
      return 1
    }
    _review_submodule_make_temp "$base" "$label"
    return $?
  fi
  for base in /tmp /var/tmp; do
    [ -d "$base" ] && [ -w "$base" ] || continue
    _review_submodule_make_temp "$base" "$label" && return 0
  done
  echo 'devkit review: no private temporary directory is available for submodule inspection.' >&2
  return 1
}

_review_submodule_split_manifest_path() {
  local requested=$1 parent base
  case "$requested" in
    */*) parent=${requested%/*}; base=${requested##*/}; [ -n "$parent" ] || parent=/ ;;
    *) parent=.; base=$requested ;;
  esac
  [ -n "$base" ] && [ "$base" != . ] && [ "$base" != .. ] || return 1
  IFS= read -r -d '' parent < <(_review_submodule_physical_dir "$parent") || return 1
  if [ "$parent" = / ]; then
    _review_submodule_manifest_path="/$base"
  else
    _review_submodule_manifest_path="$parent/$base"
  fi
}

_review_submodule_parse_entry() {
  local record=$1 metadata
  case "$record" in
    *$'\t'*) ;;
    *) return 1 ;;
  esac
  metadata=${record%%$'\t'*}
  _review_submodule_entry_path=${record#*$'\t'}
  _review_submodule_entry_mode=${metadata%% *}
  metadata=${metadata#* }
  _review_submodule_entry_oid=${metadata%% *}
  _review_submodule_entry_stage=${metadata#* }
  [ "$_review_submodule_entry_mode $_review_submodule_entry_oid $_review_submodule_entry_stage" = \
    "${record%%$'\t'*}" ]
}

_review_submodule_resolve_source() {
  local source=$1 source_parent=$2 oid=$3 physical super common
  _review_submodule_identity_source=
  _review_submodule_identity_common=
  if [ ! -e "$source/.git" ] || [ ! -d "$source" ] || [ -L "$source" ]; then
    printf 'devkit review: source submodule is not initialized: %q\n' "$source" >&2
    return 1
  fi
  IFS= read -r -d '' physical < <(_review_submodule_physical_dir "$source") || return 1
  [ "$physical" = "$source" ] || {
    printf 'devkit review: source submodule path escapes through a symlink: %q\n' "$source" >&2
    return 1
  }
  IFS= read -r -d '' super < <(
    _review_submodule_git_line -C "$physical" rev-parse --show-superproject-working-tree
  ) || return 1
  IFS= read -r -d '' super < <(_review_submodule_physical_dir "$super") || {
    printf 'devkit review: source submodule is not attached to its superproject: %q\n' "$source" >&2
    return 1
  }
  [ "$super" = "$source_parent" ] || {
    printf 'devkit review: source submodule belongs to a different superproject: %q\n' "$source" >&2
    return 1
  }
  IFS= read -r -d '' common < <(
    _review_submodule_git_line -C "$physical" rev-parse --path-format=absolute --git-common-dir
  ) || return 1
  IFS= read -r -d '' common < <(_review_submodule_physical_dir "$common") || return 1
  if ! _review_submodule_git --git-dir="$common" cat-file -e "$oid^{commit}" 2>/dev/null; then
    printf 'devkit review: submodule target OID is not available locally: %s (%q)\n' \
      "$oid" "$source" >&2
    return 1
  fi
  _review_submodule_identity_source=$physical
  _review_submodule_identity_common=$common
}

_review_submodule_identity_is_ancestor() {
  local common=$1 oid=$2 depth=$3 index=0
  while [ "$index" -lt "$depth" ]; do
    if [ "${_review_submodule_ancestor_common[$index]}" = "$common" ] && \
      [ "${_review_submodule_ancestor_oid[$index]}" = "$oid" ]; then
      return 0
    fi
    index=$((index + 1))
  done
  return 1
}

_review_submodule_destination_parent() {
  local material_parent=$1 relative=$2 parent relative_parent
  relative_parent=${relative%/*}
  [ "$relative_parent" != "$relative" ] || relative_parent=.
  mkdir -p -- "$material_parent/$relative_parent" || return 1
  IFS= read -r -d '' parent < <(
    _review_submodule_physical_dir "$material_parent/$relative_parent"
  ) || return 1
  [ "$parent" = "$material_parent/$relative_parent" ] || [ "$relative_parent" = . ] || {
    printf 'devkit review: submodule destination parent escapes through a symlink: %q\n' \
      "$material_parent/$relative_parent" >&2
    return 1
  }
}

_review_submodule_materialize_one() {
  local material_parent=$1 source_parent=$2 relative=$3 oid=$4 manifest=$5 depth=$6
  local source="$source_parent/$relative" destination="$material_parent/$relative" status
  [ "$depth" -lt "$_REVIEW_SUBMODULE_MAX_DEPTH" ] || {
    printf 'devkit review: submodule nesting exceeds the %s-level safety limit at %q\n' \
      "$_REVIEW_SUBMODULE_MAX_DEPTH" "$relative" >&2
    return 1
  }
  _review_submodule_resolve_source "$source" "$source_parent" "$oid" || return 1
  if _review_submodule_identity_is_ancestor "$_review_submodule_identity_common" "$oid" "$depth"; then
    printf 'devkit review: recursive submodule cycle detected at %q\n' "$relative" >&2
    return 1
  fi
  _review_submodule_destination_parent "$material_parent" "$relative" || return 1
  if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -d "$destination" ]; }; then
    printf 'devkit review: submodule destination is not an empty directory: %q\n' "$destination" >&2
    return 1
  fi
  if [ -d "$destination" ] && ! rmdir -- "$destination" 2>/dev/null; then
    printf 'devkit review: submodule destination is not empty: %q\n' "$destination" >&2
    return 1
  fi
  printf '%s\0%s\0%s\0%s\0' \
    "$_review_submodule_identity_source" "$_review_submodule_identity_common" \
    "$destination" "$oid" >> "$manifest" || return 1
  _review_submodule_git --git-dir="$_review_submodule_identity_common" \
    worktree add --quiet --detach --no-checkout "$destination" "$oid" || return 1
  _review_submodule_git -C "$destination" reset --hard --quiet "$oid" || return 1
  _review_submodule_ancestor_common[$depth]=$_review_submodule_identity_common
  _review_submodule_ancestor_oid[$depth]=$oid
  _review_submodule_materialize_level \
    "$destination" "$_review_submodule_identity_source" "$manifest" "$((depth + 1))"
  status=$?
  return "$status"
}

_review_submodule_materialize_level() {
  local material_parent=$1 source_parent=$2 manifest=$3 depth=$4 scan record status=0
  IFS= read -r -d '' scan < <(_review_submodule_temp scan) || return 1
  if ! _review_submodule_git -C "$material_parent" ls-files --stage -z > "$scan"; then
    rm -f -- "$scan"
    return 1
  fi
  while IFS= read -r -d '' record; do
    if ! _review_submodule_parse_entry "$record"; then
      echo 'devkit review: malformed Git index entry while inspecting submodules.' >&2
      status=1
      break
    fi
    [ "$_review_submodule_entry_mode" = 160000 ] || continue
    if [ "$_review_submodule_entry_stage" != 0 ] || \
      ! _review_submodule_valid_oid "$_review_submodule_entry_oid" || \
      ! _review_submodule_safe_relative_path "$_review_submodule_entry_path"; then
      printf 'devkit review: invalid or unmerged submodule index entry: %q\n' \
        "$_review_submodule_entry_path" >&2
      status=1
      break
    fi
    _review_submodule_materialize_one \
      "$material_parent" "$source_parent" "$_review_submodule_entry_path" \
      "$_review_submodule_entry_oid" "$manifest" "$depth" || {
      status=$?
      [ "$status" -ne 0 ] || status=1
      break
    }
  done < "$scan"
  rm -f -- "$scan"
  return "$status"
}

# review_materialize_submodules <worktree> <source-root> <manifest>
review_materialize_submodules() (
  local requested_worktree=$1 requested_source=$2 requested_manifest=$3
  local worktree source manifest status
  local -a _review_submodule_ancestor_common=() _review_submodule_ancestor_oid=()
  IFS= read -r -d '' worktree < <(_review_submodule_physical_dir "$requested_worktree") || return 1
  IFS= read -r -d '' source < <(_review_submodule_physical_dir "$requested_source") || return 1
  [ "$worktree" != "$source" ] || {
    echo 'devkit review: submodules require a separate ephemeral worktree.' >&2
    return 1
  }
  _review_submodule_split_manifest_path "$requested_manifest" || return 1
  manifest=$_review_submodule_manifest_path
  if _review_submodule_path_is_within "$manifest" "$worktree" || \
    _review_submodule_path_is_within "$manifest" "$source"; then
    echo 'devkit review: submodule manifest must be private and outside both checkouts.' >&2
    return 1
  fi
  if [ -L "$manifest" ] || { [ -e "$manifest" ] && [ ! -f "$manifest" ]; }; then
    echo 'devkit review: submodule manifest path is not a regular private file.' >&2
    return 1
  fi
  (umask 077 && : > "$manifest") || return 1
  chmod 600 "$manifest" || return 1
  printf '%s\0' "$_REVIEW_SUBMODULE_MANIFEST_MAGIC" > "$manifest" || return 1
  _review_submodule_materialize_level "$worktree" "$source" "$manifest" 0
  status=$?
  if [ "$status" -ne 0 ]; then
    review_cleanup_submodules "$manifest" || true
    return "$status"
  fi
  return 0
)

. "$_REVIEW_SUBMODULE_LIB_DIR/submodule-manifest.sh"

_review_submodule_warn_level() {
  local source_parent=$1 prefix=$2 depth=$3 scan status_file record relative source display status=0
  local oid common source_head
  [ "$depth" -lt "$_REVIEW_SUBMODULE_MAX_DEPTH" ] || {
    echo 'devkit review: source submodule nesting exceeds the safety limit.' >&2
    return 1
  }
  IFS= read -r -d '' scan < <(_review_submodule_temp scan) || return 1
  if ! _review_submodule_git -C "$source_parent" ls-files --stage -z > "$scan"; then
    rm -f -- "$scan"
    return 1
  fi
  while IFS= read -r -d '' record; do
    _review_submodule_parse_entry "$record" || { status=1; break; }
    [ "$_review_submodule_entry_mode" = 160000 ] || continue
    relative=$_review_submodule_entry_path
    oid=$_review_submodule_entry_oid
    _review_submodule_safe_relative_path "$relative" || { status=1; break; }
    source="$source_parent/$relative"
    if [ ! -e "$source/.git" ]; then
      continue
    fi
    _review_submodule_resolve_source "$source" "$source_parent" "$oid" || { status=1; break; }
    common=$_review_submodule_identity_common
    IFS= read -r -d '' source_head < <(
      _review_submodule_git_line -C "$source" rev-parse --verify HEAD
    ) || { status=1; break; }
    if _review_submodule_identity_is_ancestor "$common" "$oid" "$depth"; then
      echo 'devkit review: recursive source submodule cycle detected.' >&2
      status=1
      break
    fi
    display=${prefix:+$prefix/}$relative
    if [ "$source_head" != "$oid" ]; then
      printf 'devkit review: warning: source submodule %q is checked out at a different commit than its staged gitlink; the unstaged submodule commit is excluded from review.\n' \
        "$display" >&2
    fi
    IFS= read -r -d '' status_file < <(_review_submodule_temp status) || { status=1; break; }
    if ! _review_submodule_git -C "$source" status --porcelain=v1 -z \
      --untracked-files=all --ignore-submodules=none > "$status_file"; then
      rm -f -- "$status_file"
      status=1
      break
    fi
    if [ -s "$status_file" ]; then
      printf 'devkit review: warning: source submodule %q has dirty contents; dirty contents are excluded from review.\n' \
        "$display" >&2
    fi
    rm -f -- "$status_file"
    _review_submodule_ancestor_common[$depth]=$common
    _review_submodule_ancestor_oid[$depth]=$oid
    _review_submodule_warn_level "$source" "$display" "$((depth + 1))" || {
      status=$?
      [ "$status" -ne 0 ] || status=1
      break
    }
  done < "$scan"
  rm -f -- "$scan"
  return "$status"
}

# review_warn_dirty_source_submodules <source-root>
review_warn_dirty_source_submodules() (
  local source
  local -a _review_submodule_ancestor_common=() _review_submodule_ancestor_oid=()
  IFS= read -r -d '' source < <(_review_submodule_physical_dir "$1") || return 1
  _review_submodule_warn_level "$source" '' 0
)
