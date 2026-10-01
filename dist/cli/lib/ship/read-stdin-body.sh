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

# The --resume banner's body clause, naming the body that will SHIP (sc-3411): --body/--body-file
# override the record, so sizing the record alone made an applied fix look like a stale replay.
# Runs in the caller's shell (never $(...)) and sets SHIP_BODY_NOTE. A readable --body-file is read
# HERE, once, into BODY_FILE_PREREAD; the BODY resolution ships those same bytes, so a rewrite of
# the file during the gate run cannot make the banner describe bytes other than the ones shipped.
# A failed pre-read is latched (BODY_FILE_PREREAD_SET=2); the resolution exits 1 on it.
ship_resume_body_note() {
  local recorded n
  recorded=$(printf '%s' "$RESUME_BODY" | wc -c | tr -d ' ')
  if [ "$BODY_SET" -eq 1 ]; then
    n=$(printf '%s' "$BODY_FLAG" | wc -c | tr -d ' ')
    SHIP_BODY_NOTE="body $n bytes (from --body, overriding recorded $recorded)"
  elif [ "$BODY_FILE_SET" -eq 1 ]; then
    # cat + sentinel, as at the resolution: $(<file) would strip every trailing newline.
    if [ -f "$BODY_FILE_FLAG" ] && BODY_FILE_PREREAD=$(cat -- "$BODY_FILE_FLAG" 2>/dev/null && printf x); then
      BODY_FILE_PREREAD=${BODY_FILE_PREREAD%x}
      BODY_FILE_PREREAD_SET=1
      n=$(printf '%s' "$BODY_FILE_PREREAD" | wc -c | tr -d ' ')
      SHIP_BODY_NOTE=$(printf 'body %s bytes (from --body-file %q, overriding recorded %s)' "$n" "$BODY_FILE_FLAG" "$recorded")
    else
      # Latched: the resolution refuses rather than re-reading a file that appears later.
      BODY_FILE_PREREAD_SET=2
      if [ -f "$BODY_FILE_FLAG" ]; then BODY_FILE_PREREAD_ERR=unreadable; else BODY_FILE_PREREAD_ERR="no such file"; fi
      SHIP_BODY_NOTE=$(printf 'body from --body-file %q (missing or unreadable — recorded %s bytes not used)' "$BODY_FILE_FLAG" "$recorded")
    fi
  else
    SHIP_BODY_NOTE="body $recorded bytes"
  fi
}
