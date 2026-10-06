#!/usr/bin/env bash
# Shared strict gate runner for ship/reship/review. Streams + captures output, preserves the child
# exit status, bounds the complete chain, and attributes a timeout to unfinished reviewers.
#
# ONE mechanism for every mode: the gate runs under review/process/gate-supervisor.mts, which owns the
# whole gate as a process GROUP and reaps it — on expiry, on a forwarded signal, and (sc-1199) once the
# leader exits while something in its group still holds the capture pipe. Ship/reship used to take a
# second, weaker path (coreutils `timeout` + a bare `| tee`), whose group-kill fired ONLY on expiry; a
# reviewer that rejected in seconds left its leaked children holding the pipe, `tee` never saw EOF, and
# the ship hung with its ephemeral worktree still checked out. That branch is gone. Consequences:
#   - hang protection no longer depends on coreutils being installed (node + /bin/ps only)
#   - a timeout is exactly 124; 137 now means the SUPERVISOR was SIGKILLed, never "the chain timed out"

# Liveness without the `wait` builtin: bash 5 can reap a child inside an interrupted `wait` and lose
# its status (jobs.c waitchld), so a child is only waited once current-shell `jobs` and the kernel agree.
gate_child_alive() {
  local pid=$1 jobs_file=$2 job listed=0
  { jobs -pr; jobs -ps; } >"$jobs_file"
  while IFS= read -r job; do [ "$job" != "$pid" ] || listed=1; done <"$jobs_file"
  [ "$listed" -eq 1 ] && kill -0 "$pid" 2>/dev/null
}

# Sleeps in a foreground child, so a trapped signal runs between polls instead of interrupting a wait.
gate_child_poll() {
  local started=$SECONDS
  while gate_child_alive "$1" "$2"; do
    if [ $((SECONDS - started)) -lt 2 ]; then /bin/sleep 0.05; else /bin/sleep 0.25; fi
  done
}

