#!/usr/bin/env bash
# Shell-word quoting and the dry-gates command line for commit-with-gate-capture.sh. Sourced by it.

# A shell word a reader can paste: bare when nothing in it is special to a shell, else single-quoted.
_ship_sh_word() {
  if [[ "$1" =~ ^[A-Za-z0-9@%+=:,./_-]+$ ]]; then printf '%s' "$1"; return 0; fi
  # Parameter expansion, not $(sed …): command substitution would strip a trailing newline.
  local q="'\\''"
  printf "'%s'" "${1//\'/$q}"
}

# `devkit ship <br> "<title>" --dry-gates …` for the invocation this attempt ran. Reads the caller's
# BASE_FLAG / LINK_EXTRA / PATHS (set by ship-branch.sh, also on resume) by dynamic scope, defaulted because
# run-gates-with-capture.sh sources this file without them. Branch-source membership is derived, so
# that mode takes --from-branch instead of a path list.
_ship_dry_gates_command() {
  local cmd p
  cmd="devkit ship $(_ship_sh_word "$1") $(_ship_sh_word "${2:-<title>}") --dry-gates"
  [ -z "${BASE_FLAG:-}" ] || cmd+=" --base $(_ship_sh_word "$BASE_FLAG")"
  for p in ${LINK_EXTRA[@]+"${LINK_EXTRA[@]}"}; do cmd+=" --link $(_ship_sh_word "$p")"; done
  if [ "${DEVKIT_SHIP_FROM_BRANCH:-0}" = 1 ]; then
    cmd+=" --from-branch"
  elif [ -n "${PATHS[*]+x}" ] && [ "${#PATHS[@]}" -gt 0 ]; then
    cmd+=" --"
    for p in "${PATHS[@]}"; do cmd+=" $(_ship_sh_word "$p")"; done
  else
    cmd+=" -- <paths>"
  fi
  printf '%s\n' "$cmd"
}

# Narrates which paths the gates were briefed on after a gate verdict; the caller sends it to stderr.
_ship_print_path_brief() {
  local brief_n=0 brief_list="" brief_p brief_base
  brief_base="${BASE:-}"
  for brief_p in ${PATHS[@]+"${PATHS[@]}"}; do
    brief_n=$((brief_n + 1))
    [ "$brief_n" -gt 5 ] || brief_list="${brief_list:+$brief_list }$(printf '%q' "$brief_p")"
  done
  [ "$brief_n" -le 5 ] || brief_list="$brief_list (+$((brief_n - 5)) more)"
  if [ "$brief_n" -gt 0 ]; then
    echo "ship: the gates judged $brief_n briefed path(s): $brief_list"
    echo "      every OTHER file in the gate worktree is at base ${brief_base:0:7} — a finding naming one of those read the BASE copy, not yours."
    # Only a RESUME has a full listing above to point at, and only it needs one — a first
    # attempt's brief is the argv the caller just typed. Deliberately no `.devkit/ship-intent-*`
    # glob as a fallback: one record exists PER BRANCH, and parallel agents shipping different
    # branches from one checkout is devkit's normal case, so a wildcard would concatenate
    # another branch's paths into the answer this line exists to make trustworthy.
    [ "${DEVKIT_SHIP_RESUMED:-0}" != "1" ] ||
      echo "      Full brief: the 'Resuming recorded invocation' listing above."
  fi
  # Last line on purpose: the preflight printed this at the top, and a blocked ship is read by tailing.
  [ -z "${SHIP_JUDGE_REMEDY:-}" ] ||
    echo "ship: the judge preflight found a dark judge — every uncached reviewer will fail closed on the retry. $SHIP_JUDGE_REMEDY"
}

# Prints the base-attribution line for a failed config extraGates command; <log> and <ship-log> are
# the capture logs it is appended to. Reads nothing else from the caller.
_ship_base_attribution_note() {
  local wt=$1 log=$2 ship_log=$3 base_tool base_text=""
  base_tool="$(dirname "${BASH_SOURCE[0]}")/../digest/base-attribution.mts"
  [ -f "$base_tool" ] || base_tool="$(dirname "${BASH_SOURCE[0]}")/../digest/base-attribution.mjs"
  if [ -f "$base_tool" ]; then
    base_text="$(node "$base_tool" "$wt" "${ship_log%.log}" 2>/dev/null)" || base_text=""
  fi
  [ -z "$base_text" ] || printf '%s\n' "$base_text" | tee -a "$log" "$ship_log" >&2 2>/dev/null || true
}
