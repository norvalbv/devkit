#!/usr/bin/env bash
# devkit ship --pr <branch>: add the current changes to an EXISTING PR's branch as a NEW commit,
# fast-forward push (NEVER --force) — iterate on an open PR without overwriting its history.
#
# Why a separate flow from new-ship (ship-branch.sh): the base is the EXISTING remote branch tip
# (origin/<branch>), not this checkout's HEAD; the branch must already exist (the opposite preflight);
# the new commit is the DELTA between that tip and your current files (so we copy current content
# over the fetched tip rather than replay a HEAD-relative patch, which could conflict with the
# first ship's content); and we push ff to the branch (no -u, no new PR). The shared worktree +
# symlink + marker ceremony is duplicated rather than shared so this flow can't perturb new-ship.
# fallow-ignore-next-line code-duplication
#
# Usage:  ship --pr <branch> "<title>" [--link <d>]... [--] <path...>
#         ship <branch> "<title>" --pr [--link <d>]... [--] <path...>   # equivalent
#         ship --resume <branch> [--body-file <f>] [--] <extra-path...> # replay the recorded attempt
#         # body via stdin, --body or --body-file. The <branch> is the existing PR's head branch.
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
    'ship --pr <branch> "<title>" [--body "<text>"] [--body-file <f>] [--link <d>]... [--] <path...>'
fi

LINK_EXTRA=()
PATHS=()
BODY_SET=0         # --body given? else --body-file, else stdin (back-compat)
BODY_FILE_SET=0    # --body-file <path>: author the body once in a file; survives every retry
QAVIS_PUBLISH=1    # suppresses only the post-push description write, never the staged gate
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr) shift ;;                                                   # mode flag (already routed here) — ignore
    --link)
      [ "$RESUME" -eq 0 ] || { echo "--resume replays the recorded invocation — to change --link, run the full devkit ship --pr command (it re-records)" >&2; exit 1; }
      LINK_EXTRA+=("${2:?--link requires a directory}"); shift 2 ;;
    --body) BODY_FLAG="${2:?--body requires text}"; BODY_SET=1; shift 2 ;;
    --body-file) BODY_FILE_FLAG="${2:?--body-file requires a path}"; BODY_FILE_SET=1; shift 2 ;;
    --no-qavis-publish) QAVIS_PUBLISH=0; shift ;;
    --resume) echo "--resume must come FIRST: devkit ship --resume <branch> [--] <extra-path...>" >&2; exit 1 ;;
    --) shift; while [ "$#" -gt 0 ]; do PATHS+=("$1"); shift; done; break ;;
    -*) echo "unknown flag: $1 (pass a dash-leading file path after --)" >&2; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done
[ "$BODY_SET" -eq 0 ] || [ "$BODY_FILE_SET" -eq 0 ] || { echo "--body and --body-file are mutually exclusive" >&2; exit 1; }

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
  [ "${#SI_FIELDS[@]}" -ge 9 ] || { echo "recorded invocation is malformed — run the full devkit ship --pr command" >&2; exit 1; }
  SI_MODE=${SI_FIELDS[0]}
  if [ "$SI_MODE" = "ship" ]; then
    # The blocked attempt was a NEW ship; hand over. Positive match + one-shot marker — an
    # unrecognised mode hard-errors below, never bounces between the two scripts.
    [ -z "${DEVKIT_SHIP_RESUME_DISPATCHED:-}" ] || { echo "recorded invocation dispatched in a loop (mode '$SI_MODE') — the manifest is inconsistent; run the full command" >&2; exit 1; }
    DEVKIT_SHIP_RESUME_DISPATCHED=1 exec bash "$RESUME_SCRIPT_DIR/ship-branch.sh" --resume "$BR" ${RESUME_ARGS[@]+"${RESUME_ARGS[@]}"}
  fi
  [ "$SI_MODE" = "reship" ] || { echo "recorded invocation has unrecognised mode '$SI_MODE' — run the full devkit ship --pr command" >&2; exit 1; }
  TITLE=${SI_FIELDS[1]}
  [ "${SI_FIELDS[3]}" != "1" ] || QAVIS_PUBLISH=0
  RESUME_CREATED=${SI_FIELDS[4]}
  RESUME_GENERATION=${SI_FIELDS[5]}
  SI_NLINKS=${SI_FIELDS[6]}
  case "$SI_NLINKS" in *[!0-9]*|'') echo "recorded invocation is malformed (nlinks '$SI_NLINKS')" >&2; exit 1 ;; esac
  si_i=7
  si_body_at=$((7 + SI_NLINKS))
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
# Resolve owner/repo from origin (best-effort — only used for the final PR-URL print, which falls
# back to a plain message; a non-GitHub origin still re-pushes fine).
REPO=$(git remote get-url origin | sed -E 's#^.*github\.com[^:/]*[:/]##; s#\.git$##')

