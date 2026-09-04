#!/usr/bin/env bash
# devkit ship --pr <branch>: add the current changes to an EXISTING PR's branch as a NEW commit,
# fast-forward push by default. With --base, replace a conflicted PR from a caller-prepared snapshot
# using one gated commit plus an exact expected-OID lease.
#
# Why a separate flow from new-ship (ship-branch.sh): the base is the EXISTING remote branch tip
# (origin/<branch>), not this checkout's HEAD; the branch must already exist (the opposite preflight);
# the new commit is the DELTA between that tip and your current files (so we copy current content
# over the fetched tip rather than replay a HEAD-relative patch, which could conflict with the
# first ship's content); and we push ff to the branch (no -u, no new PR). The shared worktree +
# symlink + marker ceremony is duplicated rather than shared so this flow can't perturb new-ship.
# fallow-ignore-next-line code-duplication
#
# Usage:  ship --pr <branch> "<title>" [--base <b>] [--link <d>]... [--] <path...>
#         ship <branch> "<title>" --pr [--base <b>] [--link <d>]... [--] <path...>   # equivalent
#         ship --resume <branch> [--body-file <f>] [--] <extra-path...> # replay the recorded attempt
#         # commit body via stdin, --body or --body-file. Only the explicit flags also refresh the
#         # existing PR description; omitting them preserves that description.
set -euo pipefail

# Only review-target.sh implements run-packaged-script.mts's signal-lock handshake. See the matching
# comment in ship-branch.sh: an inherited-but-unread lock root leaks into every gate and can silence
# signal forwarding to this shell entirely.
unset DEVKIT_MANAGED_SIGNAL_ROOT

# Before ANY git that can reach the network. Under the managed spawn this script runs in a background
# process group, where a tool that opens /dev/tty is SIGTTIN-suspended rather than prompted — a silent
# hang, not an error. ls-remote/fetch happen long before the PR body is read, so these cannot wait for
# the redirect below: an unknown host key or a passphrase with no agent would wedge the run. Same
# ordering review-target.sh uses. An explicit GIT_SSH_COMMAND stays the caller's.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"

# `--pr` is the MODE flag: ship.mts routes on it, then forwards argv VERBATIM — so it still arrives
# here, and wherever the caller put it. Strip a LEADING one before reading positionals; the parse loop
# below drops a trailing one. Without this, the spelling the help text itself documents
# (`ship --pr <branch> "<title>"`) bound BR="--pr" and TITLE=<branch>, and the run died at the remote
# check with `no remote branch origin/--pr to re-push to` — a message that names the flag as if it
# were a branch and sends you looking at the wrong thing entirely. The existing tests all passed
# because they exercise the trailing form exclusively.
# Leading mode flags, in either order: `--pr` (routed here by ship.mts, forwarded verbatim) and
# `--resume` (replay the invocation recorded by the previous attempt — see ship-branch.sh's twin).
RESUME=0
while :; do
  case "${1:-}" in
    --pr) shift ;;
    --resume) RESUME=1; shift ;;
    *) break ;;
  esac
done

BR=${1:?branch}
if [ "$RESUME" -eq 1 ]; then
  shift 1
  TITLE=""                # loaded from the recorded invocation below
  RESUME_ARGS=("$@")      # kept verbatim for the cross-mode exec into ship-branch.sh
else
  TITLE=${2:?title}; shift 2
fi

# The leading `--pr`/`--resume` above are the only flag-first spellings this script accepts. Any
# OTHER flag in a positional slot is the same mistake wearing a different hat, so reject it here
# rather than let it reach the remote check as a branch name.
. "$(dirname "${BASH_SOURCE[0]}")/assert-positional-args.sh"
if [ "$RESUME" -eq 1 ]; then
  ship_assert_positional_args "$BR" "" \
    'ship --resume <branch> [--body-file <f>] [--] <extra-path...>'
else
  ship_assert_positional_args "$BR" "$TITLE" \
    'ship --pr <branch> "<title>" [--body "<text>"] [--body-file <f>] [--ready] [--link <d>]... [--] <path...>'
fi

LINK_EXTRA=()
PATHS=()
BASE_FLAG=""
BODY_SET=0         # --body given? else --body-file, else stdin (back-compat)
BODY_FILE_SET=0    # --body-file <path>: author the body once in a file; survives every retry
UPDATE_PR_BODY=0   # explicit body flag? Refresh the existing PR too; recorded across --resume
QAVIS_PUBLISH=1    # suppresses only the post-push description write, never the staged gate
READY=0            # --ready marks the PR ready-for-review after the push lands
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr) shift ;;                                                   # mode flag (already routed here) — ignore
    --link)
      [ "$RESUME" -eq 0 ] || { echo "--resume replays the recorded invocation — to change --link, run the full devkit ship --pr command (it re-records)" >&2; exit 1; }
      LINK_EXTRA+=("${2:?--link requires a directory}"); shift 2 ;;
    --base)
      [ "$RESUME" -eq 0 ] || { echo "--resume replays the recorded invocation — to change --base, run the full devkit ship --pr command (it re-records)" >&2; exit 1; }
      BASE_FLAG="${2:?--base requires a branch}"; shift 2 ;;
    --body) BODY_FLAG="${2?--body requires text}"; BODY_SET=1; UPDATE_PR_BODY=1; shift 2 ;;
    --body-file) BODY_FILE_FLAG="${2:?--body-file requires a path}"; BODY_FILE_SET=1; UPDATE_PR_BODY=1; shift 2 ;;
    --no-qavis-publish) QAVIS_PUBLISH=0; shift ;;
    --ready)
      # Deliberately NOT recorded across --resume: unlike the body/base, this is a one-shot state
      # transition on the PR, not a property of the invocation. A retry of a blocked re-push should
      # not silently re-publish a PR the operator may have put back into draft in the meantime.
      READY=1; shift ;;
    --draft)
      # The PR already exists here, so there is nothing to open as a draft. Name the actual remedy
      # rather than falling through to the generic unknown-flag error.
      echo "--draft applies to a NEW ship (opening the PR); this PR already exists. To convert it back to a draft: gh pr ready --undo $BR" >&2; exit 1 ;;
    --resume) echo "--resume must come FIRST: devkit ship --resume <branch> [--] <extra-path...>" >&2; exit 1 ;;
    --) shift; while [ "$#" -gt 0 ]; do PATHS+=("$1"); shift; done; break ;;
    -*) echo "unknown flag: $1 (pass a dash-leading file path after --)" >&2; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done
[ "$BODY_SET" -eq 0 ] || [ "$BODY_FILE_SET" -eq 0 ] || { echo "--body and --body-file are mutually exclusive" >&2; exit 1; }
BODY_RECEIPT_PREFIX=refs/devkit/reship-body-receipts
BODY_PAYLOAD_PREFIX=refs/devkit/reship-body-payloads
BODY_RECEIPT_REF=
BODY_PAYLOAD_REF=
REWRITE_RECEIPT_PROVEN=0

