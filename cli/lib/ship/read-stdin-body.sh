#!/usr/bin/env bash
# Sourced by ship-branch.sh + reship.sh. Read an optional textual PR body without letting an
# inherited, open-but-idle pipe block the ship forever (common for backgrounded agent shell tasks).

ship_read_stdin_body() {
  local timeout=${SHIP_STDIN_TIMEOUT_SECONDS:-1}
  local body_file timeout_marker cat_pid watchdog_pid status

  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || {
    echo "invalid SHIP_STDIN_TIMEOUT_SECONDS: '$timeout' (expected positive whole seconds)" >&2
    return 1
  }

  body_file=$(mktemp "${TMPDIR:-/tmp}/ship-body.XXXXXX")
  timeout_marker="${body_file}.timeout"

  # The explicit <&0 matters: without it, a background command in a non-interactive shell may get
  # /dev/null instead of the caller's stdin. The watchdog bounds the complete read, not just its first
  # byte, and the marker distinguishes its TERM from a genuine cat/read failure.
  cat <&0 > "$body_file" &
  cat_pid=$!
  (
    sleep "$timeout"
    if kill -0 "$cat_pid" 2>/dev/null; then
      : > "$timeout_marker"
      kill -TERM "$cat_pid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid=$!

  if wait "$cat_pid"; then status=0; else status=$?; fi
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  if [ -e "$timeout_marker" ]; then
    rm -f "$body_file" "$timeout_marker"
    echo "stdin stayed open without completing a PR body within ${timeout}s" >&2
    echo "  pass --body \"<text>\", pipe a body that closes stdin, or redirect stdin from /dev/null" >&2
    return 1
  fi
  rm -f "$timeout_marker"

  if [ "$status" -ne 0 ]; then
    rm -f "$body_file"
    echo "could not read PR body from stdin (cat exit $status)" >&2
    return 1
  fi

  # Bash's file command substitution preserves BODY=$(cat)'s trailing-newline stripping.
  BODY=$(<"$body_file")
  rm -f "$body_file"
}