# run_gates_with_capture <worktree> <root> <label> <log> <progress> -- <command...>
run_gates_with_capture() {
  local wt=$1 root=$2 label=$3 log=$4 progress=$5
  shift 5
  [ "${1:-}" = "--" ] && shift
  local cmd=("$@")
  local archive_log=${DEVKIT_GATE_ARCHIVE_LOG:-}
  # The capture tees to $log plus the OPTIONAL telemetry archive. $log is load-bearing (a gate whose
  # output we could not persist fails the run, below); the archive is best-effort and must never fail
  # a ship. Since a `tee` that cannot open one of its files exits non-zero, the archive is probed HERE
  # and dropped-with-a-warning rather than handed to tee — otherwise an unwritable telemetry path
  # would sink an otherwise passing commit. Residual, deliberately accepted: an archive write that
  # fails MID-run (disk full) still fails tee and is reported against $log. Strictly narrower than the
  # window this replaces, and the pre-flight covers every failure mode we have seen.
  # APPEND, never truncate: $log may already hold lines the caller wrote before the gates started
  # (devkit review streams its header + per-phase preflight progress there, and a truncating tee
  # erased all of it the instant the chain launched — a run that hung in preflight was then
  # indistinguishable from one that never wrote anything). Freshness is the CALLER's job now:
  # review-target.sh allocates a unique per-run path under `set -C`, and commit-with-gate-capture.sh
  # clears its reused per-branch `last-ship-gates-*.log` before calling in.
  local logs=("$log")
  if [ -n "$archive_log" ]; then
    if mkdir -p "$(dirname "$archive_log")" 2>/dev/null && : >> "$archive_log" 2>/dev/null; then
      logs+=("$archive_log")
    else
      echo "$label: could not archive gate output to $archive_log; continuing" >&2
    fi
  fi

  local progress_reader
  progress_reader="$(dirname "${BASH_SOURCE[0]}")/../../../gate-engine/review/progress.mts"
  [ -f "$progress_reader" ] || progress_reader="$(dirname "${BASH_SOURCE[0]}")/../../../gate-engine/review/progress.mjs"
  mkdir -p "$(dirname "$log")" "$(dirname "$progress")"
  rm -f "$progress"

  # DEVKIT_SHIP arms the deterministic-prefix cache and overlay sentinel. The invariant it names is
  # also true for review: ephemeral working tree == synthetic index. GUARD_AI_STRICT makes a dark AI
  # gate block. DEVKIT_REVIEW_PROGRESS is the structured timeout/checkpoint channel. DEVKIT_GATE_LOG
  # names this chain's $log so a long judge's heartbeat (gate-engine/judge/process/heartbeat.mts, sc-2422)
  # points a poller at the file it is teed into — assigned here, so an outer run's value never wins.
  export DEVKIT_SHIP=1 GUARD_AI_STRICT=1 DEVKIT_REVIEW_PROGRESS="$progress" DEVKIT_GATE_LOG="$log"

  local secs=${SHIP_COMMIT_TIMEOUT:-3600}
  local rc
  local supervisor="$(dirname "${BASH_SOURCE[0]}")/review/process/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$(dirname "${BASH_SOURCE[0]}")/review/process/gate-supervisor.mjs"
  local capture_dir capture_fifo tee_pid supervisor_pid tee_status running
  local capture_failed cleanup_status drain_deadline drain_stage ownership_token gate_started reaped=0
  capture_dir=$(mktemp -d "${TMPDIR:-/tmp}/devkit-review-capture.XXXXXX") || {
    echo "$label: could not create private gate output capture" >&2
    return 1
  }
  capture_fifo="$capture_dir/output"
  if ! (umask 077; mkfifo "$capture_fifo"); then
    rm -rf -- "$capture_dir"
    echo "$label: could not create private gate output capture" >&2
    return 1
  fi
  if ! ownership_token=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"); then
    rm -rf -- "$capture_dir"
    echo "$label: could not create private gate ownership token" >&2
    return 1
  fi

  set +e
  # tee outlives a process-GROUP HUP/TERM (managed CLI, harness kill) so a landed commit keeps its
  # receipt; exec keeps $! and tee's $PPID. Every abandon path below must therefore use KILL.
  (trap '' HUP TERM; exec tee -a "${logs[@]}") < "$capture_fifo" >&2 &
  tee_pid=$!
  if ! exec 8> "$capture_fifo"; then
    kill -KILL "$tee_pid" 2>/dev/null || true
    wait "$tee_pid" 2>/dev/null || true
    rm -rf -- "$capture_dir"
    set -e
    echo "$label: could not open private gate output capture" >&2
    return 1
  fi
  if ! rm -f -- "$capture_fifo"; then
    exec 8>&-
    kill -KILL "$tee_pid" 2>/dev/null || true
    wait "$tee_pid" 2>/dev/null || true
    rm -rf -- "$capture_dir"
    set -e
    echo "$label: could not hide private gate output capture" >&2
    return 1
  fi
  # Let a review caller defer signal cleanup until the supervisor PID is publishable. Without
  # this pre-arm, a signal between background spawn and review_gate_started can make the outer
  # shell exit while the supervisor is still cleaning its detached gate group. Every review_gate_*
  # hook here is optional by design: only review-target.sh defines them, so on a ship/reship they
  # are absent and each call site is a no-op. That is what lets one capture path serve both.
  if declare -F review_gate_launching >/dev/null 2>&1; then
    review_gate_launching
  fi
  # DEVKIT_REVIEW_*: named when review was the only supervised mode; ship/reship use them too now.
  # Left as-is deliberately — the token is the supervisor's process-ownership proof, and churning
  # that contract across the shell and gate-supervisor.mts buys nothing but risk.
  gate_started=$SECONDS
  DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN="$ownership_token" DEVKIT_GATE_REAP_NOTICE_FILE="$capture_dir/reaped" \
    node "$supervisor" "$secs" -- "${cmd[@]}" >&8 2>&1 &
  supervisor_pid=$!
  exec 8>&-
  if declare -F review_gate_started >/dev/null 2>&1; then
    review_gate_started "$supervisor_pid"
  fi

  gate_child_poll "$supervisor_pid" "$capture_dir/jobs"
  wait "$supervisor_pid"
  rc=$?
  # READ IT TWICE (sc-1896): a signal pending as `wait` starts returns 128+signum uncollected. 127 plus a
  # "not a child" diagnostic means the first read already collected it; the supervisor exits 127 too.
  if [ "$rc" -gt 128 ]; then
    local rewait_rc rewait_err="$capture_dir/supervisor-rewait.err"
    wait "$supervisor_pid" 2>"$rewait_err"
    rewait_rc=$?
    if [ "$rewait_rc" -ne 127 ] || [ ! -s "$rewait_err" ]; then
      rc=$rewait_rc
    fi
  fi

  # The ownership token exists in this parent before target launch. A fresh supervisor can adopt
  # and clean the target tree even when the original supervisor was itself killed or crashed.
  DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN="$ownership_token" \
    node "$supervisor" 0.01 -- /bin/sleep 1 >/dev/null 2>&1
  cleanup_status=$?
  if [ "$cleanup_status" -ne 0 ] && [ "$cleanup_status" -ne 124 ]; then
    echo "$label: could not verify cleanup after gate supervisor exit" >&2
    [ "$rc" -ne 0 ] || rc=1
  fi
  if declare -F review_gate_reaped >/dev/null 2>&1; then
    review_gate_reaped "$supervisor_pid"
  fi

  # Give tee five seconds to observe EOF, then KILL it (it ignores HUP/TERM) and allow one more second,
  # so a failed supervisor plus an undiscovered pipe writer cannot hang the review shell.
  tee_status=1
  capture_failed=0
  drain_stage=0
  drain_deadline=$((SECONDS + 5))
  while :; do
    running=0
    if gate_child_alive "$tee_pid" "$capture_dir/jobs"; then running=1; fi
    [ "$running" -eq 1 ] || break
    if [ "$SECONDS" -ge "$drain_deadline" ]; then
      case "$drain_stage" in
        0)
          capture_failed=1
          echo "$label: gate output drain exceeded 5s; terminating capture" >&2
          kill -KILL "$tee_pid" 2>/dev/null || true
          ;;
        1) break ;;
      esac
      drain_stage=$((drain_stage + 1))
      drain_deadline=$((SECONDS + 1))
    fi
    /bin/sleep 0.05
  done
  if [ "$running" -eq 0 ]; then
    wait "$tee_pid"
    tee_status=$?
    # READ IT TWICE (sc-1711): a signal pending as `wait` starts returns 128+signum uncollected. An `if`,
    # never a loop: a tee that really died of a signal reads >128 on every read, so it fails closed.
    if [ "$drain_stage" -eq 0 ] && [ "$tee_status" -gt 128 ]; then
      wait "$tee_pid"
      tee_status=$?
    fi
  else
    capture_failed=1
  fi
  if declare -F review_gate_finished >/dev/null 2>&1; then
    review_gate_finished "$supervisor_pid"
  fi
  [ ! -e "$capture_dir/reaped" ] || reaped=1
  rm -rf -- "$capture_dir"
  if [ "$rc" -eq 0 ] && { [ "$tee_status" -ne 0 ] || [ "$capture_failed" -ne 0 ]; }; then
    echo "$label: could not persist gate output to $log" >&2
    rc=1
  fi
  set -e

  # 124 is the supervisor's status for two causes: the expiry ceiling, or a command that exited 0 while a
  # process it started was still running and had to be reaped. The supervisor marks the second in the
  # private capture dir, where gate output cannot forge it. 137 means the supervisor itself was killed.
  if [ "$rc" -eq 124 ]; then
    local last_stage unfinished
    last_stage=$(grep -E '^(🎨|📏|🗂|🔁|🧭|🔍|⚡)|^guard-prefix:|[Gg]ates?( \([^)]*\))?\.\.\.[[:space:]]*$' "$log" 2>/dev/null | tail -1 || true)
    {
      if [ "$reaped" -eq 1 ]; then
        echo "⏱  $label: the gate chain exited cleanly, but a process it started outlived it and was reaped after $((SECONDS - gate_started))s (exit 124) — NOT the ${secs}s ceiling."
        echo "   Last stage started: ${last_stage:-unknown stage}"
        [ "$label" != ship ] || echo "   The commit may already have landed."
        echo "   Raising SHIP_COMMIT_TIMEOUT will not help."
      else
        echo "⏱  $label: gate chain hit the ${secs}s ceiling (exit $rc) DURING: ${last_stage:-unknown stage}"
        echo "   More room per attempt: export SHIP_COMMIT_TIMEOUT."
      fi
      unfinished=$(node "$progress_reader" unfinished "$progress" 2>/dev/null || true)
      [ -n "$unfinished" ] && echo "   Reviewers with no completion heartbeat (unfinished): $unfinished"
      echo "   Completed reviewer verdicts, cleared decisions judgements and the deterministic prefix are CACHED."
      if [ "$label" = ship ] && [ "${DEVKIT_SHIP_INTENT_RECORDED:-0}" = 1 ]; then
        # A 124 may have landed the commit + minted its receipt, so --resume here rides the
        # landed-commit resume path — the replayed bytes ARE the recorded ones, so it verifies.
        # Gated on the exported recorded flag: advertising --resume for an attempt that was never
        # recorded (ignore rule missing, lock busy) sends the retry into a deterministic refusal.
        echo "   Retry with \`devkit ship --resume ${DEVKIT_SHIP_BRANCH:-<branch>}\` to converge (only unfinished work re-runs)."
      elif [ "$label" = ship ]; then
        echo "   Re-run the same full devkit ship command to converge (this attempt was NOT recorded, so --resume has nothing to replay)."
      else
        echo "   Re-run the same devkit review command to converge (only unfinished work re-runs)."
      fi
      echo "   Full log: $log"
    } >&2
  fi
  return "$rc"
}
