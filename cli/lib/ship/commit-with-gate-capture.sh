#!/usr/bin/env bash
# Shared by ship-branch.sh (new-ship) and reship.sh (--pr): run the worktree commit so the pre-commit
# gate output is BOTH streamed to the caller AND captured to a per-branch log, while preserving the
# commit's real exit code.
#
# Why: git routes every hook's stdout+stderr to the commit command's STDERR, interleaved with ship
# ceremony and easily truncated by an agent's tool output — so a shipping agent doesn't reliably see
# the gate verdicts a normal `git commit` shows. The log is the full, untruncated record; a compact
# status line points the agent at it.
#
# Mechanics: `2>&1 | tee "$log" >&2` — fold the gate output (which is on stderr) into the stream BEFORE
# tee, capture it to the log, and send tee's copy to STDERR (never stdout — the PR URL must stay the
# caller's last stdout line). `${PIPESTATUS[0]}` preserves the commit's real exit code under
# `set -euo pipefail`, guarded by a `set +e`/`set -e` island so a blocking gate doesn't abort before
# we read it; the non-zero return then lets the caller's `set -e` abort + its cleanup trap drop the
# empty branch (unchanged failure semantics, plus visibility).
#
# R2 (sc-1002): bound the commit so a HUNG gate can't wedge a shipping AGENT forever. A pre-commit gate
# that never returns (a wedged `claude -p` judge / `bunx` toolchain) — or any child it backgrounds that
# inherits git's stdout — would otherwise keep `git commit` AND the `tee` pipe blocked, with no human to
# Ctrl-C. We wrap the commit in coreutils `timeout`; on expiry its DEFAULT process-group kill reaps the
# hook AND its grandchildren, closing every copy of the pipe write-end so `tee` unblocks and the pipeline
# returns 124. The non-zero rc then flows through the caller's `set -e` + EXIT trap (unchanged failure path).
#
# NEVER add `timeout --foreground`: it signals only the leader (git), leaving a backgrounded pipe-holder
# alive → `tee` blocks forever → the timeout buys nothing. The default group-kill is the whole point.
#
# Portability: macOS ships no `timeout` (it's coreutils `gtimeout`, or absent). With neither on PATH we run
# bare (today's behaviour) and say so once — a silent no-op the operator THINKS protects them is worse.
#
# Usage:  commit_with_gate_capture <worktree> <root> <branch> <title> <body>
commit_with_gate_capture() {
  local wt="$1" root="$2" br="$3" title="$4" body="$5"
  local log="$root/.devkit/last-ship-gates-${br//\//-}.log"
  mkdir -p "$root/.devkit"

  local secs=${SHIP_COMMIT_TIMEOUT:-600}   # a hang CEILING, not a gate budget (coverage isn't gated here)
  local to_bin to=()
  to_bin=$(command -v timeout || command -v gtimeout || true)
  if [ -n "$to_bin" ]; then
    to=("$to_bin" -k 10 "$secs")           # -k 10: SIGKILL escalation for a gate that traps TERM
  else
    echo "ship: no timeout/gtimeout on PATH — gate-hang protection disabled (brew install coreutils to enable)" >&2
  fi

  set +e
  # ${to[@]+"${to[@]}"}: set -u-safe empty-array expansion (a bare "${to[@]}" aborts under stock-macOS
  # bash 3.2). Empty → bare git (degrade); non-empty → `timeout -k 10 <secs> git …`. PIPESTATUS[0] is the
  # timeout/git exit (124 on timeout) through both forms — never tee's.
  ${to[@]+"${to[@]}"} git -C "$wt" commit -m "$title" -m "$body" 2>&1 | tee "$log" >&2
  local rc=${PIPESTATUS[0]}
  set -e

  if [ "$rc" -eq 124 ]; then
    echo "ship: gate chain timed out after ${secs}s — likely a hung gate; the ship worktree is being cleaned up." >&2
  elif [ "$rc" -eq 0 ]; then
    {
      echo "✓ pre-commit gates ran in the ship worktree — full output: $log"
      echo "  Review it for any SKIP / ⚠️ lines (e.g. coverage is NOT gated in the ship worktree)."
    } >&2
  fi
  return "$rc"
}
