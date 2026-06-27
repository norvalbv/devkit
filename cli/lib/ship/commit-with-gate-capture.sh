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
# Usage:  commit_with_gate_capture <worktree> <root> <branch> <title> <body>
commit_with_gate_capture() {
  local wt="$1" root="$2" br="$3" title="$4" body="$5"
  local log="$root/.devkit/last-ship-gates-${br//\//-}.log"
  mkdir -p "$root/.devkit"
  set +e
  git -C "$wt" commit -m "$title" -m "$body" 2>&1 | tee "$log" >&2
  local rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -eq 0 ]; then
    {
      echo "✓ pre-commit gates ran in the ship worktree — full output: $log"
      echo "  Review it for any SKIP / ⚠️ lines (e.g. coverage is NOT gated in the ship worktree)."
    } >&2
  fi
  return "$rc"
}