# Test seam: print the resolved target + repo, then exit BEFORE any side effect (no fetch / push).
[ -n "${SHIP_RESOLVE_ONLY:-}" ] && { printf 'BR=%s\nREPO=%s\n' "$BR" "$REPO"; exit 0; }

if [ -z "${SHIP_DRY_RUN:-}" ] && ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed (needed to resolve the PR URL)" >&2; exit 1
fi

# The PR branch MUST already exist on the remote — re-push targets it. Fetch its tip; that fetched
# commit is the BASE the new commit sits on (so the diff is exactly the new delta).
git fetch origin "$BR" 2>/dev/null || {
  echo "no remote branch origin/$BR to re-push to — open the PR first (ship without --pr)" >&2; exit 1
}
BASE=$(git rev-parse FETCH_HEAD)

# Match new-ship: run against the caller checkout before the detached worktree hides ignored,
# unbriefed dist artifacts. The helper no-ops for every consumer repo.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mts"
[ -f "$DIST_INTEGRITY" ] || DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mjs"
node "$DIST_INTEGRITY" --root "$ROOT" --base "$BASE" -- "${PATHS[@]}"

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

WT="${TMPDIR:-/tmp}/devkit-reship-${BR//\//-}-$$"
STAGED_STATE=$(mktemp "${TMPDIR:-/tmp}/reship-staged.XXXXXX")
# Body: --body "<text>" wins (explicit, no temp file); then --body-file; then — on --resume — the
# recorded body with stdin never consulted; else the same bounded stdin contract as new-ship so an
# inherited, open-but-idle background-task pipe cannot block re-ship forever.
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
export DEVKIT_SHIP_RESUMED=$RESUME
SHIP_INTENT_ARGS=(write --root "$ROOT" --branch "$BR" --mode reship --title "$TITLE")
for d in ${LINK_EXTRA[@]+"${LINK_EXTRA[@]}"}; do SHIP_INTENT_ARGS+=(--link "$d"); done
[ "$QAVIS_PUBLISH" -eq 1 ] || SHIP_INTENT_ARGS+=(--no-qavis-publish)
if [ "$RESUME" -eq 1 ]; then
  SHIP_INTENT_ARGS+=(--resumed --merge-paths --expect-generation "$RESUME_GENERATION")
  for p in ${RESUME_EXTRA_PATHS[@]+"${RESUME_EXTRA_PATHS[@]}"}; do SHIP_INTENT_ARGS+=(--donate "$p"); done
fi
# Capture the record's generation stamp — success deletes only what this attempt wrote (see
# ship-branch.sh's twin).
SHIP_INTENT_GENERATION=$(printf '%s' "$BODY" | node "$SHIP_INTENT" "${SHIP_INTENT_ARGS[@]}" -- "${PATHS[@]}") \
  || { SHIP_INTENT_GENERATION=""; echo "reship: invocation not recorded — the retry needs the full command (non-fatal)" >&2; }
# Same exported flag as ship-branch.sh: the subprocess timeout banner must not advertise --resume
# for an attempt that was never recorded.
export DEVKIT_SHIP_INTENT_RECORDED=$([ -n "$SHIP_INTENT_GENERATION" ] && echo 1 || echo 0)