# Resume: replay the recorded invocation. Same NUL-delimited contract + bash-3.2 parse as
# ship-branch.sh; the shared field order is ship-intent.mts's emitFields contract.
RESUME_ROOT=$(git rev-parse --show-toplevel)
RESUME_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SHIP_INTENT="$RESUME_SCRIPT_DIR/ship-intent.mts"; [ -f "$SHIP_INTENT" ] || SHIP_INTENT="$RESUME_SCRIPT_DIR/ship-intent.mjs"
RESUME_BODY=
if [ "$RESUME" -eq 1 ]; then
  SI_OUT=$(mktemp "${TMPDIR:-/tmp}/ship-intent-read.XXXXXX")
  if ! node "$SHIP_INTENT" read --root "$RESUME_ROOT" --branch "$BR" > "$SI_OUT"; then
    rm -f "$SI_OUT"; exit 1   # ship-intent already printed the named refusal
  fi
  SI_FIELDS=()
  while IFS= read -r -d '' si_field; do SI_FIELDS+=("$si_field"); done < "$SI_OUT"
  rm -f "$SI_OUT"
  # ship-intent.mts field order: mode, sourceMode, title, base, qavis, updatePrBody, draft,
  # createdAt, generation, sourceAttemptId (empty for this explicit mode), nlinks, links..., body,
  # paths... Field 6 (draft) is new-ship-only — read past it here, but keep these POSITIONAL indices
  # in lockstep with ship-branch.sh:139, which decodes the same stream.
  [ "${#SI_FIELDS[@]}" -ge 13 ] || { echo "recorded invocation is malformed — run the full devkit ship --pr command" >&2; exit 1; }
  SI_MODE=${SI_FIELDS[0]}
  if [ "$SI_MODE" = "ship" ]; then
    # The blocked attempt was a NEW ship; hand over. Positive match + one-shot marker — an
    # unrecognised mode hard-errors below, never bounces between the two scripts.
    [ -z "${DEVKIT_SHIP_RESUME_DISPATCHED:-}" ] || { echo "recorded invocation dispatched in a loop (mode '$SI_MODE') — the manifest is inconsistent; run the full command" >&2; exit 1; }
    DEVKIT_SHIP_RESUME_DISPATCHED=1 exec bash "$RESUME_SCRIPT_DIR/ship-branch.sh" --resume "$BR" ${RESUME_ARGS[@]+"${RESUME_ARGS[@]}"}
  fi
  [ "$SI_MODE" = "reship" ] || { echo "recorded invocation has unrecognised mode '$SI_MODE' — run the full devkit ship --pr command" >&2; exit 1; }
  [ "${SI_FIELDS[1]}" = "explicit" ] || { echo "recorded reship invocation has unsupported source mode '${SI_FIELDS[1]}'" >&2; exit 1; }
  TITLE=${SI_FIELDS[2]}
  BASE_FLAG=${SI_FIELDS[3]}
  [ "${SI_FIELDS[4]}" != "1" ] || QAVIS_PUBLISH=0
  [ "${SI_FIELDS[5]}" != "1" ] || UPDATE_PR_BODY=1
  RESUME_CREATED=${SI_FIELDS[7]}
  RESUME_GENERATION=${SI_FIELDS[8]}
  SI_NLINKS=${SI_FIELDS[10]}
  case "$SI_NLINKS" in *[!0-9]*|'') echo "recorded invocation is malformed (nlinks '$SI_NLINKS')" >&2; exit 1 ;; esac
  si_i=11
  si_body_at=$((11 + SI_NLINKS))
  [ "${#SI_FIELDS[@]}" -gt $((si_body_at + 1)) ] || { echo "recorded invocation is malformed (missing body/paths)" >&2; exit 1; }
  while [ "$si_i" -lt "$si_body_at" ]; do LINK_EXTRA+=("${SI_FIELDS[$si_i]}"); si_i=$((si_i + 1)); done
  RESUME_BODY=${SI_FIELDS[$si_body_at]}
  SI_PATHS=("${SI_FIELDS[@]:$((si_body_at + 1))}")
  # Only what THIS retry explicitly briefed may be donated on a lost re-record (see ship-branch.sh).
  RESUME_EXTRA_PATHS=()
  for p in ${PATHS[@]+"${PATHS[@]}"}; do
    si_dup=0
    for q in "${SI_PATHS[@]}"; do [ "$q" = "$p" ] && { si_dup=1; break; }; done
    [ "$si_dup" -eq 1 ] || { SI_PATHS+=("$p"); RESUME_EXTRA_PATHS+=("$p"); }
  done
  PATHS=("${SI_PATHS[@]}")
  echo "Resuming recorded invocation for $BR (--pr): \"$TITLE\" — ${#PATHS[@]} paths, body $(printf '%s' "$RESUME_BODY" | wc -c | tr -d ' ') bytes, recorded $RESUME_CREATED" >&2
fi

[ "${#PATHS[@]}" -gt 0 ] || { echo "no paths given" >&2; exit 1; }
for p in "${PATHS[@]}"; do
  [ -d "$p" ] && {
    echo "directory path not allowed (pass individual files): $p" >&2
    echo "  list its tracked files: git ls-files -- \"$p\"" >&2
    exit 1
  }
done

LINK_DIRS=()
[ "${#LINK_EXTRA[@]}" -gt 0 ] && LINK_DIRS+=("${LINK_EXTRA[@]}")

ROOT=$(git rev-parse --show-toplevel)
# Pinned before any staging: in a shared parallel-agent checkout $ROOT can gain a commit mid-run, and
# a later read would name a tree the caller never read (sc-2480). Empty when unreadable.
CALLER_HEAD=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REWRITE_REMOTE_SUPERVISOR="$SCRIPT_DIR/review/process/gate-supervisor.mts"
[ -f "$REWRITE_REMOTE_SUPERVISOR" ] || REWRITE_REMOTE_SUPERVISOR="$SCRIPT_DIR/review/process/gate-supervisor.mjs"
rewrite_remote() {
  node "$REWRITE_REMOTE_SUPERVISOR" 60 -- "$@"
}
# Resolve owner/repo from origin (best-effort — only used for the final PR-URL print, which falls
# back to a plain message; a non-GitHub origin still re-pushes fine).
ORIGIN_URL=$(git config --get remote.origin.url || git remote get-url origin)
REPO=$(printf '%s\n' "$ORIGIN_URL" | sed -E 's#^.*github\.com[^:/]*[:/]##; s#\.git$##')

