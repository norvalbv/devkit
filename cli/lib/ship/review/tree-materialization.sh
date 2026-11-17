#!/usr/bin/env bash
# Filter-free Git tree materialization. The caller supplies a verified clean temporary worktree and
# owns the scratch manifest; this helper writes only raw blob bytes and Git-representable modes.

_review_tree_safe_path() {
  local path=$1
  case "$path" in
    '' | /* | . | .. | ./* | ../* | */ | *//* | */./* | */../* | */. | */..) return 1 ;;
  esac
  case "/$path/" in
    */[.][gG][iI][tT]/*) return 1 ;;
  esac
  return 0
}

# _review_rehash_regular_entries <repo-dir> <index-file> <scratch>
# Replaces every regular-file blob in the index with the filter-free hash of its working-tree bytes.
_review_rehash_regular_entries() {
  local repo=$1 index=$2 scratch=$3 record metadata path mode offset count i oid
  local paths=() modes=() oids=()
  GIT_INDEX_FILE="$index" git -C "$repo" ls-files --stage -z > "$scratch" || return 1
  while IFS= read -r -d '' record; do
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    mode=${metadata%% *}
    [ "${metadata##* }" = 0 ] || return 1
    case "$mode" in
      100644 | 100755) paths[${#paths[@]}]=$path; modes[${#modes[@]}]=$mode ;;
    esac
  done < "$scratch"
  count=${#paths[@]}
  [ "$count" -gt 0 ] || return 0
  # `hash-object` takes literal path arguments, so bounded batches keep newline paths intact.
  : > "$scratch" || return 1
  offset=0
  while [ "$offset" -lt "$count" ]; do
    git -C "$repo" hash-object -w --no-filters -- "${paths[@]:$offset:256}" >> "$scratch" ||
      return 1
    offset=$((offset + 256))
  done
  while IFS= read -r oid; do
    case "$oid" in
      '' | *[!0-9a-f]*) return 1 ;;
    esac
    oids[${#oids[@]}]=$oid
  done < "$scratch"
  [ "${#oids[@]}" -eq "$count" ] || return 1
  : > "$scratch" || return 1
  i=0
  while [ "$i" -lt "$count" ]; do
    printf '%s %s\t%s\0' "${modes[$i]}" "${oids[$i]}" "${paths[$i]}" >> "$scratch" || return 1
    i=$((i + 1))
  done
  GIT_INDEX_FILE="$index" git -C "$repo" update-index -z --index-info < "$scratch"
}

_review_tree_parse_record() {
  local record=$1 metadata
  case "$record" in
    *$'\t'*) ;;
    *) return 1 ;;
  esac
  metadata=${record%%$'\t'*}
  _review_tree_path=${record#*$'\t'}
  _review_tree_mode=${metadata%% *}
  metadata=${metadata#* }
  _review_tree_type=${metadata%% *}
  _review_tree_oid=${metadata#* }
  [ -n "$_review_tree_path" ] && [ -n "$_review_tree_oid" ] || return 1
  case "$_review_tree_oid" in
    *[!0-9a-f]*) return 1 ;;
  esac
  _review_tree_safe_path "$_review_tree_path"
}

_review_tree_parent_directory() {
  local worktree=$1 path=$2 parent=${2%/*}
  [ "$parent" = "$path" ] && return 0
  mkdir -p -- "$worktree/$parent"
}

_review_tree_write_symlink() {
  local worktree=$1 oid=$2 destination=$3 target size target_size
  size=$(git -c core.hooksPath=/dev/null -C "$worktree" cat-file -s "$oid") || return 1
  case "$size" in
    '' | *[!0-9]*) return 1 ;;
  esac
  IFS= read -r -d '' target < <(
    git -c core.hooksPath=/dev/null -C "$worktree" cat-file blob "$oid" && printf '\0'
  ) || return 1
  target_size=$(printf '%s' "$target" | LC_ALL=C wc -c | tr -d '[:space:]') || return 1
  [ "$target_size" = "$size" ] || {
    echo 'devkit review: snapshot contains an invalid symlink target.' >&2
    return 1
  }
  ln -s -- "$target" "$destination"
}

_review_tree_write_record() {
  local worktree=$1 path=$_review_tree_path destination=$1/$_review_tree_path
  _review_tree_parent_directory "$worktree" "$path" || return 1
  case "$_review_tree_mode $_review_tree_type" in
    '100644 blob' | '100755 blob')
      git -c core.hooksPath=/dev/null -C "$worktree" \
        cat-file blob "$_review_tree_oid" > "$destination" || return 1
      if [ "$_review_tree_mode" = 100755 ]; then
        chmod 0755 "$destination"
      else
        chmod 0644 "$destination"
      fi
      ;;
    '120000 blob')
      _review_tree_write_symlink "$worktree" "$_review_tree_oid" "$destination"
      ;;
    '160000 commit')
      mkdir -- "$destination"
      ;;
    *)
      printf 'devkit review: unsupported snapshot tree entry mode/type: %s %s\n' \
        "$_review_tree_mode" "$_review_tree_type" >&2
      return 1
      ;;
  esac
}

# Reads one path's six check-attr triples from fd 4; succeeds when none would convert its bytes.
# `text` alone never converts on checkout once core.eol=lf and core.autocrlf=false are pinned.
_review_tree_attributes_inert() {
  local expected=$1 path name value converts=0 n
  for n in 1 2 3 4 5 6; do
    IFS= read -r -d '' path <&4 && IFS= read -r -d '' name <&4 &&
      IFS= read -r -d '' value <&4 || return 2
    [ "$path" = "$expected" ] || return 2
    case "$name:$value" in
      text:* | eol:lf | *:unspecified | *:unset) ;;
      *) converts=1 ;;
    esac
  done
  return "$converts"
}

# _review_tree_materialize_raw <worktree> <tree-oid> <scratch-manifest> <scratch-attributes>
_review_tree_materialize_raw() {
  local worktree=$1 tree_oid=$2 manifest=$3 attributes=$4 record attribute_status
  local _review_tree_path _review_tree_mode _review_tree_type _review_tree_oid
  local checkout=()
  git -c core.hooksPath=/dev/null -C "$worktree" \
    ls-tree -rz -r "$tree_oid" > "$manifest" || return 1

  # With an empty index every old checkout entry becomes disposable. The worktree was already
  # proven clean, and `git clean` preserves the linked-worktree `.git` administrative file.
  git -c core.hooksPath=/dev/null -C "$worktree" read-tree --empty || return 1
  git -c core.hooksPath=/dev/null -C "$worktree" clean -ffdxq || return 1
  git -c core.hooksPath=/dev/null -C "$worktree" read-tree --reset "$tree_oid" || return 1

  # Paths whose attributes could convert bytes (in-tree or info/attributes) keep the raw writer.
  while IFS= read -r -d '' record; do printf '%s\0' "${record#*$'\t'}"; done < "$manifest" |
    GIT_ATTR_NOSYSTEM=1 git -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null \
      -C "$worktree" check-attr --cached -z --stdin \
      filter text eol crlf ident working-tree-encoding > "$attributes" || return 1
  {
    while IFS= read -r -d '' record; do
      _review_tree_parse_record "$record" || {
        echo 'devkit review: snapshot tree contains an unsafe or malformed path.' >&2
        return 1
      }
      attribute_status=0
      _review_tree_attributes_inert "$_review_tree_path" || attribute_status=$?
      [ "$attribute_status" -ne 2 ] || return 1
      case "$attribute_status:$_review_tree_mode $_review_tree_type" in
        '0:100644 blob' | '0:100755 blob') checkout[${#checkout[@]}]=$_review_tree_path ;;
        *) _review_tree_write_record "$worktree" || return 1 ;;
      esac
    done < "$manifest"
  } 4< "$attributes" || return 1
  [ "${#checkout[@]}" -gt 0 ] || return 0
  # umask 022 restores 0644/0755 under review-target's umask 077, as the raw writer's chmod does.
  printf '%s\0' "${checkout[@]}" | (
    umask 022
    GIT_ATTR_NOSYSTEM=1 git -c core.hooksPath=/dev/null -c core.autocrlf=false -c core.eol=lf \
      -c core.attributesFile=/dev/null -C "$worktree" checkout-index -f -z --stdin
  )
}

# review_materialize_tree <worktree> <staged-tree> [raw-tree]
# Installs the canonical staged index plus exact raw filesystem bytes without moving detached HEAD.
review_materialize_tree() (
  local requested=$1 staged_tree=$2 raw_tree=${3:-$2} worktree head_before head_after
  local staged_oid raw_oid actual_staged status_file manifest cleanup_command
  _review_worktree_clear_git_env
  IFS= read -r -d '' worktree < <(_review_worktree_physical_directory "$requested") || exit 1
  IFS= read -r -d '' head_before < <(
    _review_worktree_git_line git -c core.hooksPath=/dev/null -C "$worktree" rev-parse --verify HEAD
  ) || exit 1
  IFS= read -r -d '' staged_oid < <(
    _review_worktree_git_line git -c core.hooksPath=/dev/null -C "$worktree" \
      rev-parse --verify --end-of-options "$staged_tree^{tree}"
  ) || { echo 'devkit review: staged snapshot is not a Git tree' >&2; exit 1; }
  IFS= read -r -d '' raw_oid < <(
    _review_worktree_git_line git -c core.hooksPath=/dev/null -C "$worktree" \
      rev-parse --verify --end-of-options "$raw_tree^{tree}"
  ) || { echo 'devkit review: raw snapshot is not a Git tree' >&2; exit 1; }
  status_file=$(mktemp "${TMPDIR:-/tmp}/devkit-review-worktree-status.XXXXXX") || exit 1
  manifest=$(mktemp "${TMPDIR:-/tmp}/devkit-review-tree.XXXXXX") || {
    rm -f -- "$status_file"; exit 1;
  }
  printf -v cleanup_command 'rm -f -- %q %q' "$status_file" "$manifest"
  trap "$cleanup_command" EXIT
  git -c core.hooksPath=/dev/null -C "$worktree" \
    status --porcelain=v1 -z --untracked-files=all > "$status_file" || exit 1
  [ ! -s "$status_file" ] || {
    echo 'devkit review: refusing to materialize over a dirty temporary worktree' >&2
    exit 1
  }
  _review_tree_materialize_raw "$worktree" "$raw_oid" "$manifest" "$status_file" || exit 1
  git -c core.hooksPath=/dev/null -C "$worktree" read-tree --reset "$staged_oid" || exit 1
  IFS= read -r -d '' head_after < <(
    _review_worktree_git_line git -c core.hooksPath=/dev/null -C "$worktree" rev-parse --verify HEAD
  ) || exit 1
  [ "$head_after" = "$head_before" ] || {
    echo 'devkit review: temporary worktree HEAD changed during materialization' >&2
    exit 1
  }
  actual_staged=$(git -c core.hooksPath=/dev/null -C "$worktree" write-tree) || exit 1
  [ "$actual_staged" = "$staged_oid" ] || {
    echo 'devkit review: materialized index does not match the canonical snapshot' >&2
    exit 1
  }
)

# review_worktree_matches_tree <worktree> <raw-tree> [staged-tree]
# Compares tracked filesystem bytes and Git-representable modes without clean/smudge/eol filters.
# Gitlink contents are authenticated separately by review_verify_submodules.
review_worktree_matches_tree() (
  local requested_worktree=$1 tree=$2 staged_tree=${3:-$2} worktree tree_oid staged_oid
  local staged manifest index actual record metadata path cleanup_command
  _review_worktree_clear_git_env
  IFS= read -r -d '' worktree < <(
    _review_worktree_physical_directory "$requested_worktree"
  ) || exit 1
  IFS= read -r -d '' tree_oid < <(
    _review_worktree_git_line \
      git -c core.hooksPath=/dev/null -C "$worktree" \
      rev-parse --verify --end-of-options "$tree^{tree}"
  ) || exit 1
  IFS= read -r -d '' staged_oid < <(
    _review_worktree_git_line \
      git -c core.hooksPath=/dev/null -C "$worktree" \
      rev-parse --verify --end-of-options "$staged_tree^{tree}"
  ) || exit 1
  staged=$(git -c core.hooksPath=/dev/null -C "$worktree" write-tree) || exit 1
  [ "$staged" = "$staged_oid" ] || exit 1
  manifest=$(mktemp "${TMPDIR:-/tmp}/devkit-review-tree-match.XXXXXX") || exit 1
  index=$(mktemp "${TMPDIR:-/tmp}/devkit-review-tree-index.XXXXXX") || {
    rm -f -- "$manifest"
    exit 1
  }
  printf -v cleanup_command 'rm -f -- %q %q %q %q' \
    "$manifest" "$index" "$index.lock" "$index.gitlinks"
  trap "$cleanup_command" EXIT
  rm -f -- "$index"
  # A read-tree index carries no stat data, so `add -u` re-reads every tracked path; untracked
  # gate outputs stay out of it and are judged by review_assert_untracked_unchanged instead.
  GIT_INDEX_FILE="$index" git -c core.hooksPath=/dev/null -C "$worktree" \
    read-tree "$tree_oid" || exit 1
  GIT_INDEX_FILE="$index" git -c core.hooksPath=/dev/null -c core.safecrlf=false \
    -c core.fileMode=true -c core.symlinks=true -C "$worktree" add -u -- . || exit 1
  git -c core.hooksPath=/dev/null -C "$worktree" ls-tree -rz -r "$tree_oid" > "$manifest" ||
    exit 1
  # `add -u` stores a gitlink at its checkout's HEAD; keep the snapshot OID while it is a directory.
  while IFS= read -r -d '' record; do
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    [ "${metadata%% *}" = 160000 ] || continue
    [ -d "$worktree/$path" ] && [ ! -L "$worktree/$path" ] || continue
    printf '160000 %s\t%s\0' "${metadata##* }" "$path"
  done < "$manifest" > "$index.gitlinks" || exit 1
  GIT_INDEX_FILE="$index" git -c core.hooksPath=/dev/null -C "$worktree" \
    update-index -z --index-info < "$index.gitlinks" || exit 1
  _review_rehash_regular_entries "$worktree" "$index" "$manifest" || exit 1
  actual=$(GIT_INDEX_FILE="$index" git -c core.hooksPath=/dev/null -C "$worktree" write-tree) ||
    exit 1
  [ "$actual" = "$tree_oid" ] && exit 0
  git -c core.hooksPath=/dev/null -C "$worktree" \
    diff-tree -r -z --name-only "$tree_oid" "$actual" > "$manifest" || exit 1
  while IFS= read -r -d '' path; do
    printf 'devkit review: tracked snapshot entry changed: %q\n' "$path" >&2
  done < "$manifest"
  exit 1
)
