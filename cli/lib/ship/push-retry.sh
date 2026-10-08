#!/usr/bin/env bash
# Sourced by ship-branch.sh and reship.sh: push one gated commit, retrying only GitHub-side transient
# failures. The caller sets SCRIPT_DIR.

# True when a push's stderr carries a server-side transient failure. Anchored so pre-push hook output
# that merely mentions one of these phrases never earns a retry.
ship_push_transient() {
  grep -Eq '^ ! \[remote rejected\] .*\(([^)]*(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)|5[0-9][0-9][^)]*)\)$|^(fatal|error): .*(The requested URL returned error: 5[0-9][0-9]|the remote end hung up unexpectedly|early EOF)' "$1"
}

# usage: ship_push_with_retry <worktree> <sha> <branch> <git push args...>
# A failed push whose remote head is already <sha> counts as landed: only the response was lost.
ship_push_with_retry() {
  local wt=$1 sha=$2 br=$3 err attempt=1 rc remote
  local attempts=${DEVKIT_PUSH_ATTEMPTS:-4} delay=${DEVKIT_PUSH_RETRY_DELAY:-10}
  local supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mjs"
  shift 3
  err=$(mktemp)
  while :; do
    rc=0
    DEVKIT_SHIP_PREPUSH_SKIP_SHA="$sha" git -C "$wt" push "$@" 2>"$err" || rc=$?
    cat "$err" >&2
    [ "$rc" -ne 0 ] || break
    remote=$(node "$supervisor" 60 -- git -C "$wt" ls-remote --heads origin "refs/heads/$br" 2>/dev/null | awk 'NR == 1 { print $1 }') || remote=
    if [ "$remote" = "$sha" ]; then
      echo "push response failed after origin accepted ${sha:0:7}; continuing" >&2
      rc=0; break
    fi
    if [ "$attempt" -ge "$attempts" ] || ! ship_push_transient "$err"; then break; fi
    echo "push attempt $attempt/$attempts hit a transient GitHub error; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1)); delay=$((delay * 3))
  done
  rm -f "$err"
  return "$rc"
}
