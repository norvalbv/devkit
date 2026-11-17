#!/usr/bin/env bash
# The preflight timeout validation and watchdog. Sourced by review-target.sh.

preflight_timeout_invalid() {
  printf 'devkit review: invalid timeout %s (expected a positive number of seconds).\n' \
    "$PREFLIGHT_TIMEOUT" >&2
  exit 1
}

# ── Setup/teardown hang guard ────────────────────────────────────────────────────────────────────
# The gate chain has been bounded since sc-1199, but SHIP_COMMIT_TIMEOUT is read INSIDE
# run_gates_with_capture and wraps only the gate command. Everything around it — two `git worktree
# add` checkouts, submodule and dependency materialization twice over, the asset runtime, the
# baseline capture, and the teardown that removes the ephemeral worktrees — ran unbounded, and
# nothing bounds this script from outside either (cli/commands/review.mts spawns it with no
# timeout). A wedged setup step hung until a human noticed.
#
# Signals the process GROUP, not $$. Bash defers a trapped signal until the running FOREGROUND
# command returns, and never signals that child — so `kill -TERM $$` against a wedged `git worktree
# add` is a placebo: the trap would not run until the very command being interrupted finished on its
# own. run-packaged-script.mts spawns this script `detached` for precisely this reason ("a dedicated
# process group lets a signal interrupt foreground setup helpers too") and signals -pid; this is the
# same mechanism applied from the inside. When this shell is NOT a group leader (a test running the
# script directly under bash), `-$$` matches no group, ESRCH is tolerated, and the pid fallback runs
# in knowingly degraded form.
#
# Does NOT escalate to SIGKILL. on_exit's teardown deliberately runs in a signal-ignoring subshell so
# worktree removal cannot be interrupted; a KILL would defeat that and strand the ephemeral
# worktrees checked out — strictly worse than the hang it replaces. TERM to the group unwedges the
# foreground child, on_exit takes over, and a wedge that survives even that is reported rather than
# force-killed.
start_preflight_watchdog() {
  [ -z "$PREFLIGHT_WATCHDOG_PID" ] || return 0
  local main=$$
  (
    trap '' HUP INT QUIT TERM
    # A heartbeat write to a stderr whose reader has gone would otherwise SIGPIPE this subshell, and
    # the hang guard would die of its own narration. Ignored, the write fails and `|| :` absorbs it.
    trap '' PIPE
    # Poll rather than one long sleep: this subshell inherits the caller's stderr (its banner has to
    # reach the console), so a single `sleep $PREFLIGHT_TIMEOUT` would hold that pipe open for the
    # whole ceiling if the shell were SIGKILLed — the pipe-holder wedge documented at the top of
    # run-gates-with-capture.sh. Noticing the parent is gone bounds that to one tick. SECONDS is a
    # bash builtin, so the loop costs no subprocess per tick.
    # `-le`, not `-lt`: SECONDS counts wall-clock second BOUNDARIES, so its first increment can land
    # a few milliseconds in. Waiting one boundary longer guarantees the guard never fires EARLY —
    # overshooting a hang ceiling by under a second costs nothing, undershooting it kills live runs.
    SECONDS=0
    next_beat=$PREFLIGHT_HEARTBEAT_SECS
    while [ "$SECONDS" -le "$PREFLIGHT_TIMEOUT_SECS" ]; do
      /bin/sleep 0.25
      kill -0 "$main" 2>/dev/null || exit 0
      # sc-2166: phase lines alone go quiet for as long as one step runs, which on a large repo is
      # tens of minutes — long enough that a caller cannot tell slow from wedged without `ps`. Same
      # line shape as the judge heartbeat. Narration only: every failure is swallowed.
      if [ "$PREFLIGHT_HEARTBEAT_SECS" -gt 0 ] && [ "$SECONDS" -ge "$next_beat" ]; then
        next_beat=$((SECONDS + PREFLIGHT_HEARTBEAT_SECS))
        beat_stage=unknown
        [ ! -f "$PREFLIGHT_STAGE_FILE" ] ||
          IFS= read -r beat_stage < "$PREFLIGHT_STAGE_FILE" 2>/dev/null || beat_stage=unknown
        beat_elapsed=$(( $(date +%s) - STARTED_AT )) 2>/dev/null || beat_elapsed=0
        beat_left=$((PREFLIGHT_TIMEOUT_SECS - SECONDS))
        [ "$beat_left" -ge 0 ] || beat_left=0
        beat_line=$(printf 'devkit review: still running — %s %dm%02ds (ceiling in ≤%dm%02ds) · log: %s' \
          "$beat_stage" "$((beat_elapsed / 60))" "$((beat_elapsed % 60))" \
          "$((beat_left / 60))" "$((beat_left % 60))" "$LOG")
        printf '%s\n' "$beat_line" >> "$LOG" 2>/dev/null || :
        printf '%s\n' "$beat_line" >&2 2>/dev/null || :
      fi
    done
    stage=unknown
    [ ! -f "$PREFLIGHT_STAGE_FILE" ] || IFS= read -r stage < "$PREFLIGHT_STAGE_FILE" || stage=unknown
    # Written BEFORE the signal: on_exit reads this to tell a ceiling apart from a user's Ctrl-C.
    : > "$PREFLIGHT_TIMEOUT_SENTINEL" 2>/dev/null || :
    {
      printf '⏱  devkit review: setup/teardown hit the %ss ceiling DURING: %s\n' \
        "$PREFLIGHT_TIMEOUT" "$stage"
      printf '   No gate verdict was reached. Raise DEVKIT_PREFLIGHT_TIMEOUT, or investigate a wedged setup step. Full log: %s\n' \
        "$LOG"
    } | tee -a "$LOG" >&2 || :
    kill -TERM -"$main" 2>/dev/null || kill -TERM "$main" 2>/dev/null || :
    # Report an unkillable wedge instead of forcing it; teardown is mid-flight and must finish.
    SECONDS=0
    while kill -0 "$main" 2>/dev/null; do
      if [ "$SECONDS" -ge 60 ]; then
        printf '   devkit review: still running 60s after the ceiling; teardown may be wedged (pid %s).\n' \
          "$main" | tee -a "$LOG" >&2 || :
        break
      fi
      /bin/sleep 0.25
    done
  ) >/dev/null &
  PREFLIGHT_WATCHDOG_PID=$!
}

# KILL, not TERM. The watchdog IGNORES TERM by design — it sits in the process group it signals, and
# a self-inflicted TERM would kill it before it could report an unkillable wedge. That makes TERM
# useless for retiring it: the `wait` below would block until the ceiling elapsed on its own, hanging
# every single run at the pre-gate handover for up to an hour. Nothing in the watchdog needs an
# orderly shutdown — it owns no state and its only fd is the stderr it inherited — so an
# uncatchable signal is exactly right.
#
# Idempotent, and safe while `set -e` is armed: `wait` on a killed child returns non-zero and `kill`
# on an already-reaped pid fails, either of which would otherwise abort the script at the pre-gate
# stop point, which sits outside on_exit's `set +e`. Same shape as the tee teardown in
# run-gates-with-capture.sh.
stop_preflight_watchdog() {
  [ -n "$PREFLIGHT_WATCHDOG_PID" ] || return 0
  kill -KILL "$PREFLIGHT_WATCHDOG_PID" 2>/dev/null || :
  wait "$PREFLIGHT_WATCHDOG_PID" 2>/dev/null || :
  PREFLIGHT_WATCHDOG_PID=
}
