#!/usr/bin/env bash
# Shared --wait-ci argument validation for ship-branch.sh and reship.sh.
# The floor mirrors MIN_TIMEOUT_S in wait.mts; a test asserts the two agree.

. "$(dirname "${BASH_SOURCE[0]}")/../queue/slot.sh"

SHIP_WAIT_CI_MIN_S=60
SHIP_WAIT_CI_MAX_S=7200
# The caller's exit after the wait: 0, or under WAIT_CI_STRICT=1 a 5 (not passed) or a signal status.
WAIT_CI_STATUS=0

# ship_validate_wait_ci <wait-ci> <timeout> <timeout-was-set> <required> [<dry-gates>]
ship_validate_wait_ci() {
  local wait_ci=$1 timeout=$2 timeout_set=$3 required=$4 dry_gates=${5:-0}
  if [ "$timeout_set" -eq 1 ] && [ "$wait_ci" -eq 0 ]; then
    echo "--wait-ci-timeout has no effect without --wait-ci" >&2; return 1
  fi
  if [ "$required" -eq 1 ] && [ "$wait_ci" -eq 0 ]; then
    echo "--wait-ci-required has no effect without --wait-ci" >&2; return 1
  fi
  if [ "${WAIT_CI_STRICT:-0}" -eq 1 ] && [ "$wait_ci" -eq 0 ]; then
    echo "--wait-ci-strict has no effect without --wait-ci" >&2; return 1
  fi
  if [ "$wait_ci" -eq 1 ] && [ "$dry_gates" -eq 1 ]; then
    echo "--wait-ci waits on a PR's checks, and --dry-gates never opens a PR" >&2; return 1
  fi
  [ "$wait_ci" -eq 1 ] || return 0
  case "$timeout" in *[!0-9]*|'') echo "--wait-ci-timeout must be a whole number of seconds, got '$timeout'" >&2; return 1 ;; esac
  # Below the floor a "this repo has no checks" verdict is unreachable, so a CI-less repo would
  # report a timeout instead of the truth.
  # 10# forces base 10: bash runs these operands through its arithmetic evaluator, so `09000` would
  # read as octal — erroring to false, passing validation, and skipping the wait with no verdict.
  if [ "$((10#$timeout))" -lt "$SHIP_WAIT_CI_MIN_S" ] || [ "$((10#$timeout))" -gt "$SHIP_WAIT_CI_MAX_S" ]; then
    echo "--wait-ci-timeout must be between $SHIP_WAIT_CI_MIN_S and $SHIP_WAIT_CI_MAX_S seconds, got $timeout" >&2
    return 1
  fi
}

# ship_wait_ci_not_run <pr-or-empty> <reason>
# A requested wait ALWAYS produces exactly one ci-outcome line, so a caller grepping for one can tell
# "did not run" from "the ship died before it could".
ship_wait_ci_not_run() {
  echo "ship: ci-outcome=not-run pr=${1:-?} reason=$2" >&2
  [ "${WAIT_CI_STRICT:-0}" -eq 0 ] || WAIT_CI_STATUS=5
}

# ship_run_wait_ci <pr-number> <repo> <timeout> <pr-url> [<required>]
# Runs LAST, after every artifact is durable. Announces the PR first: a signal here exits 130 through
# the managed wrapper whatever bash does, so the abort has to be self-describing before it can happen.
# Always returns 0 and records WAIT_CI_STATUS instead: the callers run under `set -e` with work left.
ship_run_wait_ci() {
  local pr=$1 repo=$2 timeout=$3 url=$4 required=${5:-0} script req='' strict='' rc=0
  ship_queue_slot_release
  if [ -z "$pr" ]; then
    ship_wait_ci_not_run "" pr-number-unresolved
    return 0
  fi
  echo "ship: the PR is open at $url and the ship is complete; waiting on its checks (Ctrl-C is safe)" >&2
  script="$SCRIPT_DIR/wait-ci/wait.mts"; [ -f "$script" ] || script="$SCRIPT_DIR/wait-ci/wait.mjs"
  [ "$required" -eq 0 ] || req=--required
  [ "${WAIT_CI_STRICT:-0}" -eq 0 ] || strict=--strict
  node "$script" --pr "$pr" --repo "$repo" --timeout "$timeout" ${req:+"$req"} ${strict:+"$strict"} || rc=$?
  [ -n "$strict" ] || return 0
  # Only 0 and the documented 130/143 signals survive; a crash or kill must not read as another code.
  case "$rc" in 0|130|143) ;; *) rc=5 ;; esac
  WAIT_CI_STATUS=$rc
  [ "$rc" -ne 5 ] || echo "ship: --wait-ci-strict exits 5 — the PR is open at $url; its CI is not known green. Do NOT --resume." >&2
}
