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
  # gate block. DEVKIT_REVIEW_PROGRESS is the structured timeout/checkpoint channel.
  export DEVKIT_SHIP=1 GUARD_AI_STRICT=1 DEVKIT_REVIEW_PROGRESS="$progress"

  local secs=${SHIP_COMMIT_TIMEOUT:-3600}
  local rc
  local supervisor="$(dirname "${BASH_SOURCE[0]}")/review/process/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$(dirname "${BASH_SOURCE[0]}")/review/process/gate-supervisor.mjs"
  local capture_dir capture_fifo tee_pid supervisor_pid tee_status job running
  local capture_failed cleanup_status drain_deadline drain_stage ownership_token
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
  tee -a "${logs[@]}" < "$capture_fifo" >&2 &
  tee_pid=$!
  if ! exec 8> "$capture_fifo"; then
    kill "$tee_pid" 2>/dev/null || true
    wait "$tee_pid" 2>/dev/null || true
    rm -rf -- "$capture_dir"
    set -e
    echo "$label: could not open private gate output capture" >&2
    return 1
  fi
  if ! rm -f -- "$capture_fifo"; then
    exec 8>&-
    kill "$tee_pid" 2>/dev/null || true
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
  DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN="$ownership_token" \
    node "$supervisor" "$secs" -- "${cmd[@]}" >&8 2>&1 &
  supervisor_pid=$!
  exec 8>&-
  if declare -F review_gate_started >/dev/null 2>&1; then
    review_gate_started "$supervisor_pid"
  fi

  rc=1
  while :; do
    wait "$supervisor_pid"
    rc=$?
    running=0
    while IFS= read -r job; do
      [ "$job" != "$supervisor_pid" ] || running=1
    done < <(jobs -p)
    [ "$running" -eq 1 ] || break
  done

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

  # Once the supervisor is reaped there is nobody left for an outer signal handoff to target. Give
  # tee five seconds to observe EOF, then TERM/KILL it with one bounded second per signal. This
  # keeps a failed supervisor plus an undiscovered pipe writer from hanging the review shell.
  tee_status=1
  capture_failed=0
  drain_stage=0
  drain_deadline=$((SECONDS + 5))
  while :; do
    running=0
    while IFS= read -r job; do
      [ "$job" != "$tee_pid" ] || running=1
    done < <(jobs -pr; jobs -ps)
    [ "$running" -eq 1 ] || break
    if [ "$SECONDS" -ge "$drain_deadline" ]; then
      case "$drain_stage" in
        0)
          capture_failed=1
          echo "$label: gate output drain exceeded 5s; terminating capture" >&2
          kill -TERM "$tee_pid" 2>/dev/null || true
          ;;
        1) kill -KILL "$tee_pid" 2>/dev/null || true ;;
        2) break ;;
      esac
      drain_stage=$((drain_stage + 1))
      drain_deadline=$((SECONDS + 1))
    fi
    /bin/sleep 0.05
  done
  if [ "$running" -eq 0 ]; then
    wait "$tee_pid"
    tee_status=$?
  else
    capture_failed=1
  fi
  if declare -F review_gate_finished >/dev/null 2>&1; then
    review_gate_finished "$supervisor_pid"
  fi
  rm -rf -- "$capture_dir"
  if [ "$rc" -eq 0 ] && { [ "$tee_status" -ne 0 ] || [ "$capture_failed" -ne 0 ]; }; then
    echo "$label: could not persist gate output to $log" >&2
    rc=1
  fi
  set -e

  # 124 is the supervisor's expiry status and now the ONLY way to reach this banner. It used to also
  # accept 137 off the coreutils path, guarded by mode so a SIGKILLed supervisor wasn't mislabelled;
  # with one mechanism left, 137 unambiguously means the supervisor itself was killed — not a ceiling.
  if [ "$rc" -eq 124 ]; then
    local last_stage unfinished
    last_stage=$(grep -E '^(🎨|📏|🗂|🔁|🧭|🔍|⚡|✗)|^guard-prefix:|[Gg]ate\.\.\.[[:space:]]*$' "$log" 2>/dev/null | tail -1 || true)
    {
      echo "⏱  $label: gate chain hit the ${secs}s ceiling (exit $rc) DURING: ${last_stage:-unknown stage}"
      unfinished=$(node "$progress_reader" unfinished "$progress" 2>/dev/null || true)
      [ -n "$unfinished" ] && echo "   Reviewers with no completion heartbeat (unfinished): $unfinished"
      echo "   Completed reviewer verdicts, cleared decisions judgements and the deterministic prefix are CACHED."
      if [ "$label" = ship ]; then
        echo "   Re-run the same devkit ship command to converge (only unfinished work re-runs)."
      else
        echo "   Re-run the same devkit review command to converge (only unfinished work re-runs)."
      fi
      echo "   More room per attempt: export SHIP_COMMIT_TIMEOUT. Full log: $log"
    } >&2
  fi
  return "$rc"
}
