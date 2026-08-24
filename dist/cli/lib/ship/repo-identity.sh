#!/bin/sh
# Repo identity for ship telemetry (sc-2000): the origin REMOTE's name, else the MAIN checkout's
# dirname via git-common-dir, else the directory basename. Ships launched from temp git worktrees
# ('worktree', throwaway clones) otherwise stamp a meaningless temp name as the repo — 350/3,317
# recent attempts landed in unattributable buckets the dashboard refuses to guess about.
# Usage: devkit_repo_identity <checkout-root>  → echoes the name (always non-empty for a dir).
devkit_repo_identity() {
  _dri_root="$1"
  _dri_name="$(git -C "$_dri_root" remote get-url origin 2>/dev/null | sed -E 's#/+$##; s#\.git$##; s#.*[/:]##')"
  if [ -z "$_dri_name" ]; then
    _dri_common="$(git -C "$_dri_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
    [ -n "$_dri_common" ] && _dri_name="$(basename "$(dirname "$_dri_common")")"
  fi
  [ -n "$_dri_name" ] || _dri_name="$(basename "$_dri_root")"
  printf '%s\n' "$_dri_name"
}
