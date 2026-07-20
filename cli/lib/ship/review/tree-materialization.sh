#!/usr/bin/env bash
# Filter-free Git tree materialization. The caller supplies a verified clean temporary worktree and
# owns the scratch manifest; this helper writes only raw blob bytes and Git-representable modes.

_review_tree_safe_path() {
  local path=$1 lower
  case "$path" in
    '' | /* | . | .. | ./* | ../* | */ | *//* | */./* | */../* | */. | */..) return 1 ;;
  esac
  lower=$(printf '%s' "$path" | LC_ALL=C tr '[:upper:]' '[:lower:]') || return 1
  case "/$lower/" in
    */.git/*) return 1 ;;
  esac
  return 0
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

# _review_tree_materialize_raw <worktree> <tree-oid> <scratch-manifest>
_review_tree_materialize_raw() {
  local worktree=$1 tree_oid=$2 manifest=$3 record
  local _review_tree_path _review_tree_mode _review_tree_type _review_tree_oid
  git -c core.hooksPath=/dev/null -C "$worktree" \
    ls-tree -rz -r "$tree_oid" > "$manifest" || return 1

  # With an empty index every old checkout entry becomes disposable. The worktree was already
  # proven clean, and `git clean` preserves the linked-worktree `.git` administrative file.
  git -c core.hooksPath=/dev/null -C "$worktree" read-tree --empty || return 1
  git -c core.hooksPath=/dev/null -C "$worktree" clean -ffdxq || return 1
  git -c core.hooksPath=/dev/null -C "$worktree" read-tree --reset "$tree_oid" || return 1

  while IFS= read -r -d '' record; do
    _review_tree_parse_record "$record" || {
      echo 'devkit review: snapshot tree contains an unsafe or malformed path.' >&2
      return 1
    }
    _review_tree_write_record "$worktree" || return 1
  done < "$manifest"
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
  _review_tree_materialize_raw "$worktree" "$raw_oid" "$manifest" || exit 1
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

_review_tree_normalized_mode() {
  local permissions=$1 type=$2
  [ "$type" = symlink ] && { printf '120000\n'; return 0; }
  case "$permissions" in
    '' | *[!0-7]*) return 1 ;;
  esac
  if (( (8#$permissions & 0111) != 0 )); then
    printf '100755\n'
  else
    printf '100644\n'
  fi
}

_review_tree_record_matches_worktree() {
  local worktree=$1 full=$1/$_review_tree_path expected_type type_before type_after
  local permissions_before permissions_after mode oid
  case "$_review_tree_mode $_review_tree_type" in
    '100644 blob' | '100755 blob') expected_type=file ;;
    '120000 blob') expected_type=symlink ;;
    '160000 commit') [ -d "$full" ] && [ ! -L "$full" ]; return ;;
    *) return 1 ;;
  esac
  type_before=$(_review_worktree_entry_type "$full") || return 1
  [ "$type_before" = "$expected_type" ] || return 1
  permissions_before=$(_review_worktree_entry_mode "$full" "$type_before") || return 1
  mode=$(_review_tree_normalized_mode "$permissions_before" "$type_before") || return 1
  [ "$mode" = "$_review_tree_mode" ] || return 1
  oid=$(_review_worktree_hash_entry "$worktree" "$_review_tree_path" "$type_before") || return 1
  [ "$oid" = "$_review_tree_oid" ] || {
    printf 'devkit review: raw OID mismatch (%s != %s)\n' "$oid" "$_review_tree_oid" >&2
    return 1
  }
  type_after=$(_review_worktree_entry_type "$full") || return 1
  permissions_after=$(_review_worktree_entry_mode "$full" "$type_after") || return 1
  [ "$type_before" = "$type_after" ] && \
    [ "$permissions_before" = "$permissions_after" ]
}

# review_worktree_matches_tree <worktree> <raw-tree> [staged-tree]
# Compares tracked filesystem bytes and Git-representable modes without clean/smudge/eol filters.
# Gitlink contents are authenticated separately by review_verify_submodules.
review_worktree_matches_tree() (
  local requested_worktree=$1 tree=$2 staged_tree=${3:-$2} worktree tree_oid staged_oid
  local staged manifest record cleanup_command
  local _review_tree_path _review_tree_mode _review_tree_type _review_tree_oid
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
  printf -v cleanup_command 'rm -f -- %q' "$manifest"
  trap "$cleanup_command" EXIT
  git -c core.hooksPath=/dev/null -C "$worktree" \
    ls-tree -rz -r "$tree_oid" > "$manifest" || exit 1
  while IFS= read -r -d '' record; do
    _review_tree_parse_record "$record" || exit 1
    _review_tree_record_matches_worktree "$worktree" || {
      printf 'devkit review: tracked snapshot entry changed: %q\n' "$_review_tree_path" >&2
      exit 1
    }
  done < "$manifest"
)
