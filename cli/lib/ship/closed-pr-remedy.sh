#!/usr/bin/env bash
# Sourced by ship-branch.sh and reship.sh: reads origin/$BR's PR state and prints the new-PR remedy
# for one that is no longer open. The caller sets SCRIPT_DIR, BR, REPO and TITLE.

# PR identity TSV. No baseRefOid: GitHub freezes it at the last head push, so two reads of an
# unchanged PR could differ against a moving base.
pr_identity() {
  gh_bounded pr view "$BR" --repo "$REPO" \
    --json number,state,headRefName,headRefOid,headRepository,baseRefName,url \
    --jq '[.number,.state,.headRefName,.headRefOid,(.headRepository.nameWithOwner // ""),.baseRefName,.url] | @tsv' 2>/dev/null
}

gh_bounded() {
  local supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mjs"
  node "$supervisor" 60 -- gh "$@"
}

# Succeeds only when gh answers that origin/$BR heads no same-repo PR. `gh pr view` exits 1 both for
# "no PR" and for an API failure; `gh pr list` exits 0 with an empty list only for the former.
pr_absent() {
  local n
  n=$(gh_bounded pr list --repo "$REPO" --head "$BR" --state all --limit 100 \
    --json isCrossRepository --jq 'map(select(.isCrossRepository | not)) | length' 2>/dev/null) && [ "$n" = 0 ]
}

# Sets PR_SEEN_NUM, PR_SEEN_STATE, PR_SEEN_BASE and PR_SEEN_URL; returns 1 when gh names no PR,
# whether none exists or gh failed.
read_pr_state() {
  local fields
  fields=$(pr_identity) || fields=
  # A non-whitespace IFS keeps empty fields (a deleted fork's head repo); tabs would collapse them.
  IFS=$'\x1f' read -r PR_SEEN_NUM PR_SEEN_STATE _ _ _ PR_SEEN_BASE PR_SEEN_URL <<< "${fields//$'\t'/$'\x1f'}"
  case "$PR_SEEN_NUM" in *[!0-9]*|'') return 1 ;; esac
}

# usage: print_closed_pr_remedy <base> <command-tail> <reopen-follow-up>
print_closed_pr_remedy() {
  local base
  base=$(printf '%q' "$1")
  # The merge anchors the new ship's patch past the squash; the override only skips the refusal that
  # origin/<base> lacks the PR's pre-squash commits, which the merge already accounted for.
  echo "  bring origin/$1 into this checkout, then ship this change as a new PR:" >&2
  echo "    git fetch origin $base && git merge origin/$base" >&2
  echo "    GUARD_SHIP_BASE_OK=1 devkit ship <new-branch> $(printf '%q' "$TITLE") --base $base $2" >&2
  echo "  (GUARD_SHIP_BASE_OK=1 is needed only after a squash or rebase merge)" >&2
  [ "$PR_SEEN_STATE" != "CLOSED" ] || echo "  or reopen it: gh pr reopen $PR_SEEN_NUM --repo $REPO, $3" >&2
}
