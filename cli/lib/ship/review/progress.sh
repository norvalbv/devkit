#!/usr/bin/env bash
# Setup/teardown progress primitives for review-target.sh (sc-2166), also sourced by hermetic tests.
# No side effects until a function is called.

# Heartbeat seconds: 0..2147483 (0 disables), else 45. Digits are counted BEFORE any arithmetic, as
# bash silently wraps an over-long integer (2^64 becomes 0) and would disable narration by accident.
review_heartbeat_interval() {
  local raw=${1-} digits
  case $raw in
    '' | *[!0-9]*) printf '45\n'; return 0 ;;
  esac
  digits=${raw#"${raw%%[!0]*}"}
  [ -n "$digits" ] || { printf '0\n'; return 0; }
  if [ "${#digits}" -gt 7 ] || [ "$digits" -gt 2147483 ]; then
    printf '45\n'
  else
    printf '%s\n' "$digits"
  fi
}

# Replace the stage file by rename, never by truncate-then-write: the hang guard reads it from
# another process, and a read landing between the two would report the step as `unknown`.
review_write_stage() {
  local file=$1 stage=$2
  printf '%s\n' "$stage" > "$file.$$.tmp" 2>/dev/null &&
    mv -f -- "$file.$$.tmp" "$file" 2>/dev/null || rm -f -- "$file.$$.tmp" 2>/dev/null || :
}
