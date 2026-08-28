#!/usr/bin/env bash
# The record a ship leaves so a LATER ship can identify what it left behind.
#
# WHY (sc-2159): a ship that dies by SIGKILL never runs its EXIT trap, so its ephemeral worktree and
# branch survive and the next attempt refuses with a message about commit topology -- for a problem
# that is really "a dead process left a lock behind". Nothing on disk said which process owned that
# worktree or whether it was still alive, so the only safe answer was to refuse and make a human
# clean up. This file supplies the missing fact.
#
# WHERE it lives: inside the worktree's git ADMIN dir (<common>/worktrees/<id>/devkit-ship-run), not
# inside the worktree. Three reasons, in order of weight:
#   1. It outlives the worktree DIRECTORY. A reaped TMPDIR leaves the admin dir intact, so an entry
#      whose files are gone is still attributable -- exactly the case where an in-worktree file would
#      have vanished and we would have to fail closed.
#   2. `git worktree remove` and `git worktree prune` delete it for free. A sibling file in TMPDIR
#      would need its own rm on every exit path, including the two that deliberately return early.
#   3. It cannot reach a commit or be swept. The gate chain runs arbitrary consumer tooling for
#      minutes; a `git add -A` or `git clean -fdx` in there would otherwise eat it, and
#      ship_assert_commit_scope bounds unbriefed DELETIONS, not unbriefed additions -- so a leaked
#      record would have shipped silently rather than aborting.
#
# FORMAT: append-only `key=value`, last wins. Appending (never rewriting) means there is no
# truncate window a concurrent reader can catch mid-update, and a torn final line is dropped because
# ship_run_record_get anchors its match on `<key>=` and takes the LAST non-empty hit -- a half-written
# key matches nothing. The first write is built in a temp file and mv'd, atomic within one directory.
#
# Load-bearing keys: branch, pid, identity, base, branch_created, keep. The rest are diagnostics.
#   base           the sha this worktree was cut from -- cleanup()'s own `tip = $BASE` test, frozen
#                  by the run that knew its own BASE. It is what lets the preflight decide whether a
#                  commit landed WITHOUT resolving this run's BASE, which happens much later.
#   branch_created 1 only when this run created the branch. A resume attaches to somebody else's
#                  branch and must never license deleting it.
#   gate_pid       the gate supervisor's pid, appended once it exists. sc-2159's literal shape is
#                  "the shell died but its detached gate tree kept running", so the SHELL's pid alone
#                  would read as dead and license removing a worktree live reviewers are cwd'd into.

