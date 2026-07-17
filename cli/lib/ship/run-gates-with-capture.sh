#!/usr/bin/env bash
# Shared strict gate runner for ship/reship/review. Streams + captures output, preserves the child
# exit status, bounds the complete chain, and attributes a timeout to unfinished reviewers.

# run_gates_with_capture <worktree> <root> <label> <log> <progress> -- <command...>
run_gates_with_capture() {
  local _wt=$1 _root=$2 label=$3 log=$4 progress=$5
  shift 5
  [ "${1:-}" = "--" ] && shift
  local cmd=("$@")
  local logs=("$log")
  [ -n "${DEVKIT_GATE_ARCHIVE_LOG:-}" ] && logs+=("$DEVKIT_GATE_ARCHIVE_LOG")

  local progress_reader="$(dirname "${BASH_SOURCE[0]}")/../../../gate-engine/review/progress.mts"
  [ -f "$progress_reader" ] || progress_reader="$(dirname "${BASH_SOURCE[0]}")/../../../gate-engine/review/progress.mjs"
  mkdir -p "$(dirname "$log")" "$(dirname "$progress")"
  [ -n "${DEVKIT_GATE_ARCHIVE_LOG:-}" ] && mkdir -p "$(dirname "$DEVKIT_GATE_ARCHIVE_LOG")"
  rm -f "$progress"

  # DEVKIT_SHIP arms the deterministic-prefix cache and overlay sentinel. The invariant it names is
  # also true for review: ephemeral working tree == synthetic index. GUARD_AI_STRICT makes a dark AI
  # gate block. DEVKIT_REVIEW_PROGRESS is the structured timeout/checkpoint channel.
  export DEVKIT_SHIP=1 GUARD_AI_STRICT=1 DEVKIT_REVIEW_PROGRESS="$progress"

  local secs=${SHIP_COMMIT_TIMEOUT:-3600}
  local to_bin to=()
  to_bin=$(command -v timeout || command -v gtimeout || true)
  if [ -n "$to_bin" ]; then
    to=("$to_bin" -k 10 "$secs")
  else
    echo "$label: no timeout/gtimeout on PATH — gate-hang protection disabled (brew install coreutils to enable)" >&2
  fi

  set +e
  ${to[@]+"${to[@]}"} "${cmd[@]}" 2>&1 | tee "${logs[@]}" >&2
  local statuses=("${PIPESTATUS[@]}")
  local rc=${statuses[0]}
  if [ "$rc" -eq 0 ] && [ "${statuses[1]:-1}" -ne 0 ]; then
    echo "$label: could not persist gate output to $log" >&2
    rc=1
  fi
  set -e

  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
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
