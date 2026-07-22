#!/usr/bin/env bash
# Manifest-driven verification and reverse-order cleanup for review submodule worktrees.
# Sourced by submodules.sh after its path, Git, OID, and private-temp primitives are defined.

_review_submodule_load_manifest() {
  local manifest=$1 magic='' source common destination oid index existing
  _review_submodule_manifest_sources=()
  _review_submodule_manifest_commons=()
  _review_submodule_manifest_destinations=()
  _review_submodule_manifest_oids=()
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  exec 9< "$manifest" || return 1
  IFS= read -r -d '' magic <&9 || { exec 9<&-; return 1; }
  [ "$magic" = "$_REVIEW_SUBMODULE_MANIFEST_MAGIC" ] || { exec 9<&-; return 1; }
  while :; do
    source=
    if ! IFS= read -r -d '' source <&9; then
      [ -z "$source" ] || { exec 9<&-; return 1; }
      break
    fi
    IFS= read -r -d '' common <&9 && \
      IFS= read -r -d '' destination <&9 && \
      IFS= read -r -d '' oid <&9 || { exec 9<&-; return 1; }
    case "$source" in /*) ;; *) exec 9<&-; return 1 ;; esac
    case "$common" in /*) ;; *) exec 9<&-; return 1 ;; esac
    case "$destination" in /*) ;; *) exec 9<&-; return 1 ;; esac
    _review_submodule_valid_oid "$oid" || { exec 9<&-; return 1; }
    index=0
    while [ "$index" -lt "${#_review_submodule_manifest_destinations[@]}" ]; do
      existing=${_review_submodule_manifest_destinations[$index]}
      [ "$existing" != "$destination" ] || { exec 9<&-; return 1; }
      index=$((index + 1))
    done
    index=${#_review_submodule_manifest_destinations[@]}
    _review_submodule_manifest_sources[$index]=$source
    _review_submodule_manifest_commons[$index]=$common
    _review_submodule_manifest_destinations[$index]=$destination
    _review_submodule_manifest_oids[$index]=$oid
  done
  exec 9<&-
}

_review_submodule_verify_record() {
  local source=$1 common=$2 destination=$3 oid=$4 actual head status_file symbolic_status
  [ -d "$source" ] && [ ! -L "$source" ] || return 1
  IFS= read -r -d '' actual < <(
    _review_submodule_git_line -C "$source" rev-parse --path-format=absolute --git-common-dir
  ) || return 1
  IFS= read -r -d '' actual < <(_review_submodule_physical_dir "$actual") || return 1
  [ "$actual" = "$common" ] || return 1
  _review_submodule_git --git-dir="$common" cat-file -e "$oid^{commit}" 2>/dev/null || return 1
  [ -d "$destination" ] && [ ! -L "$destination" ] || return 1
  IFS= read -r -d '' actual < <(
    _review_submodule_git_line -C "$destination" rev-parse --path-format=absolute --git-common-dir
  ) || return 1
  IFS= read -r -d '' actual < <(_review_submodule_physical_dir "$actual") || return 1
  [ "$actual" = "$common" ] || return 1
  IFS= read -r -d '' head < <(_review_submodule_git_line -C "$destination" rev-parse HEAD) || return 1
  [ "$head" = "$oid" ] || return 1
  _review_submodule_git -C "$destination" symbolic-ref -q HEAD >/dev/null 2>&1
  symbolic_status=$?
  [ "$symbolic_status" -eq 1 ] || return 1
  IFS= read -r -d '' status_file < <(_review_submodule_temp status) || return 1
  _review_submodule_git -C "$destination" status --porcelain=v1 -z \
    --untracked-files=all --ignore-submodules=none > "$status_file" || {
    rm -f -- "$status_file"
    return 1
  }
  [ ! -s "$status_file" ]
  symbolic_status=$?
  rm -f -- "$status_file"
  return "$symbolic_status"
}

# review_verify_submodules <manifest>
review_verify_submodules() (
  local requested_manifest=$1 manifest index
  local -a _review_submodule_manifest_sources=() _review_submodule_manifest_commons=()
  local -a _review_submodule_manifest_destinations=() _review_submodule_manifest_oids=()
  _review_submodule_split_manifest_path "$requested_manifest" || return 1
  manifest=$_review_submodule_manifest_path
  _review_submodule_load_manifest "$manifest" || {
    echo 'devkit review: submodule manifest is missing or malformed.' >&2
    return 1
  }
  index=0
  while [ "$index" -lt "${#_review_submodule_manifest_destinations[@]}" ]; do
    if ! _review_submodule_verify_record \
      "${_review_submodule_manifest_sources[$index]}" \
      "${_review_submodule_manifest_commons[$index]}" \
      "${_review_submodule_manifest_destinations[$index]}" \
      "${_review_submodule_manifest_oids[$index]}"; then
      printf 'devkit review: materialized submodule changed during review: %q\n' \
        "${_review_submodule_manifest_destinations[$index]}" >&2
      return 1
    fi
    index=$((index + 1))
  done
)

_review_submodule_is_registered() {
  local common=$1 destination=$2 manifest=$3 scan field found=1
  IFS= read -r -d '' scan < <(_review_submodule_temp worktrees) || return 2
  if ! _review_submodule_git --git-dir="$common" worktree list --porcelain -z > "$scan"; then
    rm -f -- "$scan"
    return 2
  fi
  while IFS= read -r -d '' field; do
    [ "$field" = "worktree $destination" ] || continue
    found=0
    break
  done < "$scan"
  rm -f -- "$scan"
  return "$found"
}

# review_cleanup_submodules <manifest>
review_cleanup_submodules() (
  local requested_manifest=$1 manifest index destination common actual registered status=0
  local -a _review_submodule_manifest_sources=() _review_submodule_manifest_commons=()
  local -a _review_submodule_manifest_destinations=() _review_submodule_manifest_oids=()
  _review_submodule_split_manifest_path "$requested_manifest" || return 1
  manifest=$_review_submodule_manifest_path
  [ -e "$manifest" ] || [ -L "$manifest" ] || return 0
  _review_submodule_load_manifest "$manifest" || {
    echo 'devkit review: refusing cleanup from a malformed submodule manifest.' >&2
    return 1
  }
  index=$((${#_review_submodule_manifest_destinations[@]} - 1))
  while [ "$index" -ge 0 ]; do
    destination=${_review_submodule_manifest_destinations[$index]}
    common=${_review_submodule_manifest_commons[$index]}
    _review_submodule_is_registered "$common" "$destination" "$manifest"
    registered=$?
    if [ "$registered" -eq 1 ]; then
      if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
        index=$((index - 1))
        continue
      fi
      if [ -d "$destination" ] && [ ! -L "$destination" ] && rmdir -- "$destination" 2>/dev/null; then
        index=$((index - 1))
        continue
      fi
    fi
    if [ "$registered" -ne 0 ]; then
      printf 'devkit review: could not validate submodule worktree registration: %q\n' \
        "$destination" >&2
      status=1
      index=$((index - 1))
      continue
    fi
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      if [ ! -d "$destination" ] || [ -L "$destination" ]; then
        printf 'devkit review: refusing to remove an unexpected submodule path: %q\n' \
          "$destination" >&2
        status=1
        index=$((index - 1))
        continue
      fi
      IFS= read -r -d '' actual < <(
        _review_submodule_git_line -C "$destination" rev-parse --path-format=absolute --git-common-dir
      ) || actual=
      if [ -n "$actual" ]; then
        IFS= read -r -d '' actual < <(_review_submodule_physical_dir "$actual") || actual=
      fi
      if [ "$actual" != "$common" ]; then
        printf 'devkit review: refusing to remove a submodule with changed identity: %q\n' \
          "$destination" >&2
        status=1
        index=$((index - 1))
        continue
      fi
    fi
    _review_submodule_git --git-dir="$common" worktree remove --force --force "$destination" || \
      status=1
    index=$((index - 1))
  done
  if [ "$status" -eq 0 ]; then
    rm -f -- "$manifest" || return 1
  fi
  return "$status"
)