# ship_run_identity <pid>
# A start-time-qualified name for a pid, empty when unavailable.
#
# WHY not `kill -0`: it answers 1 for EPERM as well as ESRCH (another user's ship reads as dead), and
# it says nothing about pid REUSE -- the recycled-pid problem process-table.mts already solved on the
# node side with this same `lstart` column.
#
# WHY LC_ALL/TZ are pinned: `ps -o lstart=` is locale- AND timezone-formatted. Measured on macOS, one
# live process reports "Wed Aug 26 14:18:10 2026" under LC_ALL=C, "Mi. 26 Aug. 14:18:10 2026" under
# de_DE, and a different hour under TZ=America/New_York. An agent harness and an interactive shell
# routinely differ here, and an unpinned identity would read MISMATCH for a process that is very much
# alive -- licensing a force-remove of a running ship's worktree. Writer and reader share this one
# function so they cannot drift. The sed squeezes the padding macOS pads lstart with.
ship_run_identity() {
  # `|| true`: an exited pid makes ps non-zero, and every caller runs under `set -o pipefail`.
  { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null |
    sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ *$//'; } || true
}

# ship_run_process_state <pid>
# The `ps` state field, empty when the pid is absent. A leading `T` means STOPPED, which is what a
# backgrounded ship suspended by SIGTTIN looks like -- worth naming, because it presents as a hang.
ship_run_process_state() {
  { LC_ALL=C ps -o stat= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'; } || true
}

# ship_run_pid_present <pid>
# Presence only. Prefer `ps` over `kill -0` for the EPERM reason above; `kill -0` remains the
# fallback for a `ps` that cannot select by pid.
ship_run_pid_present() {
  # Reject anything that is not a POSITIVE integer before probing. POSIX gives 0 and negatives
  # special meaning in kill(2) -- 0 targets the caller's own process group and -1 every process the
  # caller may signal -- so `kill -0` SUCCEEDS for both and would report a bogus record's owner as
  # alive forever, leaving its orphan permanently unreclaimable and ship refusing every retry. `ps`
  # alone would be safe here, but the kill fallback below exists precisely for a `ps` that cannot
  # select by pid, so the guard has to sit in front of both.
  case "${1:-}" in
    '' | 0 | *[!0-9]*) return 1 ;;
  esac
  ps -p "$1" -o pid= >/dev/null 2>&1 && return 0
  kill -0 "$1" 2>/dev/null
}

# ship_run_admin_dir <worktree>
# The admin dir of a worktree that EXISTS. The preflight resolves absent ones through
# worktree_registry_admin_dir instead.
ship_run_admin_dir() {
  git -C "$1" rev-parse --absolute-git-dir 2>/dev/null
}

# ship_run_record_path <worktree>
ship_run_record_path() {
  local admin
  admin=$(ship_run_admin_dir "$1") || return 1
  [ -n "$admin" ] || return 1
  printf '%s\n' "$admin/devkit-ship-run"
}

# ship_run_record_begin <worktree> <branch> <base> <branch_created> <mode>
# Sets SHIP_RUN_RECORD so later appends (and gate-signal-handoff.sh) can find it. Best effort by
# design: a repo layout that yields no admin dir must not fail the ship, it just forfeits
# attribution, and the preflight already treats "no record" as "never touch this".
ship_run_record_begin() {
  local wt=$1 branch=$2 base=$3 created=$4 mode=$5 path tmp
  path=$(ship_run_record_path "$wt") || return 0
  tmp="$path.tmp.$$"
  {
    echo "v=1"
    echo "branch=$branch"
    echo "wt=$wt"
    echo "pid=$$"
    echo "identity=$(ship_run_identity $$)"
    echo "ppid=$PPID"
    echo "base=$base"
    echo "branch_created=$created"
    echo "mode=$mode"
    echo "started=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)"
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 0; }
  mv "$tmp" "$path" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 0; }
  # Deliberately NOT exported. gate-signal-handoff.sh is sourced into this same shell, so it sees the
  # variable — but a nested `devkit review` would inherit an exported one into a shell that never
  # sourced this file, and its `ship_run_record_append` guard would then fire on a function that does
  # not exist. Visible where it is needed, invisible where it would break.
  SHIP_RUN_RECORD=$path
  return 0
}

# ship_run_record_append <key> <value>
ship_run_record_append() {
  [ -n "${SHIP_RUN_RECORD:-}" ] || return 0
  [ -f "$SHIP_RUN_RECORD" ] || return 0
  printf '%s=%s\n' "$1" "$2" >> "$SHIP_RUN_RECORD" 2>/dev/null || true
  return 0
}

# ship_run_record_get <record-path> <key>
# Last value wins, matching the append-only write order. The `^[a-z_]*=` filter is what drops a torn
# final line, so a reader can never act on half a value.
ship_run_record_get() {
  [ -f "$1" ] || return 1
  { sed -n "s/^$2=//p" "$1" 2>/dev/null | grep -v '^$' | tail -n 1; } || true
  return 0
}

# ship_run_keep <reason>
# Marks the worktree as deliberately preserved: sets KEEP_WT for cleanup() AND records the fact for
# the next run's preflight.
#
# WHY recorded HERE and not in cleanup(): a SIGKILL between the staged-set abort and the EXIT trap
# would lose a cleanup()-written marker -- and those aborts are precisely the states where the
# clobbered index IS the evidence. Writing it at the decision point means the marker is an
# affirmative statement made by a live, orderly process; its ABSENCE is what licenses reclamation,
# and no kill can manufacture its presence.
ship_run_keep() {
  KEEP_WT=1
  ship_run_record_append keep 1
  ship_run_record_append keep_reason "$1"
}
