#!/usr/bin/env bash
# Which hook chain a gate worktree runs. Sourced by prepare-gate-worktree.sh.

# core.hooksPath as a gate worktree must read it: an absolute value inside a checkout of this repo
# becomes that checkout's relative path, so ship runs the shipped branch's own committed hook.
#
# Overlay and external values pass through. Prints nothing and fails when the resolver cannot run.
gate_hooks_path_value() {
  local dir=$1 value=$2 emitter
  case $value in /*) ;; *) printf '%s\n' "$value"; return 0 ;; esac
  emitter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hooks-path-rel.mts"
  [ -f "$emitter" ] || emitter="${emitter%.mts}.mjs"
  node "$emitter" "$dir" "$value" && return 0
  echo "ship: could not resolve core.hooksPath $value against this repo's checkouts (gates must not fail open)" >&2
  return 1
}

# core.hooksPath as git reads it, `~` expanded. Fails when git cannot expand it: `git commit` dies
# there, while ship's own `-c core.hooksPath` override would quietly fall back to another hook.
gate_read_hooks_path() {
  local out rc=0
  if [ "${2:-}" = inherited ]; then
    out=$(git -C "$1" config --show-scope --type=path --get-all core.hooksPath 2>/dev/null) || rc=$?
  else
    out=$(git -C "$1" config --type=path --get core.hooksPath 2>/dev/null) || rc=$?
  fi
  if [ "$rc" -gt 1 ]; then
    echo "ship: git cannot read core.hooksPath in $1 (gates must not fail open)" >&2
    return 1
  fi
  [ "${2:-}" != inherited ] || out=$(printf '%s\n' "$out" |
    awk -F'\t' '$1 != "worktree" { v = substr($0, length($1) + 2) } END { print v }')
  printf '%s\n' "$out"
}

# The pre-commit hook ship will run in the ephemeral worktree, shared by preparation and commit.
# Overlay wins when projected; then core.hooksPath; unset falls back to `.husky/_`, then git's own.
#
# A non-executable candidate is returned on purpose: callers fail closed naming the path.
gate_worktree_pre_commit() {
  local wt=$1 root=${2:-} hooks_path default_hooks_dir
  if [ -n "$root" ] && [ -x "$(gate_overlay_root "$root")/.devkit/hooks/pre-commit" ]; then
    printf '%s\n' "$wt/.devkit/hooks/pre-commit"
    return 0
  fi
  hooks_path=$(gate_read_hooks_path "$wt") || return 0
  hooks_path=$(gate_hooks_path_value "$wt" "$hooks_path") || return 0
  if [ -z "$hooks_path" ]; then
    if [ -e "$wt/.husky/_/pre-commit" ] || [ -L "$wt/.husky/_/pre-commit" ]; then
      printf '%s\n' "$wt/.husky/_/pre-commit"
      return 0
    fi
    default_hooks_dir=$(git -C "$wt" rev-parse --git-path hooks 2>/dev/null) || default_hooks_dir=''
    [ -n "$default_hooks_dir" ] || return 0
    case $default_hooks_dir in
      /*) printf '%s\n' "$default_hooks_dir/pre-commit" ;;
      *) printf '%s\n' "$wt/$default_hooks_dir/pre-commit" ;;
    esac
    return 0
  fi
  case $hooks_path in
    /*) printf '%s\n' "$hooks_path/pre-commit" ;;
    *) printf '%s\n' "$wt/$hooks_path/pre-commit" ;;
  esac
}

# The hook dir git uses, relative to the checkout <dir>; empty for an external absolute dir, which is
# never projected. Standalone points at the committed `.husky`, package-mode at its ignored `.husky/_`.
#
# Unset falls back to `.husky/_` so the install preflight stays fail-closed.
# `inherited` answers for a worktree not yet created: every scope EXCEPT <dir>'s own config.worktree.
gate_hook_link_rel() {
  local hooks_path
  hooks_path=$(gate_read_hooks_path "$1" "${2:-}") || return 1
  hooks_path=$(gate_hooks_path_value "$1" "$hooks_path") || return 1
  if [ -z "$hooks_path" ]; then
    printf '%s\n' .husky/_
  elif [[ "$hooks_path" != /* ]]; then
    printf '%s\n' "$hooks_path"
  fi
}
