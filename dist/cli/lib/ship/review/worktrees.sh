#!/usr/bin/env bash
# Detached worktree primitives for `devkit review`. The caller owns orchestration and supplies
# unique paths outside the target checkout; this library owns literal-safe Git operations and
# integrity checks only.

REVIEW_WORKTREE_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$REVIEW_WORKTREE_LIB_DIR/tree-materialization.sh"

_review_worktree_clear_git_env() {
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

_review_worktree_path_is_within() {
  local path=$1 parent=${2%/}
  [ "$path" = "$parent" ] && return 0
  case "$path" in
    "$parent"/*) return 0 ;;
  esac
  return 1
}

_review_worktree_physical_directory() (
  cd -P "$1" 2>/dev/null || exit 1
  printf '%s\0' "$PWD"
)

# Resolve an absolute directory candidate without requiring its final component to exist.
_review_worktree_resolve_candidate() {
  local requested=${1%/} parent leaf resolved_parent
  case "$requested" in
    /*) ;;
    *) return 1 ;;
  esac
  [ -n "$requested" ] && [ "$requested" != / ] || return 1
  leaf=${requested##*/}
  parent=${requested%/*}
  [ -n "$parent" ] || parent=/
  case "$leaf" in
    '' | . | ..) return 1 ;;
  esac
  IFS= read -r -d '' resolved_parent < <(
    _review_worktree_physical_directory "$parent"
  ) || return 1
  printf '%s/%s\0' "${resolved_parent%/}" "$leaf"
}

_review_worktree_git_line() {
  local value
  IFS= read -r -d '' value < <("$@" && printf '\0') || return 1
  case "$value" in
    *$'\n') value=${value%$'\n'} ;;
    *) return 1 ;;
  esac
  printf '%s\0' "$value"
}

_review_worktree_repo_root() {
  local requested=$1 physical root
  IFS= read -r -d '' physical < <(
    _review_worktree_physical_directory "$requested"
  ) || return 1
  IFS= read -r -d '' root < <(
    _review_worktree_git_line \
      git -c core.hooksPath=/dev/null -C "$physical" rev-parse --path-format=absolute --show-toplevel
  ) || return 1
  IFS= read -r -d '' root < <(_review_worktree_physical_directory "$root") || return 1
  printf '%s\0' "$root"
}

_review_worktree_list_stream() {
  local status
  if git -c core.hooksPath=/dev/null -C "$1" worktree list --porcelain -z; then
    status=0
  else
    status=$?
  fi
  printf 'devkit-worktree-list-status %s\0' "$status"
}

_review_worktree_validate_external_destination() {
  local repo=$1 destination=$2 record registered status=
  _review_worktree_path_is_within "$destination" "$repo" && {
    echo "devkit review: worktree destination must be outside the target repository" >&2
    return 1
  }
  while IFS= read -r -d '' record; do
    case "$record" in
      'worktree '*)
        registered=${record#worktree }
        _review_worktree_path_is_within "$destination" "$registered" || continue
        echo "devkit review: worktree destination must be outside every registered checkout" >&2
        return 1
        ;;
      'devkit-worktree-list-status '*) status=${record#devkit-worktree-list-status } ;;
    esac
  done < <(_review_worktree_list_stream "$repo")
  [ "$status" = 0 ]
}

_review_worktree_is_registered() {
  local repo=$1 destination=$2 record registered status= found=1
  while IFS= read -r -d '' record; do
    case "$record" in
      'worktree '*)
        registered=${record#worktree }
        [ "$registered" = "$destination" ] && found=0
        ;;
      'devkit-worktree-list-status '*) status=${record#devkit-worktree-list-status } ;;
    esac
  done < <(_review_worktree_list_stream "$repo")
  [ "$status" = 0 ] || return 2
  return "$found"
}

_review_worktree_remove_registered() {
  local repo=$1 destination=$2
  git -c core.hooksPath=/dev/null -C "$repo" worktree remove --force "$destination"
}

# review_create_worktree <repo> <destination> <commit>
# Creates a checked-out detached worktree. The requested destination must be a fresh absolute path
# outside every checkout registered to this repository.
review_create_worktree() (
  local requested_repo=$1 requested_destination=$2 commit=$3 repo destination commit_oid
  local cleanup_command
  _review_worktree_clear_git_env
  IFS= read -r -d '' repo < <(_review_worktree_repo_root "$requested_repo") || exit 1
  [ ! -e "$requested_destination" ] && [ ! -L "$requested_destination" ] || {
    echo "devkit review: worktree destination already exists" >&2
    exit 1
  }
  IFS= read -r -d '' destination < <(
    _review_worktree_resolve_candidate "$requested_destination"
  ) || {
    echo "devkit review: worktree destination must be a safe absolute path with an existing parent" >&2
    exit 1
  }
  cleanup_review_create_worktree() {
    local status=$1 cleanup_repo=$2 cleanup_destination=$3
    _review_worktree_remove_registered "$cleanup_repo" "$cleanup_destination" >/dev/null 2>&1 || true
    # The destination was proven absent before `git worktree add`, so removing a partial directory
    # cannot delete caller-owned content. Never use this fallback from the public remove helper.
    if [ -e "$cleanup_destination" ] || [ -L "$cleanup_destination" ]; then
      rm -rf -- "$cleanup_destination" || true
    fi
    return "$status"
  }

  _review_worktree_validate_external_destination "$repo" "$destination" || exit 1
  IFS= read -r -d '' commit_oid < <(
    _review_worktree_git_line \
      git -c core.hooksPath=/dev/null -C "$repo" rev-parse --verify --end-of-options "$commit^{commit}"
  ) || {
    echo "devkit review: worktree base is not a commit" >&2
    exit 1
  }
  printf -v cleanup_command 'cleanup_review_create_worktree "$?" %q %q' "$repo" "$destination"
  trap "$cleanup_command" EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 131' QUIT
  trap 'exit 143' TERM
  git -c core.hooksPath=/dev/null -C "$repo" \
    worktree add --quiet --detach "$destination" "$commit_oid" || exit 1
  trap - HUP INT QUIT TERM EXIT
)

# review_staged_tree <worktree>
review_staged_tree() (
  _review_worktree_clear_git_env
  git -c core.hooksPath=/dev/null -C "$1" write-tree
)

_review_worktree_safe_relative_root() {
  local root=$1
  case "$root" in
    '' | /?* | . | .. | ./* | ../* | */ | *//* | */./* | */../* | */. | */..) return 1 ;;
  esac
  return 0
}

_review_worktree_validate_exclusions() {
  local manifest=$1 root last_byte
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  while IFS= read -r -d '' root; do
    _review_worktree_safe_relative_root "$root" || {
      echo "devkit review: unsafe untracked exclusion root" >&2
      return 1
    }
  done < "$manifest"
  [ ! -s "$manifest" ] && return 0
  last_byte=$(tail -c 1 "$manifest" | od -An -tu1 | tr -d '[:space:]') || return 1
  [ "$last_byte" = 0 ] || {
    echo "devkit review: untracked exclusion manifest is not NUL-terminated" >&2
    return 1
  }
}

_review_worktree_path_is_excluded() {
  local path=$1 manifest=${2:-} root
  [ -n "$manifest" ] || return 1
  while IFS= read -r -d '' root; do
    case "$path" in
      "$root" | "$root"/*) return 0 ;;
    esac
  done < "$manifest"
  return 1
}

_review_worktree_entry_mode() {
  local path=$1 type=$2 mode
  # Git represents every symlink as mode 120000. Do not ask platform `stat` for a symlink mode:
  # implementations disagree about dereferencing, while the link target itself is hashed below.
  [ "$type" = symlink ] && { printf '120000\n'; return 0; }
  mode=$(stat -f '%Lp' -- "$path" 2>/dev/null) || \
    mode=$(stat -c '%a' -- "$path" 2>/dev/null) || return 1
  case "$mode" in
    '' | *[!0-7]*) return 1 ;;
  esac
  printf '%s\n' "$mode"
}

_review_worktree_entry_type() {
  [ -L "$1" ] && { printf 'symlink\n'; return 0; }
  [ -f "$1" ] && { printf 'file\n'; return 0; }
  return 1
}

_review_worktree_readlink() {
  local value
  IFS= read -r -d '' value < <(readlink -n "$1" && printf '\0') || return 1
  printf '%s\0' "$value"
}

_review_worktree_hash_entry() {
  local worktree=$1 path=$2 type=$3 full target oid
  full=$worktree/$path
  if [ "$type" = symlink ]; then
    IFS= read -r -d '' target < <(_review_worktree_readlink "$full") || return 1
    oid=$(printf '%s' "$target" | \
      git -c core.hooksPath=/dev/null -C "$worktree" hash-object --stdin) || return 1
  else
    oid=$(git -c core.hooksPath=/dev/null -C "$worktree" \
      hash-object --no-filters -- "$path") || return 1
  fi
  case "$oid" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  printf '%s\n' "$oid"
}

_review_worktree_capture_untracked_once() {
  local worktree=$1 destination=$2 exclusions=${3:-} paths path full
  local type_before type_after mode_before mode_after oid exclusions_oid
  paths=$(mktemp "${destination}.paths.XXXXXX") || return 1
  git -c core.hooksPath=/dev/null -C "$worktree" \
    ls-files --others --exclude-standard -z > "$paths" || {
    rm -f -- "$paths"
    return 1
  }
  exclusions_oid=$(git -c core.hooksPath=/dev/null -C "$worktree" \
    hash-object --no-filters -- "$exclusions") || { rm -f -- "$paths"; return 1; }
  printf 'devkit-untracked-v1\0%s\0' "$exclusions_oid" > "$destination" || {
    rm -f -- "$paths"
    return 1
  }
  while IFS= read -r -d '' path; do
    _review_worktree_path_is_excluded "$path" "$exclusions" && continue
    case "$path" in
      '' | /* | .. | ../* | */.. | */../*)
        echo "devkit review: Git returned an unsafe untracked path" >&2
        rm -f -- "$paths"
        return 1
        ;;
    esac
    full=$worktree/$path
    type_before=$(_review_worktree_entry_type "$full") || {
      echo "devkit review: unsupported non-ignored untracked entry: $path" >&2
      rm -f -- "$paths"
      return 1
    }
    mode_before=$(_review_worktree_entry_mode "$full" "$type_before") || {
      rm -f -- "$paths"
      return 1
    }
    oid=$(_review_worktree_hash_entry "$worktree" "$path" "$type_before") || {
      rm -f -- "$paths"
      return 1
    }
    type_after=$(_review_worktree_entry_type "$full") || { rm -f -- "$paths"; return 1; }
    mode_after=$(_review_worktree_entry_mode "$full" "$type_after") || {
      rm -f -- "$paths"
      return 1
    }
    [ "$type_before" = "$type_after" ] && [ "$mode_before" = "$mode_after" ] || {
      echo "devkit review: untracked entry changed during integrity capture: $path" >&2
      rm -f -- "$paths"
      return 1
    }
    printf '%s\0%s\0%s\0%s\0' "$path" "$type_before" "$mode_before" "$oid" \
      >> "$destination" || { rm -f -- "$paths"; return 1; }
  done < "$paths"
  rm -f -- "$paths"
}

_review_worktree_prepare_exclusions() {
  local worktree=$1 requested=${2:-} destination=$3 resolved
  [ -n "$requested" ] || { : > "$destination"; return 0; }
  case "$requested" in
    /*) ;;
    *)
      echo "devkit review: untracked exclusion manifest must use an absolute path" >&2
      return 1
      ;;
  esac
  [ -f "$requested" ] && [ ! -L "$requested" ] || return 1
  IFS= read -r -d '' resolved < <(
    _review_worktree_resolve_candidate "$requested"
  ) || return 1
  _review_worktree_path_is_within "$resolved" "$worktree" && {
    echo "devkit review: untracked exclusion manifest must be outside the worktree" >&2
    return 1
  }
  cp -p "$requested" "$destination" || return 1
  _review_worktree_validate_exclusions "$destination" || return 1
  cmp -s "$requested" "$destination"
}

_review_worktree_capture_untracked_stable() {
  local worktree=$1 destination=$2 exclusions=$3 first second
  first=$(mktemp "${destination}.first.XXXXXX") || return 1
  second=$(mktemp "${destination}.second.XXXXXX") || { rm -f -- "$first"; return 1; }
  if ! _review_worktree_capture_untracked_once "$worktree" "$first" "$exclusions" ||
    ! _review_worktree_capture_untracked_once "$worktree" "$second" "$exclusions" ||
    ! cmp -s "$first" "$second"; then
    echo "devkit review: non-ignored untracked files changed during integrity capture" >&2
    rm -f -- "$first" "$second"
    return 1
  fi
  mv -f "$first" "$destination" || { rm -f -- "$first" "$second"; return 1; }
  rm -f -- "$second"
}

# review_capture_untracked <worktree> <manifest> [exclusion-roots-manifest]
# The output authenticates its exclusion set, followed by NUL-delimited path/type/mode/blob-OID
# records. Optional exclusions are exact safe repo-relative roots (also NUL-delimited); only those
# explicitly mutable private roots are omitted.
review_capture_untracked() (
  local requested_worktree=$1 manifest=$2 requested_exclusions=${3:-}
  local worktree resolved_manifest exclusions cleanup_command
  _review_worktree_clear_git_env
  IFS= read -r -d '' worktree < <(
    _review_worktree_physical_directory "$requested_worktree"
  ) || exit 1
  IFS= read -r -d '' resolved_manifest < <(
    _review_worktree_resolve_candidate "$manifest"
  ) || exit 1
  _review_worktree_path_is_within "$resolved_manifest" "$worktree" && {
    echo "devkit review: untracked integrity manifest must be outside the worktree" >&2
    exit 1
  }
  exclusions=$(mktemp "${resolved_manifest}.exclusions.XXXXXX") || exit 1
  printf -v cleanup_command 'rm -f -- %q' "$exclusions"
  trap "$cleanup_command" EXIT
  _review_worktree_prepare_exclusions "$worktree" "$requested_exclusions" "$exclusions" || exit 1
  _review_worktree_capture_untracked_stable "$worktree" "$resolved_manifest" "$exclusions" || exit 1
  [ -z "$requested_exclusions" ] || cmp -s "$requested_exclusions" "$exclusions" || {
    echo "devkit review: untracked exclusion manifest changed during integrity capture" >&2
    exit 1
  }
)

# review_assert_untracked_unchanged <worktree> <manifest> [exclusion-roots-manifest]
review_assert_untracked_unchanged() (
  local requested_worktree=$1 manifest=$2 requested_exclusions=${3:-}
  local worktree resolved_manifest exclusions current cleanup_command
  _review_worktree_clear_git_env
  IFS= read -r -d '' worktree < <(
    _review_worktree_physical_directory "$requested_worktree"
  ) || exit 1
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || exit 1
  IFS= read -r -d '' resolved_manifest < <(
    _review_worktree_resolve_candidate "$manifest"
  ) || exit 1
  _review_worktree_path_is_within "$resolved_manifest" "$worktree" && exit 1
  exclusions=$(mktemp "${resolved_manifest}.exclusions.XXXXXX") || exit 1
  current=$(mktemp "${resolved_manifest}.current.XXXXXX") || { rm -f -- "$exclusions"; exit 1; }
  printf -v cleanup_command 'rm -f -- %q %q' "$exclusions" "$current"
  trap "$cleanup_command" EXIT
  _review_worktree_prepare_exclusions "$worktree" "$requested_exclusions" "$exclusions" || exit 1
  _review_worktree_capture_untracked_stable "$worktree" "$current" "$exclusions" || exit 1
  [ -z "$requested_exclusions" ] || cmp -s "$requested_exclusions" "$exclusions" || exit 1
  cmp -s "$resolved_manifest" "$current" || {
    echo "devkit review: non-ignored untracked files changed during review" >&2
    exit 1
  }
)

# review_remove_worktree <repo> <destination>
# Safe and idempotent: an absent/unregistered destination succeeds; existing non-worktree content is
# never removed.
review_remove_worktree() (
  local requested_repo=$1 requested_destination=$2 repo destination status
  _review_worktree_clear_git_env
  IFS= read -r -d '' repo < <(_review_worktree_repo_root "$requested_repo") || exit 1
  IFS= read -r -d '' destination < <(
    _review_worktree_resolve_candidate "$requested_destination"
  ) || exit 1
  _review_worktree_path_is_within "$destination" "$repo" && exit 1
  if _review_worktree_is_registered "$repo" "$destination"; then
    status=0
  else
    status=$?
  fi
  case "$status" in
    0) _review_worktree_remove_registered "$repo" "$destination" ;;
    1)
      if [ -e "$destination" ] || [ -L "$destination" ]; then
        echo "devkit review: refusing to remove a path that is not a registered worktree" >&2
        exit 1
      fi
      ;;
    *) exit "$status" ;;
  esac
)
