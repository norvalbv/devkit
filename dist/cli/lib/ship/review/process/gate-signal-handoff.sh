#!/usr/bin/env bash
# Signal handoff shared by review-target.sh, ship-branch.sh, and reship.sh while
# run-gates-with-capture.sh owns an active gate supervisor. A signal delivered only to the public
# shell must reach that supervisor; the shell then keeps waiting until the complete reviewer tree is
# reaped before its EXIT trap may remove an ephemeral worktree.

gate_signal_handoff_init() {
  ACTIVE_GATE_PID=
  GATE_LAUNCHING=0
  REQUESTED_SIGNAL_STATUS=0
  REQUESTED_SIGNAL=
  trap 'forward_gate_signal 129 HUP' HUP
  trap 'forward_gate_signal 130 INT' INT
  trap 'forward_gate_signal 131 QUIT' QUIT
  trap 'forward_gate_signal 143 TERM' TERM
}

forward_gate_signal() {
  local status=$1 signal=$2
  REQUESTED_SIGNAL_STATUS=$status
  REQUESTED_SIGNAL=$signal
  if [ -n "$ACTIVE_GATE_PID" ]; then
    kill -s "$signal" "$ACTIVE_GATE_PID" 2>/dev/null || true
    return 0
  fi
  [ "$GATE_LAUNCHING" -eq 0 ] || return 0
  exit "$status"
}

# Optional lifecycle callbacks invoked by run-gates-with-capture.sh. The historical `review_`
# prefix is its public shell-hook contract even when the caller is ship/reship.
review_gate_launching() { GATE_LAUNCHING=1; }
review_gate_started() {
  ACTIVE_GATE_PID=$1
  GATE_LAUNCHING=0
  if [ "$REQUESTED_SIGNAL_STATUS" -ne 0 ]; then
    kill -s "$REQUESTED_SIGNAL" "$ACTIVE_GATE_PID" 2>/dev/null || true
  fi
}
review_gate_reaped() { ACTIVE_GATE_PID=; }
review_gate_finished() { ACTIVE_GATE_PID=; }
