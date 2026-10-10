#!/usr/bin/env bash
# Sourced by ship-branch.sh and reship.sh. The PR already exists when these run, so both are
# fail-open and errexit-safe: evidence can be missing or inconclusive, never a failed or hung ship.
# The caller sets SCRIPT_DIR.

evidence_run_script() {
  local run="$SCRIPT_DIR/evidence/run.mts"
  [ -f "$run" ] || run="$SCRIPT_DIR/evidence/run.mjs"
  printf '%s' "$run"
}

# Body on stdin, cleaned body on stdout: a pasted evidence block is dropped and, given a PR, the PR's
# current block is carried over. usage: evidence_caller_body <repo> [<pr>]
evidence_caller_body() {
  node "$(evidence_run_script)" body --repo "$1" ${2:+--pr "$2"}
}

# usage: publish_evidence_block <worktree> <pr-number> <repo> <head-sha>
publish_evidence_block() {
  local wt=$1 pr=$2 repo=$3 head=$4 run supervisor budget tmp status=0
  run=$(evidence_run_script)
  supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mjs"
  budget=$(node "$run" budget "$wt" </dev/null) || budget=0
  case "$budget" in '' | *[!0-9]* | 0) return 0 ;; esac
  # Owned here so a capture killed at the outer bound cannot leak its clones.
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/devkit-evidence.XXXXXX") || return 0
  TMPDIR=$tmp node "$supervisor" "$((budget + 60))" -- \
    node "$run" publish --cwd "$wt" --repo "$repo" --pr "$pr" --head "$head" </dev/null || status=$?
  if [ "$status" -ne 0 ]; then
    TMPDIR=$tmp node "$supervisor" 60 -- node "$run" publish --cwd "$wt" --repo "$repo" --pr "$pr" \
      --head "$head" --failed "the evidence step stopped with exit $status" </dev/null || true
  fi
  rm -rf "$tmp"
  return 0
}
