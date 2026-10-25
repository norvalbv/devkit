#!/usr/bin/env bash
# Sourced by ship-branch.sh and reship.sh. Evidence is fail-open: missing or inconclusive, never a
# failed or hung ship. A caller body for an existing PR fails closed when that PR cannot be read.
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

# This ship's reviewer advisories into the PR body; `replace` only for a history rewrite. Fail-open.
# usage: publish_reviewer_notes <pr-number> <repo> <head-sha> [replace]
publish_reviewer_notes() {
  node "$(evidence_run_script)" notes --repo "$2" --pr "$1" --head "$3" ${4:+--mode "$4"} </dev/null || true
}

# usage: publish_evidence_block <worktree> <pr-number> <repo> <head-sha> [<source-checkout>]
publish_evidence_block() {
  local wt=$1 pr=$2 repo=$3 head=$4 source=${5:-} run supervisor
  run=$(evidence_run_script)
  supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mjs"
  publish_regression_evidence "$wt" "$pr" "$repo" "$head" "$run" "$supervisor"
  # The QA capture is the source checkout's own `devkit machine` recording, opt-in by existing at all.
  [ -z "$source" ] || node "$supervisor" "$MEDIA_BUDGET_SECONDS" -- node "$run" publish-media \
    --source "$source" --repo "$repo" --pr "$pr" --head "$head" </dev/null || true
  return 0
}

# Uploading up to six files of 10 MB each is bounded on its own: it never runs the consumer's tests.
MEDIA_BUDGET_SECONDS=600

publish_regression_evidence() {
  local wt=$1 pr=$2 repo=$3 head=$4 run=$5 supervisor=$6 budget tmp status=0 started
  started=$(date +%s)
  budget=$(node "$run" budget "$wt" </dev/null) || budget=0
  case "$budget" in '' | *[!0-9]* | 0) return 0 ;; esac
  # Owned here so a capture killed at the outer bound cannot leak its clones.
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/devkit-evidence.XXXXXX") || return 0
  TMPDIR=$tmp node "$supervisor" "$((budget + 60))" -- \
    node "$run" publish --cwd "$wt" --repo "$repo" --pr "$pr" --head "$head" \
    --started "$started" </dev/null || status=$?
  if [ "$status" -ne 0 ]; then
    TMPDIR=$tmp node "$supervisor" 60 -- node "$run" publish --cwd "$wt" --repo "$repo" --pr "$pr" \
      --head "$head" --started "$started" --failed "the evidence step stopped with exit $status" \
      </dev/null || true
  fi
  rm -rf "$tmp"
  return 0
}
