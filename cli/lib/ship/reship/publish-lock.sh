#!/usr/bin/env bash
# Publication lock and PR-body receipt helpers for reship.sh. Sourced by it.

rewrite_publish_lock_acquire() {
  local lock_root rc=0
  lock_root=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
    [ -n "$lock_root" ] || {
    echo "reship rejected: could not resolve the git common dir for the publication lock" >&2
    return 1
  }
  lock_root="$lock_root/devkit/reship-publish"
  # Checked: an uncreatable root would otherwise spin the whole wait and blame a phantom publisher.
  mkdir -p "$lock_root" 2>/dev/null || {
    echo "reship rejected: cannot create the publication lock directory $lock_root" >&2
    return 1
  }
  # .mutex, not the old .lock: a pre-nonce `holder`-format lock left there could never be reaped.
  REWRITE_PUBLISH_LOCK="$lock_root/$(printf '%s' "$BR" | git hash-object --stdin).mutex"
  REWRITE_PUBLISH_NONCE=$(node "$REWRITE_PUBLISH_LOCK_CLI" acquire "$$" "$REWRITE_PUBLISH_LOCK") ||
    rc=$?
  case $rc in
    0) REWRITE_PUBLISH_OWNED=1 ;;
    75)
      echo "reship rejected: another publisher still owns origin/$BR; resume after it finishes" >&2
      return 1
      ;;
    *) return 1 ;; # publish-lock.mts already named the cause
  esac
}

rewrite_publish_lock_release() {
  [ "$REWRITE_PUBLISH_OWNED" -eq 1 ] || return 0
  node "$REWRITE_PUBLISH_LOCK_CLI" release "$REWRITE_PUBLISH_LOCK" "$REWRITE_PUBLISH_NONCE" || true
  REWRITE_PUBLISH_OWNED=0
}

# The Git commit is already remote at every call site. Treat the GitHub mutation as a truthful
# partial-success boundary and name only a manual recovery command: normal successful pushes spend
# their retry intent before this runs, while the no-delta recovery arm spends it immediately after.
publish_requested_pr_body() {
  local published_commit=$1 carried
  if [ -z "$PR_URL" ]; then
    echo "reship: PR body was not updated: could not resolve the open PR after the push" >&2
    echo "  the commit is already on origin/$BR at $published_commit; no rollback was attempted" >&2
    echo "  resolve the PR, then pipe the intended body to: devkit pr-body <url> --body-file -" >&2
    return 1
  fi
  # The caller owns the text, ship owns the evidence block: carry the PR's current block across.
  if ! carried=$(printf '%s' "$BODY" | evidence_caller_body "$REPO" "$PR_URL" && printf .); then
    echo "reship: PR body was not updated: ship could not carry the PR's evidence block (see the evidence: error above)" >&2
    echo "  the commit is already on origin/$BR at $published_commit; no rollback was attempted" >&2
    echo "  once gh pr view '$PR_URL' works, run: devkit pr-body '$PR_URL' --body-file <file>" >&2
    return 1
  fi
  if ! printf '%s' "${carried%.}" | gh pr edit "$PR_URL" --repo "$REPO" --body-file - >/dev/null; then
    echo "reship: PR body was not updated after the push" >&2
    echo "  the commit is already on origin/$BR at $published_commit; no rollback was attempted" >&2
    echo "  pipe the intended body to: devkit pr-body '$PR_URL' --body-file -" >&2
    return 1
  fi
}

body_receipt_delete() {
  [ -z "$BODY_RECEIPT_REF" ] || git update-ref -d "$BODY_RECEIPT_REF" 2>/dev/null || true
  [ -z "$BODY_PAYLOAD_REF" ] || git update-ref -d "$BODY_PAYLOAD_REF" 2>/dev/null || true
}

# A killed rewrite can leave either half of its pre-push proof while origin still names the old
# head. A resume cannot recover that unpublished commit, so remove every direct commit-keyed proof
# for this exact branch except the remote head it may still need for post-push reconciliation.
body_orphan_proofs_prune() {
  local keep_commit=$1 prefix refs ref suffix value status=0 empty_oid oid_width
  empty_oid=$(git hash-object --stdin </dev/null) || return 1
  oid_width=${#empty_oid}
  for prefix in "$BODY_RECEIPT_PREFIX" "$BODY_PAYLOAD_PREFIX"; do
    refs=$(git for-each-ref --format='%(refname)' "$prefix/$BR/") || return 1
    while IFS= read -r ref; do
      suffix=${ref#"$prefix/$BR/"}
      [ "$suffix" != "$ref" ] || continue
      [ "${#suffix}" -eq "$oid_width" ] || continue
      case "$suffix" in *[!0-9a-f]*) continue ;; esac
      [ "$suffix" != "$keep_commit" ] || continue
      value=$(git rev-parse -q --verify "$ref" 2>/dev/null || true)
      [ -z "$value" ] || git update-ref -d "$ref" "$value" || status=1
    done <<< "$refs"
  done
  return "$status"
}