REWRITE=0
if [ -n "$BASE_FLAG" ]; then
  REWRITE=1
  BASE_REF=${BASE_FLAG#origin/}
  [ -n "$BASE_REF" ] || { echo "--base requires a branch" >&2; exit 1; }
  # Git reports old-PR scope in repository-canonical form. Normalize the harmless spelling Git
  # itself accepts so `./path` cannot be falsely reported missing or persisted as a second identity.
  REWRITE_PATHS=()
  for p in "${PATHS[@]}"; do
    while [ "${p#./}" != "$p" ]; do p=${p#./}; done
    rewrite_duplicate=0
    for q in ${REWRITE_PATHS[@]+"${REWRITE_PATHS[@]}"}; do
      [ "$q" = "$p" ] && { rewrite_duplicate=1; break; }
    done
    [ "$rewrite_duplicate" -eq 1 ] || REWRITE_PATHS+=("$p")
  done
  PATHS=("${REWRITE_PATHS[@]}")
fi

# Test seam: print the resolved target + repo, then exit BEFORE any side effect (no fetch / push).
[ -n "${SHIP_RESOLVE_ONLY:-}" ] && { printf 'BR=%s\nREPO=%s\n' "$BR" "$REPO"; exit 0; }

if { [ "$REWRITE" -eq 1 ] || [ -z "${SHIP_DRY_RUN:-}" ]; } && ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed (needed to resolve the PR URL)" >&2; exit 1
fi

# A normal re-push is parented on the existing PR tip. Rewrite mode instead pins the PR head and
# requested base into process-owned refs in ONE fetch. It never mutates FETCH_HEAD or a shared
# origin/* tracking ref, so parallel ship/review processes cannot change the objects being proved.
REWRITE_HEAD_REF=""
REWRITE_BASE_REF=""
EXPECTED_REMOTE=""
REQUIRED_SCOPE_FILE=""
FINAL_SCOPE_FILE=""
REWRITE_PUBLISH_LOCK=""
REWRITE_PUBLISH_STAMP=""
REWRITE_PUBLISH_OWNED=0
rewrite_ref_cleanup() {
  if [ -n "$REWRITE_HEAD_REF" ]; then
    cleanup_oid=${EXPECTED_REMOTE:-$(git rev-parse -q --verify "$REWRITE_HEAD_REF" 2>/dev/null || true)}
    [ -z "$cleanup_oid" ] || git update-ref -d "$REWRITE_HEAD_REF" "$cleanup_oid" 2>/dev/null || true
  fi
  if [ -n "$REWRITE_BASE_REF" ]; then
    cleanup_oid=${BASE:-$(git rev-parse -q --verify "$REWRITE_BASE_REF" 2>/dev/null || true)}
    [ -z "$cleanup_oid" ] || git update-ref -d "$REWRITE_BASE_REF" "$cleanup_oid" 2>/dev/null || true
  fi
  [ -z "$REQUIRED_SCOPE_FILE" ] || rm -f "$REQUIRED_SCOPE_FILE"
  [ -z "$FINAL_SCOPE_FILE" ] || rm -f "$FINAL_SCOPE_FILE"
}

# Serialize a rewrite's destructive publication/bookkeeping window and every explicit PR-body
# publication with the matching head push. Gates still run in parallel. Atomic mkdir supplies
# exclusion; the holder PID makes a killed publisher reclaimable.
rewrite_publish_lock_acquire() {
  local lock_root holder owner owner_start current_start attempts=0
  lock_root="$ROOT/.devkit/reship-rewrite-publish"
  mkdir -p "$lock_root"
  REWRITE_PUBLISH_LOCK="$lock_root/${BR//\//-}.lock"
  owner_start=$(ps -o lstart= -p $$ 2>/dev/null | git hash-object --stdin)
  REWRITE_PUBLISH_STAMP="$$:$owner_start:$(date +%s)"
  while ! mkdir "$REWRITE_PUBLISH_LOCK" 2>/dev/null; do
    holder=$(cat "$REWRITE_PUBLISH_LOCK/holder" 2>/dev/null || true)
    owner=${holder%%:*}
    owner_start=${holder#*:}; owner_start=${owner_start%%:*}
    current_start=""
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      current_start=$(ps -o lstart= -p "$owner" 2>/dev/null | git hash-object --stdin)
    fi
    if [ -n "$holder" ] && [ "$holder" = "$(cat "$REWRITE_PUBLISH_LOCK/holder" 2>/dev/null || true)" ] && \
       { [ -z "$current_start" ] || [ "$current_start" != "$owner_start" ]; }; then
      rm -f "$REWRITE_PUBLISH_LOCK/holder" 2>/dev/null || true
      rmdir "$REWRITE_PUBLISH_LOCK" 2>/dev/null || true
      continue
    fi
    # An acquirer killed between mkdir and its holder write leaves no PID to prove. Only age may
    # reclaim that micro-window; a live but paused acquirer younger than a minute remains protected.
    if [ -z "$holder" ] && [ -n "$(find "$REWRITE_PUBLISH_LOCK" -prune -mmin +1 -print 2>/dev/null)" ]; then
      rmdir "$REWRITE_PUBLISH_LOCK" 2>/dev/null || true
      continue
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -lt 300 ] || {
      echo "reship rejected: another publisher still owns origin/$BR; resume after it finishes" >&2
      return 1
    }
    sleep 0.1
  done
  printf '%s' "$REWRITE_PUBLISH_STAMP" > "$REWRITE_PUBLISH_LOCK/holder" || {
    rmdir "$REWRITE_PUBLISH_LOCK" 2>/dev/null || true
    return 1
  }
  REWRITE_PUBLISH_OWNED=1
}

rewrite_publish_lock_release() {
  [ "$REWRITE_PUBLISH_OWNED" -eq 1 ] || return 0
  if [ "$(cat "$REWRITE_PUBLISH_LOCK/holder" 2>/dev/null || true)" = "$REWRITE_PUBLISH_STAMP" ]; then
    rm -f "$REWRITE_PUBLISH_LOCK/holder" 2>/dev/null || true
    rmdir "$REWRITE_PUBLISH_LOCK" 2>/dev/null || true
  fi
  REWRITE_PUBLISH_OWNED=0
}

# The Git commit is already remote at every call site. Treat the GitHub mutation as a truthful
# partial-success boundary and name only a manual recovery command: normal successful pushes spend
# their retry intent before this runs, while the no-delta recovery arm spends it immediately after.
publish_requested_pr_body() {
  local published_commit=$1
  if [ -z "$PR_URL" ]; then
    echo "reship: PR body was not updated: could not resolve the open PR after the push" >&2
    echo "  the commit is already on origin/$BR at $published_commit; no rollback was attempted" >&2
    echo "  resolve the PR, then pipe the intended body to: gh pr edit <url> --repo '$REPO' --body-file -" >&2
    return 1
  fi
  if ! printf '%s' "$BODY" | gh pr edit "$PR_URL" --repo "$REPO" --body-file - >/dev/null; then
    echo "reship: PR body was not updated after the push" >&2
    echo "  the commit is already on origin/$BR at $published_commit; no rollback was attempted" >&2
    echo "  pipe the intended body to: gh pr edit '$PR_URL' --repo '$REPO' --body-file -" >&2
    return 1
  fi
}

body_receipt_delete() {
  [ -z "$BODY_RECEIPT_REF" ] || git update-ref -d "$BODY_RECEIPT_REF" 2>/dev/null || true
  [ -z "$BODY_PAYLOAD_REF" ] || git update-ref -d "$BODY_PAYLOAD_REF" 2>/dev/null || true
}

# --ready: mark the PR ready for review. A FUNCTION, not an inline block, because this script has
# several terminating paths that exit 0 (a body-only update, a resume whose content is already
# remote) — and an early exit that reported success while silently skipping a requested flip would
# leave the operator believing a draft PR had been published. Every such path calls this.
#
# Always runs after the work is durable, so a gh failure can never cost a landed commit. gh's own
# contract makes it idempotent (an already-ready PR warns and exits 0). $1 is the PR number when one
# was resolved — exact even for fork PRs or duplicate branch names — else empty to fall back to $BR.
# Returns non-zero iff the flip was requested and did not happen.
reship_mark_ready() {
  [ "$READY" -eq 1 ] || return 0
  local pr_ref=${1:-}
  # Callers reached before PR_NUM is parsed pass empty; recover the number from the resolved URL so
  # they are not misreported as "could not resolve" when a PR is plainly in hand.
  if [ -z "$pr_ref" ] && [ -n "${PR_URL:-}" ]; then
    pr_ref=${PR_URL##*/}
    [[ "$pr_ref" =~ ^[0-9]+$ ]] || pr_ref=""
  fi
  if [ -z "$pr_ref" ]; then
    echo "--ready could not resolve the PR (the gh pr view above failed)." >&2
    echo "Mark it ready by hand once gh is reachable:" >&2
    echo "  gh pr ready '$BR' --repo '$REPO'" >&2
    return 1
  fi
  gh pr ready "$pr_ref" --repo "$REPO" && return 0
  echo "marking the PR ready FAILED — the commit IS on origin/$BR." >&2
  echo "Mark it ready by hand:" >&2
  echo "  gh pr ready '$pr_ref' --repo '$REPO'" >&2
  return 1
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

# Exit 0 = this generation is spent/absent; 2 = a concurrent attempt donated unshipped paths and
# intentionally kept the record; 1 = lock contention persisted through three bounded retries.
rewrite_delete_intent() {
  local attempt=0 rc force=${1:-}
  while :; do
    rc=0
    if [ "$force" = "force" ]; then
      node "$SHIP_INTENT" delete --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION" || rc=$?
    else
      node "$SHIP_INTENT" delete --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION" -- ${PATHS[@]+"${PATHS[@]}"} || rc=$?
    fi
    [ "$rc" -eq 0 ] && return 0
    [ "$rc" -eq 1 ] || return "$rc"
    attempt=$((attempt + 1))
    [ "$attempt" -lt 3 ] || return 1
    sleep 0.1
  done
}

if [ "$REWRITE" -eq 1 ]; then
  REF_STAMP="$$-$(date +%s)"
  REWRITE_HEAD_REF="refs/devkit/reship-rewrite/$REF_STAMP/head"
  REWRITE_BASE_REF="refs/devkit/reship-rewrite/$REF_STAMP/base"
  trap rewrite_ref_cleanup EXIT
  rewrite_remote git fetch -q origin \
    "+refs/heads/$BR:$REWRITE_HEAD_REF" \
    "+refs/heads/$BASE_REF:$REWRITE_BASE_REF" 2>/dev/null || {
      echo "cannot pin origin/$BR and origin/$BASE_REF — both branches must exist" >&2; exit 1
    }
  EXPECTED_REMOTE=$(git rev-parse "$REWRITE_HEAD_REF")
  BASE=$(git rev-parse "$REWRITE_BASE_REF")
  if [ "$RESUME" -eq 1 ] && [ "$UPDATE_PR_BODY" -eq 1 ]; then
    BODY_RECEIPT_REF="$BODY_RECEIPT_PREFIX/$BR/$EXPECTED_REMOTE"
    BODY_PAYLOAD_REF="$BODY_PAYLOAD_PREFIX/$BR/$EXPECTED_REMOTE"
    BODY_RECEIPT=$(git rev-parse -q --verify "$BODY_RECEIPT_REF^{commit}" 2>/dev/null || true)
    [ "$BODY_RECEIPT" != "$EXPECTED_REMOTE" ] || REWRITE_RECEIPT_PROVEN=1
  fi

  PR_FIELDS=$(rewrite_remote gh pr view "$BR" --repo "$REPO" \
    --json number,state,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,url \
    --jq '[.number,.state,.headRefName,.headRefOid,(.headRepository.nameWithOwner // ""),.baseRefName,.baseRefOid,.url] | @tsv' 2>/dev/null) || {
      echo "cannot inspect the open PR for origin/$BR" >&2; exit 1
    }
  IFS=$'\t' read -r PR_NUM PR_STATE PR_HEAD_REF PR_HEAD_OID PR_HEAD_REPO PR_BASE_REF PR_BASE_OID PR_URL <<< "$PR_FIELDS"
  case "$PR_NUM" in *[!0-9]*|'') echo "PR identity response is malformed" >&2; exit 1 ;; esac
  [ "$PR_STATE" = "OPEN" ] || { echo "refusing rewrite: PR #$PR_NUM is not open (state $PR_STATE)" >&2; exit 1; }
  [ "$PR_HEAD_REF" = "$BR" ] && [ "$PR_HEAD_OID" = "$EXPECTED_REMOTE" ] && [ "$PR_HEAD_REPO" = "$REPO" ] || {
    echo "refusing rewrite: open PR head identity does not match origin/$BR at $EXPECTED_REMOTE" >&2; exit 1
  }
  [ "$PR_BASE_REF" = "$BASE_REF" ] && [ "$PR_BASE_OID" = "$BASE" ] || {
    echo "refusing rewrite: PR #$PR_NUM targets $PR_BASE_REF at $PR_BASE_OID, not origin/$BASE_REF at $BASE" >&2; exit 1
  }
  git merge-base --is-ancestor "$BASE" HEAD || {
    echo "refusing rewrite: origin/$BASE_REF is not an ancestor of the caller checkout" >&2
    echo "  devkit publishes the prepared resolution; rebase or merge the PR base first" >&2
    exit 1
  }

  # The replacement must account for every path in the old PR. Rename detection is deliberately
  # disabled so a rename requires both the deletion and addition. NUL records preserve all valid
  # Git path bytes except NUL itself.
  OLD_MERGE_BASE=$(git merge-base "$BASE" "$EXPECTED_REMOTE") || {
    echo "refusing rewrite: PR head and requested base have no common ancestor" >&2; exit 1
  }
  REQUIRED_SCOPE_FILE=$(mktemp "${TMPDIR:-/tmp}/reship-required.XXXXXX")
  git diff --name-only --no-renames -z "$OLD_MERGE_BASE" "$EXPECTED_REMOTE" -- > "$REQUIRED_SCOPE_FILE"
  MISSING_SCOPE=()
  while IFS= read -r -d '' required_path; do
    required_seen=0
    for p in "${PATHS[@]}"; do [ "$p" = "$required_path" ] && { required_seen=1; break; }; done
    [ "$required_seen" -eq 1 ] || MISSING_SCOPE+=("$required_path")
  done < "$REQUIRED_SCOPE_FILE"
  if [ "${#MISSING_SCOPE[@]}" -gt 0 ] && [ "$REWRITE_RECEIPT_PROVEN" -eq 0 ]; then
    echo "rewrite brief omits paths from the existing PR:" >&2
    for p in "${MISSING_SCOPE[@]}"; do printf '  %q\n' "$p" >&2; done
    exit 1
  fi

  # An unmerged index is not a resolution, and a missing skip-worktree path is not an intentional
  # deletion. Refuse both before recording an intent or paying any gate cost.
  for p in "${PATHS[@]}"; do
    [ -z "$(git -C "$ROOT" ls-files -u -- "$p")" ] || {
      echo "refusing rewrite: briefed path is still unmerged: $p" >&2; exit 1
    }
    if [ -L "$ROOT/$p" ] && [ ! -e "$ROOT/$p" ]; then
      echo "refusing rewrite: dangling symlinks are not representable in reconcile: $p" >&2
      exit 1
    fi
    if [ ! -e "$ROOT/$p" ] && [ ! -L "$ROOT/$p" ] && \
       git -C "$ROOT" ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && \
       git -C "$ROOT" diff --quiet -- "$p" && git -C "$ROOT" diff --cached --quiet -- "$p"; then
      echo "refusing rewrite: briefed path is absent but not deleted (sparse or unmaterialized): $p" >&2
      exit 1
    fi
  done
else
  git fetch origin "$BR" 2>/dev/null || {
    echo "no remote branch origin/$BR to re-push to — open the PR first (ship without --pr)" >&2; exit 1
  }
  BASE=$(git rev-parse FETCH_HEAD)
fi

# Re-pushes pay the same gate cost and can inherit the same stale checkout baseline as new ships.
. "$SCRIPT_DIR/prepare-gate-worktree.sh"
. "$SCRIPT_DIR/ship-run-record.sh"
. "$SCRIPT_DIR/worktree-registry.sh"
. "$SCRIPT_DIR/reclaim-orphan-worktrees.sh"
# Re-ship leaves orphans too. Its worktree is --detach and blocks no future run, so nothing forced
# the issue -- but without this a killed re-ship's directory lingered until some unrelated NEW ship
# happened to target the same branch. Reclamation here can only ever remove a worktree: every reship
# record carries branch_created=0, and branch deletion is gated on 1.
PREFLIGHT_HINT=
# `reship`: this command re-pushes onto an EXISTING branch from a --detach worktree, so unlike a new
# ship it never needs refs/heads/$BR free — and being checked out on the branch being re-pushed is
# the normal way to reach `--pr`, not a problem to report.
ship_reclaim_orphan_worktrees "$PWD" "$BR" reship || exit 1
ship_size_preflight "$ROOT" "$BASE" "${PATHS[@]}"
# See ship-branch.sh: advisory judge reachability, before the deterministic chain is paid.
ship_judge_preflight "$ROOT"

WT="${TMPDIR:-/tmp}/devkit-reship-${BR//\//-}-$$"
# Body: --body "<text>" wins (explicit, no temp file); then --body-file; then — on --resume — the
# recorded body + its explicit-PR-update bit with stdin never consulted; else the same bounded stdin
# contract as new-ship so an inherited, open-but-idle background-task pipe cannot block re-ship
# forever. Back-compat stdin remains commit-only under --pr; omitting both flags preserves PR text.
. "$SCRIPT_DIR/read-stdin-body.sh"
if [ "$BODY_SET" -eq 1 ]; then BODY="$BODY_FLAG"
elif [ "$BODY_FILE_SET" -eq 1 ]; then
  [ -f "$BODY_FILE_FLAG" ] || { echo "--body-file: no such file: $BODY_FILE_FLAG" >&2; exit 1; }
  # cat + sentinel, never $(<file): command substitution strips EVERY trailing newline, silently
  # altering a deliberately-authored body before it is recorded.
  BODY=$(cat -- "$BODY_FILE_FLAG" && printf x) || { echo "--body-file: unreadable: $BODY_FILE_FLAG" >&2; exit 1; }
  BODY=${BODY%x}
elif [ "$RESUME" -eq 1 ]; then BODY="$RESUME_BODY"
elif [ -t 0 ]; then BODY=""
else ship_read_stdin_body; fi
# Match new-ship: the body is the only stdin read, so hand descendants /dev/null and make credential
# prompts fail loudly instead of suspending a background process group via SIGTTIN.
exec 0</dev/null

# Record THIS attempt's effective invocation (mode reship) — the twin of ship-branch.sh's write, so
# `devkit ship --resume <branch>` replays a blocked re-push too (cross-dispatched via the manifest's
# mode). Same hoisted DEVKIT_SHIP_* exports so the ship_intent event correlates with the gate chain.
. "$SCRIPT_DIR/repo-identity.sh"
export DEVKIT_SHIP_ID="${DEVKIT_SHIP_ID:-$(uuidgen 2>/dev/null || echo "${BR//\//-}-$$-$(date +%s)")}"
export DEVKIT_SHIP_REPO="$(devkit_repo_identity "$ROOT")" DEVKIT_SHIP_BRANCH="$BR"
# The caller's checkout and the exact shipped paths, for gates that must tell the operator what to
# run OUTSIDE the ephemeral worktree (qavis-advisory: `qavis qa --staged` must see these staged in
# ROOT, where the receipt it writes is linked back into the gate worktree — sc-2487).
export DEVKIT_SHIP_ROOT="$ROOT"
export DEVKIT_SHIP_FROM_BRANCH="${FROM_BRANCH:-0}"
# Each path base64-encoded and ':'-joined: env values cannot carry NUL, and a newline or colon in a
# valid filename must survive the round trip into the printed remedy.
DEVKIT_SHIP_PATHS=""
for __dk_p in ${PATHS[@]+"${PATHS[@]}"}; do
  DEVKIT_SHIP_PATHS="${DEVKIT_SHIP_PATHS}$(printf '%s' "$__dk_p" | base64 | tr -d '\n'):"
done
export DEVKIT_SHIP_PATHS
export DEVKIT_SHIP_RESUMED=$RESUME
SHIP_INTENT_ARGS=(write --root "$ROOT" --branch "$BR" --mode reship --title "$TITLE")
[ "$REWRITE" -eq 0 ] || SHIP_INTENT_ARGS+=(--base "$BASE_REF")
for d in ${LINK_EXTRA[@]+"${LINK_EXTRA[@]}"}; do SHIP_INTENT_ARGS+=(--link "$d"); done
[ "$QAVIS_PUBLISH" -eq 1 ] || SHIP_INTENT_ARGS+=(--no-qavis-publish)
[ "$UPDATE_PR_BODY" -eq 0 ] || SHIP_INTENT_ARGS+=(--update-pr-body)
if [ "$RESUME" -eq 1 ]; then
  SHIP_INTENT_ARGS+=(--resumed --merge-paths --expect-generation "$RESUME_GENERATION")
  for p in ${RESUME_EXTRA_PATHS[@]+"${RESUME_EXTRA_PATHS[@]}"}; do SHIP_INTENT_ARGS+=(--donate "$p"); done
fi
# Capture the record's generation stamp — success deletes only what this attempt wrote (see
# ship-branch.sh's twin). Serialize this lineage replacement with recovery's locked ownership check:
# once a recovery proves ownership, no fresher invocation can replace the record before its edit.
rewrite_publish_lock_acquire || exit 1
SHIP_INTENT_GENERATION=$(printf '%s' "$BODY" | node "$SHIP_INTENT" "${SHIP_INTENT_ARGS[@]}" -- "${PATHS[@]}") \
  || SHIP_INTENT_GENERATION=""
if [ -z "$SHIP_INTENT_GENERATION" ]; then
  if [ "$UPDATE_PR_BODY" -eq 1 ] && [ -z "${SHIP_DRY_RUN:-}" ]; then
    rewrite_publish_lock_release
    echo "reship: explicit PR-body publication requires a recorded invocation; no gates, push, or PR edit attempted" >&2
    echo "  run 'devkit doctor --fix', then re-run the full devkit ship --pr command" >&2
    exit 1
  fi
  echo "reship: invocation not recorded — the retry needs the full command (non-fatal)" >&2
fi
if [ "$REWRITE" -eq 1 ] && [ "$RESUME" -eq 1 ] && [ "$UPDATE_PR_BODY" -eq 1 ] &&
   [ -n "$SHIP_INTENT_GENERATION" ]; then
  body_orphan_proofs_prune "$EXPECTED_REMOTE" || {
    rewrite_publish_lock_release
    echo "reship: could not retire unpublished rewrite proof; no gates or publication attempted" >&2
    exit 1
  }
fi
rewrite_publish_lock_release
# Same exported flag as ship-branch.sh: the subprocess timeout banner must not advertise --resume
# for an attempt that was never recorded.
export DEVKIT_SHIP_INTENT_RECORDED=$([ -n "$SHIP_INTENT_GENERATION" ] && echo 1 || echo 0)

# Match new-ship: run against the caller checkout after recording so an omitted artifact can ride
# `--resume <branch> -- <artifact>`, but before the detached worktree hides ignored dist output.
# The helper remains a no-op for every consumer repo.
DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mts"
[ -f "$DIST_INTEGRITY" ] || DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mjs"
node "$DIST_INTEGRITY" --root "$ROOT" --base "$BASE" -- "${PATHS[@]}"

STAGED_STATE=$(mktemp "${TMPDIR:-/tmp}/reship-staged.XXXXXX")
BODY_RECOVERY_INDEX=
BODY_RECOVERY_PATCH=
KEEP_WT=  # set by a staged-set abort: the clobbered index IS the evidence, so never reclaim it
cleanup() {
  rewrite_publish_lock_release
  rewrite_ref_cleanup
  rm -f "$STAGED_STATE"
  [ -z "$BODY_RECOVERY_INDEX" ] || rm -f "$BODY_RECOVERY_INDEX"
  [ -z "$BODY_RECOVERY_PATCH" ] || rm -f "$BODY_RECOVERY_PATCH"
  if [ -n "$KEEP_WT" ]; then
    echo "   Worktree KEPT for diagnosis: $WT" >&2
    echo "   Then: git worktree remove --force '$WT'" >&2
    return
  fi
  git worktree remove --force "$WT" 2>/dev/null || true
}
trap cleanup EXIT
# Match new-ship: a signal delivered only to this public shell is handed to the active gate
# supervisor, and cleanup waits until its complete reviewer tree is reaped (sc-1538).
. "$SCRIPT_DIR/review/process/gate-signal-handoff.sh"
gate_signal_handoff_init

# Detached worktree at the PR branch tip for an append, or at the pinned PR base for a rewrite.
git worktree add -q --detach "$WT" "$BASE" >&2
# branch_created=0 always: this worktree is detached and holds no branch, so nothing may ever delete
# one on its behalf. The record exists so a leftover re-ship worktree is attributable to the process
# that made it, the same way new-ship's is.
ship_run_record_begin "$WT" "$BR" "$BASE" 0 reship

# Copy the CURRENT content of each path over the pinned parent (add/modify), or delete it. For an
# append that parent is the PR tip; for a rewrite it is the current PR base and the complete-scope
# preflight above ensures rewritten-away old-PR paths cannot be silently omitted.
for p in "${PATHS[@]}"; do
  if [ -e "$ROOT/$p" ]; then
    mkdir -p "$WT/$(dirname "$p")"
    cp -Pp "$ROOT/$p" "$WT/$p"
    # -f: a briefed path can be TRACKED on the PR branch yet sit under a gitignored dir (a tracked
    # `dist/` build artifact is the case that bit us). A plain `git add` STAGES it but still exits
    # nonzero with "The following paths are ignored", and set -e (top of file) would abort the whole
    # re-push before the staged-set snapshot, gates, commit, and push. Every PATHS entry is
    # caller-explicit (positional after --; directories already rejected above), so forcing it is
    # exactly what was asked — same reasoning as husky-block.mts's `git add -f`.
    git -C "$WT" add -f -- "$p"
  else
    git -C "$WT" rm -q --ignore-unmatch -- "$p" || true
  fi
done

# A retained rewrite intent may resume after its force-push succeeded but before the PR body edit.
# Only a private receipt written after THIS exact commit passed gates is provenance. Rebuild its
# tree with today's briefed bytes overlaid: receipt-only gate additions remain authoritative, while
# any caller-path drift refuses the shortcut. This is the re-ship twin of new-ship's gate receipt.
REWRITE_ALREADY_PUBLISHED=0
if [ "$REWRITE" -eq 1 ] && [ "$UPDATE_PR_BODY" -eq 1 ] && [ "$RESUME" -eq 1 ] &&
   [ -n "${SHIP_INTENT_GENERATION:-}" ] && [ "$REWRITE_RECEIPT_PROVEN" -eq 1 ]; then
  STAGED_REWRITE_TREE=$(git -C "$WT" write-tree)
  EXPECTED_REWRITE_MESSAGE=$(printf '%s\n\n%s\n' "$TITLE" "$BODY" | git stripspace)
  PUBLISHED_REWRITE_MESSAGE=$(git log -1 --format=%B "$EXPECTED_REMOTE")
  PUBLISHED_REWRITE_PARENT=$(git rev-parse "$EXPECTED_REMOTE^" 2>/dev/null || true)
  EXPECTED_BODY_PAYLOAD=$(printf '%s\0%s' "$TITLE" "$BODY" | git hash-object --stdin)
  RECORDED_BODY_PAYLOAD=$(git rev-parse -q --verify "$BODY_PAYLOAD_REF^{blob}" 2>/dev/null || true)
  if [ "$PUBLISHED_REWRITE_MESSAGE" = "$EXPECTED_REWRITE_MESSAGE" ] &&
     [ "$PUBLISHED_REWRITE_PARENT" = "$BASE" ] &&
     [ "$RECORDED_BODY_PAYLOAD" = "$EXPECTED_BODY_PAYLOAD" ]; then
    BODY_RECOVERY_INDEX=$(mktemp "${TMPDIR:-/tmp}/reship-body-index.XXXXXX")
    rm -f "$BODY_RECOVERY_INDEX" # read-tree must create it; an empty file is not a valid index
    BODY_RECOVERY_PATCH=$(mktemp "${TMPDIR:-/tmp}/reship-body-patch.XXXXXX")
    if GIT_INDEX_FILE="$BODY_RECOVERY_INDEX" git -C "$WT" read-tree "$EXPECTED_REMOTE" &&
       git -C "$WT" diff --binary "$EXPECTED_REMOTE" "$STAGED_REWRITE_TREE" -- "${PATHS[@]}" > "$BODY_RECOVERY_PATCH" &&
       { [ ! -s "$BODY_RECOVERY_PATCH" ] || GIT_INDEX_FILE="$BODY_RECOVERY_INDEX" git -C "$WT" apply --cached "$BODY_RECOVERY_PATCH"; }; then
      RECOVERED_REWRITE_TREE=$(GIT_INDEX_FILE="$BODY_RECOVERY_INDEX" git -C "$WT" write-tree)
      PUBLISHED_REWRITE_TREE=$(git rev-parse "$EXPECTED_REMOTE^{tree}")
      [ "$RECOVERED_REWRITE_TREE" != "$PUBLISHED_REWRITE_TREE" ] || REWRITE_ALREADY_PUBLISHED=1
    fi
  fi
fi
if [ "$REWRITE_ALREADY_PUBLISHED" -eq 1 ] && [ -n "${SHIP_DRY_RUN:-}" ]; then
  echo "DRY: gated rewrite ${EXPECTED_REMOTE:0:7} is already on origin/$BR; skipped reconcile + the recorded PR-body update and kept its intent for a real run." >&2
  exit 0
fi
if [ "$REWRITE" -eq 1 ] && [ "${#MISSING_SCOPE[@]}" -gt 0 ] && [ "$REWRITE_ALREADY_PUBLISHED" -eq 0 ]; then
  echo "rewrite brief omits paths from the existing PR:" >&2
  for p in "${MISSING_SCOPE[@]}"; do printf '  %q\n' "$p" >&2; done
  exit 1
fi

# Nothing to add? Abort before an empty commit (a re-push with no delta is a no-op, not a commit).
if git -C "$WT" diff --cached --quiet; then
  # A lost push response leaves the exact body-bearing intent in place even though the remote now
  # contains its commit. Resume must finish that recorded metadata mutation before spending the
  # intent. The same arm makes an explicit no-delta invocation a safe body-only repair. Serialize
  # it with body-bearing pushes and re-check the fetched head under the lock so an older repair can
  # never overwrite the description after a newer publisher advanced the branch.
  BODY_ONLY_UPDATE=0
  BODY_UPDATE_STATUS=0
  if [ "$UPDATE_PR_BODY" -eq 1 ] && [ -z "${SHIP_DRY_RUN:-}" ]; then
    BODY_ONLY_UPDATE=1
    if [ "$REWRITE" -eq 1 ]; then
      SHIP_COMMIT=$EXPECTED_REMOTE
      REMOTE_BODY_EXPECTED=$EXPECTED_REMOTE
    else
      SHIP_COMMIT=$BASE
      REMOTE_BODY_EXPECTED=$BASE
    fi
    if [ -z "${SHIP_INTENT_GENERATION:-}" ]; then
      echo "reship: PR body was not updated: this no-delta attempt does not own a recorded intent" >&2
      echo "  no PR metadata was changed; run the full command again or use gh pr edit manually" >&2
      BODY_UPDATE_STATUS=1
    else
      rewrite_publish_lock_acquire || exit 1
    fi
    # Generation ownership connects these body bytes to the accepted attempt. A stale resume whose
    # CAS lost to a newer full invocation must not relabel that newer head with its older body.
    if [ "$BODY_UPDATE_STATUS" -eq 0 ] && \
       ! node "$SHIP_INTENT" owns --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION"; then
      echo "reship: PR body was not updated: the recorded intent was superseded" >&2
      echo "  no PR metadata was changed; resume the current record or use gh pr edit manually" >&2
      BODY_UPDATE_STATUS=1
    fi
    REMOTE_BODY_HEAD=""
    if [ "$BODY_UPDATE_STATUS" -eq 0 ]; then
      REMOTE_BODY_HEAD=$(git ls-remote --heads origin "refs/heads/$BR" | awk 'NR == 1 { print $1 }') \
        || REMOTE_BODY_HEAD=""
    fi
    if [ "$BODY_UPDATE_STATUS" -eq 0 ] && [ "$REMOTE_BODY_HEAD" != "$REMOTE_BODY_EXPECTED" ]; then
      echo "reship: PR body was not updated: origin/$BR changed after the recovery fetch" >&2
      echo "  the recorded commit is already remote; no rollback was attempted" >&2
      echo "  resolve the current PR, then pipe the intended body to: gh pr edit <url> --repo '$REPO' --body-file -" >&2
      BODY_UPDATE_STATUS=1
    elif [ "$BODY_UPDATE_STATUS" -eq 0 ]; then
      PR_URL=$(gh pr view "$BR" --repo "$REPO" --json url -q .url 2>/dev/null) || PR_URL=""
      publish_requested_pr_body "$SHIP_COMMIT" || BODY_UPDATE_STATUS=$?
    fi
  fi
  if [ "$RESUME" -eq 1 ] && [ "$UPDATE_PR_BODY" -eq 1 ] && [ -n "${SHIP_DRY_RUN:-}" ]; then
    echo "DRY: no commit delta; skipped the recorded PR-body update and kept its intent for a real run." >&2
    exit 0
  fi
  # --ready is a state change on the PR, not on the push, so an empty delta does not excuse skipping
  # it. Done ONCE here rather than per exit arm below, and deliberately BEFORE the record is
  # released: every no-delta arm then attempts it, and a transient gh failure leaves the record
  # intact so the identical retry converges instead of finding nothing left to resume. PR_URL is
  # resolved first — several arms reach here without it, and the helper needs a PR to act on.
  NO_DELTA_READY=0
  if [ "$READY" -eq 1 ]; then
    [ -n "${PR_URL:-}" ] || PR_URL=$(gh pr view "$BR" --repo "$REPO" --json url -q .url 2>/dev/null) || PR_URL=""
    reship_mark_ready "${PR_NUM:-}" || exit 1
    NO_DELTA_READY=1
  fi
  # An empty delta means everything recorded is already on origin/$BR, so the record has nothing
  # left to resume — release it either way, or every retry re-reports "no changes" until it goes
  # stale (6h; the classic cause is a prior attempt killed after its push but before its release).
  # The message reports what actually happened: a lock-busy delete (exit 1) must NOT be described
  # as a release, or the operator deletes nothing and the next --resume replays it anyway.
  INTENT_DELETE_STATUS=0
  if [ -n "${SHIP_INTENT_GENERATION:-}" ]; then
    rewrite_delete_intent || INTENT_DELETE_STATUS=$?
  fi
  if [ -n "${SHIP_INTENT_GENERATION:-}" ] && [ "$INTENT_DELETE_STATUS" -eq 0 ]; then
    SI_NOTE="released the record"
  else
    SI_NOTE="the record was NOT released this run (see any warning above); it expires on its own in 6h"
  fi
  if [ "$BODY_ONLY_UPDATE" -eq 1 ]; then
    [ "$BODY_UPDATE_STATUS" -eq 0 ] || exit "$BODY_UPDATE_STATUS"
    if [ "$INTENT_DELETE_STATUS" -eq 1 ]; then
      echo "PR-body publication completed, but the spent intent stayed locked — do NOT resume it; clear the exact file named above" >&2
      exit 1
    fi
    body_receipt_delete
    rewrite_publish_lock_release
    echo "$PR_URL"
    exit 0
  fi
  if [ "$RESUME" -eq 1 ]; then
    # Converged, not "pushed": THIS run pushed nothing — the recorded content is simply already
    # on the remote (an earlier push, or edits that never changed the recorded paths).
    if [ "$REWRITE" -eq 1 ]; then
      echo "no changes vs origin/$BASE_REF — the prepared replacement is empty; $SI_NOTE" >&2
    else
      echo "no changes vs origin/$BR — everything recorded is already on the remote; $SI_NOTE" >&2
    fi
    exit 0
  fi
  if [ "$REWRITE" -eq 1 ]; then
    echo "no changes vs origin/$BASE_REF — nothing to publish as a replacement; $SI_NOTE" >&2
  else
    echo "no changes vs origin/$BR — nothing to re-push; $SI_NOTE" >&2
  fi
  # An empty delta is normally an error — the caller asked to push something and there was nothing.
  # But if the flip above ran, the requested end state IS now reality, so the retry has converged.
  [ "$NO_DELTA_READY" -eq 0 ] || { echo "marked the PR ready; there was nothing left to re-push" >&2; exit 0; }
  exit 1
fi

# Snapshot the index the instant staging finishes — the assertions around the commit hold the gate
# chain to it. See assert-staged-set.sh for the clobber this defends against.
. "$(dirname "${BASH_SOURCE[0]}")/assert-staged-set.sh"
ship_record_staged_state "$WT" "$STAGED_STATE"
# ...and prove the objects it names are readable — write-tree cannot, once its cache-tree is persisted
# (sc-1420). Same pair of checkpoints as new-ship.
ship_assert_staged_objects_readable "$WT" "after staging" || { ship_run_keep "staged objects unreadable after staging"; exit 1; }

# Only after caller content is staged: runtime symlinks must never enter the shipped diff.
prepare_gate_worktree "$WT" "$ROOT" shipping ${LINK_DIRS[@]+"${LINK_DIRS[@]}"}

# Link gate configs present in the repo but absent from this fresh checkout (an untracked config, a
# gitignored index) so the worktree gates match a plain commit instead of silently running on defaults.
. "$(dirname "${BASH_SOURCE[0]}")/link-gate-configs.sh"
link_untracked_gate_configs "$WT" "$ROOT"

if [ "$REWRITE_ALREADY_PUBLISHED" -eq 1 ]; then
  # The receipt proves this exact remote commit already passed this invocation's gates. Hold the
  # publication lock, re-check its head, then converge bookkeeping + metadata without another
  # commit or force-push. Reconcile is deliberately repeated below: a kill could have landed in the
  # push-to-bookkeeping window, and its replacement write is idempotent.
  rewrite_publish_lock_acquire || exit 1
  LOCKED_BODY_RECEIPT=$(git rev-parse -q --verify "$BODY_RECEIPT_REF^{commit}" 2>/dev/null || true)
  [ "$LOCKED_BODY_RECEIPT" = "$EXPECTED_REMOTE" ] || {
    echo "reship: recorded rewrite recovery refused: its gated receipt was superseded" >&2
    exit 1
  }
  LOCKED_BODY_PAYLOAD=$(git rev-parse -q --verify "$BODY_PAYLOAD_REF^{blob}" 2>/dev/null || true)
  [ "$LOCKED_BODY_PAYLOAD" = "$EXPECTED_BODY_PAYLOAD" ] || {
    echo "reship: recorded rewrite recovery refused: its exact body payload was superseded" >&2
    exit 1
  }
  node "$SHIP_INTENT" owns --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION" || {
    echo "reship: recorded rewrite recovery refused: its intent was superseded" >&2
    exit 1
  }
  RECOVERY_PR_FIELDS=$(rewrite_remote gh pr view "$BR" --repo "$REPO" \
    --json number,state,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,url \
    --jq '[.number,.state,.headRefName,.headRefOid,(.headRepository.nameWithOwner // ""),.baseRefName,.baseRefOid,.url] | @tsv' 2>/dev/null) || {
      echo "reship: recorded rewrite recovery refused: cannot re-check PR identity" >&2
      exit 1
    }
  [ "$RECOVERY_PR_FIELDS" = "$PR_FIELDS" ] || {
    echo "reship: recorded rewrite recovery refused: PR head/base identity changed after preflight" >&2
    exit 1
  }
  RECOVERY_BASE=$(rewrite_remote git ls-remote --heads origin "refs/heads/$BASE_REF" | awk 'NR == 1 { print $1 }')
  [ "$RECOVERY_BASE" = "$BASE" ] || {
    echo "reship: recorded rewrite recovery refused: origin/$BASE_REF moved after preflight" >&2
    exit 1
  }
  RECOVERY_REMOTE_HEAD=$(rewrite_remote git ls-remote --heads origin "refs/heads/$BR" | awk 'NR == 1 { print $1 }')
  [ "$RECOVERY_REMOTE_HEAD" = "$EXPECTED_REMOTE" ] || {
    echo "reship: recorded rewrite recovery refused: origin/$BR moved after preflight" >&2
    exit 1
  }
  SHIP_COMMIT=$EXPECTED_REMOTE
  echo "resuming gated rewrite ${SHIP_COMMIT:0:7}; skipped gates and force-push" >&2
else
# Commit (gates run HERE). Capture + surface the gate output for the shipping agent — git buries it on
# the commit's stderr. Shared with new-ship. See commit-with-gate-capture.sh.
. "$(dirname "${BASH_SOURCE[0]}")/commit-with-gate-capture.sh"
# The pinned parent the worktree was cut from — the PR tip for an append, or the PR base for a
# rewrite — lets in-chain gates (fallow) diff against it rather than their own main-autodetect.
export DEVKIT_SHIP_BASE_SHA="$BASE"
export DEVKIT_SHIP_SOURCE_HEAD="$CALLER_HEAD"   # pinned above, before staging (sc-2480)
export DEVKIT_SHIP_MODE=reship   # tags the ship_attempt telemetry (retry onto an existing branch)
export DEVKIT_RUN_MODE=ship      # never inherit a caller's review allowlist into a real ship
# Preflight before the multi-minute chain, then prove the commit still holds the briefed work before
# anything leaves the machine. Same invariants as new-ship (assert-staged-set.sh).
ship_assert_staged_unchanged "$WT" "$STAGED_STATE" || { ship_run_keep "staged set changed before the commit"; exit 1; }
ship_assert_staged_objects_readable "$WT" "preflight, before the commit" || { ship_run_keep "staged objects unreadable before the commit"; exit 1; }
commit_with_gate_capture "$WT" "$ROOT" "$BR" "$TITLE" "$BODY"
# Preserve the public signal contract across the post-wait reap window; a recorded interruption
# must stop before commit-scope verification or push even when its forwarded PID already exited.
[ "$REQUESTED_SIGNAL_STATUS" -eq 0 ] || exit "$REQUESTED_SIGNAL_STATUS"
ship_assert_commit_scope "$WT" "$BASE" "$STAGED_STATE" || { ship_run_keep "commit scope assertion failed"; exit 1; }

if [ -n "${SHIP_DRY_RUN:-}" ]; then
  if [ "$REWRITE" -eq 1 ]; then
    echo "DRY: committed replacement for $BR onto $BASE_REF (worktree $WT), skipped push." >&2
  else
    echo "DRY: committed locally onto $BR (worktree $WT), skipped push." >&2
  fi
  git -C "$WT" show --stat --oneline HEAD >&2
  rewrite_ref_cleanup
  trap - EXIT  # keep the worktree for inspection
  echo "DRY: worktree kept at $WT. Remove with: git worktree remove --force '$WT'" >&2
  exit 0
fi

# An append fast-forwards. An explicit rewrite uses the exact PR-head OID captured before gates as
# its lease; either path rejects a concurrent branch advance rather than overwriting it.
# sc-1508: same content-keyed skip seam as ship-branch.sh — hand the pre-push hook this commit's sha so
# it skips its typecheck + test:run for this one commit (CI re-runs both on the PR); any other ref fails
# closed to the full suite.
SHIP_COMMIT=$(git -C "$WT" rev-parse HEAD)
if { [ "$REWRITE" -eq 1 ] || [ "$UPDATE_PR_BODY" -eq 1 ]; } &&
   [ "$REWRITE_PUBLISH_OWNED" -eq 0 ]; then
  # A body-bearing append shares the rewrite publisher's per-branch lock from push through metadata
  # edit. Receipt recovery already owns it; every fresh publisher acquires it exactly once here.
  rewrite_publish_lock_acquire || exit 1
fi
if [ "$UPDATE_PR_BODY" -eq 1 ]; then
  # Intent writes take this same lock. Re-prove ownership only after acquiring it so a newer
  # invocation that started while this one ran gates wins before either the branch or PR body moves.
  if ! node "$SHIP_INTENT" owns --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION"; then
    echo "reship: publication refused: the recorded PR-body intent was superseded while gates ran; nothing pushed" >&2
    exit 1
  fi
fi
if [ "$REWRITE" -eq 1 ]; then
  CURRENT_PR_FIELDS=$(rewrite_remote gh pr view "$BR" --repo "$REPO" \
    --json number,state,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,url \
    --jq '[.number,.state,.headRefName,.headRefOid,(.headRepository.nameWithOwner // ""),.baseRefName,.baseRefOid,.url] | @tsv' 2>/dev/null) || {
      echo "rewrite rejected: cannot re-check PR identity before push" >&2; exit 1
    }
  [ "$CURRENT_PR_FIELDS" = "$PR_FIELDS" ] || {
    echo "rewrite rejected: PR head/base identity changed during gates; no history was overwritten" >&2
    exit 1
  }
  CURRENT_BASE=$(rewrite_remote git ls-remote --heads origin "refs/heads/$BASE_REF" | awk 'NR == 1 { print $1 }')
  [ "$CURRENT_BASE" = "$BASE" ] || {
    echo "rewrite rejected: origin/$BASE_REF advanced after preflight (expected $BASE, found ${CURRENT_BASE:-missing})" >&2
    exit 1
  }
  if [ "$UPDATE_PR_BODY" -eq 1 ]; then
    # Persist the exact gated object BEFORE publication. If the publisher is killed after Git
    # accepts it, the retained intent can prove and converge this snapshot without manufacturing a
    # second replacement commit. Branch + commit key both refs so sibling PRs at the same OID cannot
    # share proof; the publication lock serializes byte-different bodies that normalize identically.
    BODY_RECEIPT_REF="$BODY_RECEIPT_PREFIX/$BR/$SHIP_COMMIT"
    BODY_PAYLOAD_REF="$BODY_PAYLOAD_PREFIX/$BR/$SHIP_COMMIT"
    BODY_PAYLOAD_BLOB=$(printf '%s\0%s' "$TITLE" "$BODY" | git hash-object -w --stdin) || {
      echo "rewrite rejected: could not persist the exact body-payload proof; nothing pushed" >&2
      exit 1
    }
    git update-ref "$BODY_PAYLOAD_REF" "$BODY_PAYLOAD_BLOB" || {
      echo "rewrite rejected: could not persist the exact body-payload proof; nothing pushed" >&2
      exit 1
    }
    git update-ref "$BODY_RECEIPT_REF" "$SHIP_COMMIT" || {
      git update-ref -d "$BODY_PAYLOAD_REF" "$BODY_PAYLOAD_BLOB" 2>/dev/null || true
      echo "rewrite rejected: could not persist the gated-commit recovery receipt; nothing pushed" >&2
      exit 1
    }
  fi
  # Freshness check only: the base is independently owned and can advance immediately before OR
  # after any head push, leaving the PR safely behind in either case. The destructive invariant is
  # the exact CAS on the PR head below; never attempt to update/freeze the base as part of this push.
  PUSH_STATUS=0
  DEVKIT_SHIP_PREPUSH_SKIP_SHA="$SHIP_COMMIT" rewrite_remote git -C "$WT" push \
    --force-with-lease="refs/heads/$BR:$EXPECTED_REMOTE" origin "HEAD:refs/heads/$BR" || PUSH_STATUS=$?
  if [ "$PUSH_STATUS" -ne 0 ]; then
    # A transport can fail after receive-pack committed the update. Adopt only this run's exact
    # gated OID; every other remote value is a real lease/transport failure and remains resumable.
    REMOTE_AFTER_FAILED_PUSH=$(rewrite_remote git ls-remote --heads origin "refs/heads/$BR" | awk 'NR == 1 { print $1 }')
    if [ "$REMOTE_AFTER_FAILED_PUSH" = "$SHIP_COMMIT" ]; then
      echo "push response failed after origin accepted the exact gated rewrite; finishing bookkeeping" >&2
    else
      echo "expected-OID lease rejected or transport failed for origin/$BR; the exact gated head could not be confirmed — verify the remote before resuming" >&2
      body_receipt_delete
      exit 1
    fi
  fi
  echo "replaced origin/$BR (${EXPECTED_REMOTE:0:7} → ${SHIP_COMMIT:0:7}) with one gated commit on $BASE_REF" >&2
else
  DEVKIT_SHIP_PREPUSH_SKIP_SHA="$SHIP_COMMIT" git -C "$WT" push origin "HEAD:$BR" || {
    echo "push to origin/$BR rejected (not a fast-forward — the branch advanced). Re-run after fetching." >&2
    exit 1
  }
fi
fi

# Multi-commit append: extend this branch's reconcile entry with this commit's paths. A full-scope
# rewrite instead replaces that entry with the replacement commit's final diff against the pinned
# PR base; paths removed from the old PR must not survive as stale reconcile debt.
# devkit's own modules are .mts in the source tree (Node strips types) and compiled .mjs in an
# installed consumer (dist). Prefer whichever exists beside this script.
RMW="$SCRIPT_DIR/reconcile-manifest-write.mts"; [ -f "$RMW" ] || RMW="$SCRIPT_DIR/reconcile-manifest-write.mjs"
if [ "$REWRITE" -eq 1 ]; then
  FINAL_SCOPE_FILE=$(mktemp "${TMPDIR:-/tmp}/reship-final.XXXXXX")
  git -C "$WT" diff --name-only --no-renames -z "$BASE" "$SHIP_COMMIT" -- > "$FINAL_SCOPE_FILE"
  FINAL_PATHS=()
  while IFS= read -r -d '' final_path; do FINAL_PATHS+=("$final_path"); done < "$FINAL_SCOPE_FILE"
  if ! node "$RMW" \
    --root "$ROOT" --git-root "$WT" --branch "$BR" --repo "$REPO" --base-ref "$BASE_REF" \
    --base-sha "$BASE" --tip-sha "$SHIP_COMMIT" --pr "$PR_NUM" -- "${FINAL_PATHS[@]}"; then
    if [ "$REWRITE_ALREADY_PUBLISHED" -eq 1 ]; then
      echo "reconcile state was not replaced; kept the exact gated receipt and intent for a safe resume" >&2
      echo "  origin/$BR remains at $SHIP_COMMIT; resume again after the manifest writer is available" >&2
      exit 1
    fi
    # Restore the exact pre-rewrite head only while the remote still names OUR new commit. This is
    # compensation, not publication, so bypassing pre-push cannot introduce un-gated content. If an
    # external actor already advanced the head, the lease refuses and their work wins.
    if rewrite_remote git -C "$WT" push --no-verify --force-with-lease="refs/heads/$BR:$SHIP_COMMIT" \
      origin "$EXPECTED_REMOTE:refs/heads/$BR"; then
      echo "reconcile state was not replaced; restored origin/$BR to $EXPECTED_REMOTE — intent kept for a safe resume" >&2
    else
      echo "reconcile state was not replaced and origin/$BR advanced again; rollback refused — clearing this spent intent" >&2
      [ -z "${SHIP_INTENT_GENERATION:-}" ] || rewrite_delete_intent force || true
      echo "  do not resume this attempt; reconcile the concurrent head separately" >&2
    fi
    body_receipt_delete
    exit 1
  fi
  # A rewrite is not complete until its old accumulated reconcile scope has been replaced. A
  # body-bearing rewrite retains the intent a little longer, through the metadata mutation below,
  # so a process death in that window can converge via the no-delta recovery arm.
  if [ -n "${SHIP_INTENT_GENERATION:-}" ] && [ "$UPDATE_PR_BODY" -eq 0 ]; then
    DELETE_STATUS=0
    rewrite_delete_intent || DELETE_STATUS=$?
    if [ "$DELETE_STATUS" -eq 1 ]; then
      echo "rewrite and reconcile completed, but the spent intent stayed locked — do NOT resume it; clear the exact file named above" >&2
      exit 1
    fi
    # Exit 2 is intentional: a concurrently donated path still needs its own future rewrite.
  fi
else
  # An append preserves the established best-effort bookkeeping contract: the pushed delta is
  # already complete. A body-bearing append defers intent retirement through the metadata attempt;
  # without an explicit body, retain the established immediate-release behavior.
  if [ "$UPDATE_PR_BODY" -eq 0 ]; then
    [ -z "${SHIP_INTENT_GENERATION:-}" ] || node "$SHIP_INTENT" delete --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION" -- ${PATHS[@]+"${PATHS[@]}"} || true
  fi
  node "$RMW" \
    --root "$ROOT" --git-root "$WT" --branch "$BR" --base-sha "$BASE" --tip-sha "$SHIP_COMMIT" --merge -- "${PATHS[@]}" \
    || echo "reship: reconcile manifest not updated (non-fatal)" >&2
  PR_URL=$(gh pr view "$BR" --repo "$REPO" --json url -q .url 2>/dev/null) || PR_URL=""
fi

# The commit is already remote. Keep the recorded body intent until gh returns: a killed publisher
# then resumes through the locked no-delta arm instead of losing the requested mutation. Once gh
# returns — success or a named failure with a manual remedy — retire this generation. The resolved
# URL is exact even for fork PRs or duplicate names.
if [ "$UPDATE_PR_BODY" -eq 1 ]; then
  BODY_UPDATE_STATUS=0
  publish_requested_pr_body "$SHIP_COMMIT" || BODY_UPDATE_STATUS=$?
  if [ "$REWRITE" -eq 1 ]; then
    if [ -n "${SHIP_INTENT_GENERATION:-}" ]; then
      DELETE_STATUS=0
      rewrite_delete_intent || DELETE_STATUS=$?
      if [ "$DELETE_STATUS" -eq 1 ]; then
        echo "rewrite and reconcile completed, but the spent intent stayed locked — do NOT resume it; clear the exact file named above" >&2
        [ "$BODY_UPDATE_STATUS" -ne 0 ] || exit 1
      fi
      # Exit 2 is intentional: a concurrently donated path still needs its own future rewrite.
    fi
  else
    if [ -n "${SHIP_INTENT_GENERATION:-}" ]; then
      DELETE_STATUS=0
      rewrite_delete_intent || DELETE_STATUS=$?
      if [ "$DELETE_STATUS" -eq 1 ]; then
        echo "commit and PR-body publication completed, but the spent intent stayed locked — do NOT resume it; clear the exact file named above" >&2
        [ "$BODY_UPDATE_STATUS" -ne 0 ] || exit 1
      fi
      # Exit 2 keeps a newer donated path for its own future publication.
    fi
  fi
  body_receipt_delete
  [ "$BODY_UPDATE_STATUS" -eq 0 ] || exit "$BODY_UPDATE_STATUS"
fi
rewrite_publish_lock_release

if [ -n "$PR_URL" ]; then
  [ "$REWRITE" -eq 1 ] || PR_NUM=${PR_URL##*/}
  if [[ "$PR_NUM" =~ ^[0-9]+$ ]] && [ "$QAVIS_PUBLISH" -eq 1 ]; then
    . "$SCRIPT_DIR/publish-qavis.sh"
    publish_qavis_receipt "$ROOT" "$PR_NUM" "$BASE" "$SHIP_COMMIT"
  fi
  # Flip out of draft LAST, once the commit, the reconcile record and any body publication are all
  # durable — a gh failure here can never cost work that already landed.
  READY_STATUS=0
  reship_mark_ready "${PR_NUM:-}" || READY_STATUS=1
  echo "$PR_URL"
  # Non-zero only after the URL is printed: the re-push succeeded, the requested flip did not.
  [ "$READY_STATUS" -eq 0 ] || exit 1
else
  if [ "$READY" -eq 1 ]; then
    echo "re-pushed to origin/$BR, but the requested --ready flip did not happen." >&2
    reship_mark_ready "" || true
    exit 1
  fi
  echo "re-pushed to origin/$BR"
fi
