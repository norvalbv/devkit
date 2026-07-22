#!/usr/bin/env bash
# Positional-argument guard for ship-branch.sh (new-ship) and reship.sh (--pr).
#
# WHY: both scripts read `BR=${1:?branch}; TITLE=${2:?title}` before their flag loop, so a caller who
# writes the flags first — `ship --base 0.0.9 <branch> "<title>"` — silently binds BR="--base" and
# TITLE="0.0.9". Nothing rejects that. The run continues for another ~180 lines and dies inside an
# internal git call with `error: unknown option 'base'` plus a 40-line `git branch` usage dump,
# exit 255 — output that names neither the flag order nor the two arguments actually at fault.
#
# This is not hypothetical, and it is not a reading-comprehension failure: across six recorded agent
# sessions, five wrote the flags-first form, and they did so AFTER reading `devkit help ship`. The
# help renders the flags as `[--base <b>]` — bracketed, hence apparently free-floating — and the
# using-devkit skill's own table showed the flags-first spelling. reship.sh hit the same class from
# the other direction and carries the scar at its :18-25 (`--pr` bound to BR, and the run died at
# `no remote branch origin/--pr to re-push to`). Documentation has now failed at this three separate
# times, so the check belongs in the script, where it cannot be misread.
#
# Deliberately matches only the four KNOWN flags rather than a blanket `-*`: a title may legitimately
# begin with a dash, and rejecting that would trade this footgun for a different one.

# ship_assert_positional_args <branch> <title> <usage-line>
ship_assert_positional_args() {
  local usage=$3 arg
  for arg in "$1" "$2"; do
    case "$arg" in
      --base|--link|--body|--pr)
        {
          echo "<branch> and \"<title>\" must come FIRST, before any flag — got '$arg' in a positional slot."
          echo "  $usage"
        } >&2
        return 1
        ;;
    esac
  done
}