KEEP_WT=  # set by a staged-set abort: the clobbered index IS the evidence, so never reclaim it
cleanup() {
  rm -f "$STAGED_STATE"
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

# Detached worktree at the PR branch tip — the new commit is parented on origin/<branch>.
git worktree add -q --detach "$WT" "$BASE" >&2
# branch_created=0 always: this worktree is detached and holds no branch, so nothing may ever delete
# one on its behalf. The record exists so a leftover re-ship worktree is attributable to the process
# that made it, the same way new-ship's is.
ship_run_record_begin "$WT" "$BR" "$BASE" 0 reship

# Copy the CURRENT content of each path over the fetched tip (add/modify), or delete it. The commit
# diff is therefore (origin/<branch> tip → your current files) = exactly the new delta, with no
# HEAD-relative patch that could clash with the first ship's content.
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

# Nothing to add? Abort before an empty commit (a re-push with no delta is a no-op, not a commit).
if git -C "$WT" diff --cached --quiet; then
  # An empty delta means everything recorded is already on origin/$BR, so the record has nothing
  # left to resume — release it either way, or every retry re-reports "no changes" until it goes
  # stale (6h; the classic cause is a prior attempt killed after its push but before its release).
  # The message reports what actually happened: a lock-busy delete (exit 1) must NOT be described
  # as a release, or the operator deletes nothing and the next --resume replays it anyway.
  if [ -n "${SHIP_INTENT_GENERATION:-}" ] && node "$SHIP_INTENT" delete --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION" -- ${PATHS[@]+"${PATHS[@]}"}; then
    SI_NOTE="released the record"
  else
    SI_NOTE="the record was NOT released this run (see any warning above); it expires on its own in 6h"
  fi
  if [ "$RESUME" -eq 1 ]; then
    # Converged, not "pushed": THIS run pushed nothing — the recorded content is simply already
    # on the remote (an earlier push, or edits that never changed the recorded paths).
    echo "no changes vs origin/$BR — everything recorded is already on the remote; $SI_NOTE" >&2
    exit 0
  fi
  echo "no changes vs origin/$BR — nothing to re-push; $SI_NOTE" >&2; exit 1
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

# Commit (gates run HERE). Capture + surface the gate output for the shipping agent — git buries it on
# the commit's stderr. Shared with new-ship. See commit-with-gate-capture.sh.
. "$(dirname "${BASH_SOURCE[0]}")/commit-with-gate-capture.sh"
# The fetched PR-branch tip the worktree was cut from — lets in-chain gates (fallow) diff against IT,
# not their own main-autodetect (DK-5).
export DEVKIT_SHIP_BASE_SHA="$BASE"
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
  echo "DRY: committed locally onto $BR (worktree $WT), skipped push." >&2
  git -C "$WT" show --stat --oneline HEAD >&2
  trap - EXIT  # keep the worktree for inspection
  echo "DRY: worktree kept at $WT. Remove with: git worktree remove --force '$WT'" >&2
  exit 0
fi

# Fast-forward push to the existing branch (NO --force). If origin/<branch> advanced since the fetch,
# this is rejected — the human resolves rather than overwriting someone's commit.
# sc-1508: same content-keyed skip seam as ship-branch.sh — hand the pre-push hook this commit's sha so
# it skips its typecheck + test:run for this one commit (CI re-runs both on the PR); any other ref fails
# closed to the full suite.
SHIP_COMMIT=$(git -C "$WT" rev-parse HEAD)
DEVKIT_SHIP_PREPUSH_SKIP_SHA="$SHIP_COMMIT" git -C "$WT" push origin "HEAD:$BR" || {
  echo "push to origin/$BR rejected (not a fast-forward — the branch advanced). Re-run after fetching." >&2
  exit 1
}

# The push landed — the recorded invocation is spent; release it FIRST, before the best-effort
# post-push bookkeeping below, so a kill in that window cannot strand a spent record. Compare-and-
# deleted on the captured generation so a concurrent attempt's newer record survives, and the
# shipped paths are handed over so a record carrying a concurrently-donated UNSHIPPED remedy path
# is kept for its --resume. Stderr stays visible: a lock-busy keep must be seen.
[ -z "${SHIP_INTENT_GENERATION:-}" ] || node "$SHIP_INTENT" delete --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION" -- ${PATHS[@]+"${PATHS[@]}"} || true

# Multi-commit PR: extend this branch's reconcile entry with the paths THIS commit shipped (the initial
# `devkit ship` created it). Best-effort — a miss only costs a manual reconcile, never unwinds the push.
# --git-root "$WT": hash the just-committed (shipped) blobs. --base-sha "$BASE" (the PR-branch tip): classify
# this commit's delta. --merge: keep the entry's PR metadata, overlay paths by path. (gh-free.)
# devkit's own modules are .mts in the source tree (Node strips types) and compiled .mjs in an
# installed consumer (dist). Prefer whichever exists beside this script.
RMW="$SCRIPT_DIR/reconcile-manifest-write.mts"; [ -f "$RMW" ] || RMW="$SCRIPT_DIR/reconcile-manifest-write.mjs"
node "$RMW" \
  --root "$ROOT" --git-root "$WT" --branch "$BR" --base-sha "$BASE" --merge -- "${PATHS[@]}" \
  || echo "reship: reconcile manifest not updated (non-fatal)" >&2

PR_URL=$(gh pr view "$BR" --repo "$REPO" --json url -q .url 2>/dev/null) || PR_URL=""
if [ -n "$PR_URL" ]; then
  PR_NUM=${PR_URL##*/}
  if [[ "$PR_NUM" =~ ^[0-9]+$ ]] && [ "$QAVIS_PUBLISH" -eq 1 ]; then
    . "$SCRIPT_DIR/publish-qavis.sh"
    publish_qavis_receipt "$ROOT" "$PR_NUM" "$BASE" "$SHIP_COMMIT"
  fi
  echo "$PR_URL"
else
  echo "re-pushed to origin/$BR"
fi
