#!/usr/bin/env bash
# Commit <path...> onto a NEW branch and open a PR WITHOUT switching this checkout.
#
# Why: parallel agents share one working tree, so HEAD/branch is global to it. A
# normal `git checkout -b` + commit moves HEAD for every agent in the tree, and
# the multi-minute hook chain widens the window for a parallel commit to land on
# the wrong branch. Instead we commit inside an ephemeral linked worktree: the
# shared tree's HEAD never moves (parallel work undisturbed) and the gates still
# run (the commit happens in the worktree, not via plumbing that skips hooks).
#
# A fresh linked worktree checks out clean at HEAD, so it lacks the gitignored
# deps the gates need (node_modules, and whatever else a repo passes via --link:
# e.g. a search index, a graph). We symlink them from the main checkout so the
# gates actually run instead of failing open.
#
# QA stays in the shared tree — the worktree exists only for the commit instant
# and is removed on exit. Scope is explicit paths; never auto-detect, because in a
# shared tree your files are indistinguishable from parallel work.
#
# Usage:   ship-branch.sh <branch> "<title>" [--dry-gates] [--base <b>] [--body-file <f>] [--link <d>]... [--] <path...>
#          # PR body via stdin, --body or --body-file; bare positional paths (no --) are accepted.
# Retry:   ship-branch.sh --resume <branch> [--body-file <f>] [--] <extra-path...>
#          # replays the invocation recorded by the previous attempt (ship-intent.mts)
# Preview: SHIP_DRY_RUN=1 ship-branch.sh ...   # local commit, no push/PR
# Rehearse: ship-branch.sh ... --dry-gates     # exact ship staging + selected pre-commit gates only
set -euo pipefail

# Hoisted above the orphan preflight below, which runs before anything else this script sources.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# run-packaged-script.mts hands its private signal-lock root to the managed child. Only
# review-target.sh implements that handshake; ship inherits the variable and forwards the caller
# environment intact, so leaving it set would export an unread private path into every gate, hook and
# nested command — and a nested `devkit review` would take the lock and hold it, after which the
# outer wrapper stops forwarding signals to THIS ship entirely. Ship's own bash traps
# (gate-signal-handoff.sh) already produce the same exit statuses, so dropping it costs nothing.
unset DEVKIT_MANAGED_SIGNAL_ROOT

# Before ANY git that can reach the network. Under the managed spawn this script runs in a background
# process group, where a tool that opens /dev/tty is SIGTTIN-suspended rather than prompted — a silent
# hang, not an error. ls-remote/fetch happen long before the PR body is read, so these cannot wait for
# the redirect below: an unknown host key or a passphrase with no agent would wedge the run. Same
# ordering review-target.sh uses. An explicit GIT_SSH_COMMAND stays the caller's.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"

# `--resume <branch>` replays the invocation the previous attempt recorded (ship-intent.mts). A
# gate block deletes the ephemeral worktree AND branch, so before the manifest existed every retry
# re-supplied title + full path list + multi-KB body verbatim — and the landed-commit resume below
# refuses on a single differing byte. Leading position only, stripped BEFORE the positional binds:
# `${2:?title}` under set -u would abort on the title --resume deliberately omits.
RESUME=0
[ "${1:-}" = "--resume" ] && { RESUME=1; shift; }
BR=${1:?branch}
if [ "$RESUME" -eq 1 ]; then
  shift 1
  TITLE=""                # loaded from the recorded invocation below
  RESUME_ARGS=("$@")      # kept verbatim for the cross-mode exec into reship.sh
else
  TITLE=${2:?title}; shift 2
fi

# Reject a flag sitting in a positional slot, before anything treats BR/TITLE as real values.
. "$SCRIPT_DIR/assert-positional-args.sh"
if [ "$RESUME" -eq 1 ]; then
  ship_assert_positional_args "$BR" "" \
    'ship --resume <branch> [--body-file <f>] [--] <extra-path...>'
else
  ship_assert_positional_args "$BR" "$TITLE" \
    'ship <branch> "<title>" [--base <b>] [--body "<text>"] [--body-file <f>] [--link <d>]... [--] <path...>'
fi

# Arg grammar: branch + title are the first two positionals (above). The rest is a mix of
# repeatable --link flags and file paths; `--` forces everything after it to be a
# path (so a file literally named like a flag, or starting with `-`, ships safely). A bare arg
# that is not a known flag is also a path — preserving the old `<branch> <title> <path...>` form.
LINK_EXTRA=()      # extra symlink dirs beyond the universal base
PATHS=()
DRY_GATES=0        # exact ship staging + deterministic/comment gates; no commit, branch, push or PR
BODY_SET=0         # --body given? else --body-file, else stdin (back-compat)
BODY_FILE_SET=0    # --body-file <path>: author the body ONCE in a file; survives every retry
BASE_FLAG=""       # --base <branch>? else base off this checkout's HEAD/current branch
QAVIS_PUBLISH=1     # passed staged evidence is published after the PR exists; explicit opt-out only
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      # Under --resume only the body may be overridden: a changed base/link set is a DIFFERENT ship,
      # and replaying the rest of the record around it would misdescribe what was asked for.
      [ "$RESUME" -eq 0 ] || { echo "--resume replays the recorded invocation — to change --base, run the full devkit ship command (it re-records)" >&2; exit 1; }
      BASE_FLAG="${2:?--base requires a branch}"; shift 2 ;;
    --link)
      [ "$RESUME" -eq 0 ] || { echo "--resume replays the recorded invocation — to change --link, run the full devkit ship command (it re-records)" >&2; exit 1; }
      LINK_EXTRA+=("${2:?--link requires a directory}"); shift 2 ;;
    --body) BODY_FLAG="${2:?--body requires text}"; BODY_SET=1; shift 2 ;;
    --body-file) BODY_FILE_FLAG="${2:?--body-file requires a path}"; BODY_FILE_SET=1; shift 2 ;;
    --dry-gates)
      [ "$RESUME" -eq 0 ] || { echo "--dry-gates cannot be combined with --resume" >&2; exit 1; }
      DRY_GATES=1; shift ;;
    --no-qavis-publish) QAVIS_PUBLISH=0; shift ;;
    --resume) echo "--resume must come FIRST: devkit ship --resume <branch> [--] <extra-path...>" >&2; exit 1 ;;
    --) shift; while [ "$#" -gt 0 ]; do PATHS+=("$1"); shift; done; break ;;
    -*) echo "unknown flag: $1 (pass a dash-leading file path after --)" >&2; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done
# Two body sources cannot both win, and silently preferring one would make the OTHER the operator's
# unnoticed dead argument — refuse instead.
[ "$BODY_SET" -eq 0 ] || [ "$BODY_FILE_SET" -eq 0 ] || { echo "--body and --body-file are mutually exclusive" >&2; exit 1; }

# Hoisted above the --resume load (which needs it); everything below the worktree ceremony reads it.
ROOT=$(git rev-parse --show-toplevel)

# devkit's own modules are .mts in the source tree (Node strips types) and compiled .mjs in an
# installed consumer (dist) — same fallback the reconcile writer uses.
SHIP_INTENT="$SCRIPT_DIR/ship-intent.mts"; [ -f "$SHIP_INTENT" ] || SHIP_INTENT="$SCRIPT_DIR/ship-intent.mjs"
RESUME_BODY=
if [ "$RESUME" -eq 1 ]; then
  # NUL-delimited so every field survives byte-exact (a body holds newlines; a path may hold almost
  # anything). bash 3.2 floor: plain `read -r -d ''` per field — no mapfile/readarray. The trailing
  # empty read at EOF fails in the while CONDITION, which set -e does not treat as an error.
  SI_OUT=$(mktemp "${TMPDIR:-/tmp}/ship-intent-read.XXXXXX")
  if ! node "$SHIP_INTENT" read --root "$ROOT" --branch "$BR" > "$SI_OUT"; then
    rm -f "$SI_OUT"; exit 1   # ship-intent already printed the named refusal (absent/stale/mismatch)
  fi
  SI_FIELDS=()
  while IFS= read -r -d '' si_field; do SI_FIELDS+=("$si_field"); done < "$SI_OUT"
  rm -f "$SI_OUT"
  # Field order is ship-intent.mts's emitFields contract:
  #   mode, title, base, noQavisPublish, createdAt, generation, nlinks, <links...>, body, <paths...>
  [ "${#SI_FIELDS[@]}" -ge 9 ] || { echo "recorded invocation is malformed — run the full devkit ship command" >&2; exit 1; }
  SI_MODE=${SI_FIELDS[0]}
  if [ "$SI_MODE" = "reship" ]; then
    # The blocked attempt was a `--pr` re-push; hand over so the agent needn't remember which form
    # it used. POSITIVE match + one-shot marker only — an unrecognised mode must hard-error below,
    # never bounce between the two scripts.
    [ -z "${DEVKIT_SHIP_RESUME_DISPATCHED:-}" ] || { echo "recorded invocation dispatched in a loop (mode '$SI_MODE') — the manifest is inconsistent; run the full command" >&2; exit 1; }
    DEVKIT_SHIP_RESUME_DISPATCHED=1 exec bash "$SCRIPT_DIR/reship.sh" --resume "$BR" ${RESUME_ARGS[@]+"${RESUME_ARGS[@]}"}
  fi
  [ "$SI_MODE" = "ship" ] || { echo "recorded invocation has unrecognised mode '$SI_MODE' — run the full devkit ship command" >&2; exit 1; }
  TITLE=${SI_FIELDS[1]}
  BASE_FLAG=${SI_FIELDS[2]}
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
  # Recorded paths first, then any NEW paths this retry briefed (deduped). The union is load-bearing:
  # the commonest gate remedies ADD a file (a decisions record, a new test), and a frozen list would
  # silently ship without the fix and re-block on the same gate.
  SI_PATHS=("${SI_FIELDS[@]:$((si_body_at + 1))}")
  # RESUME_EXTRA_PATHS: only what THIS retry explicitly briefed beyond the record — the sole set a
  # losing re-record may donate to a newer invocation (its stale recorded list must never leak in).
  RESUME_EXTRA_PATHS=()
  for p in ${PATHS[@]+"${PATHS[@]}"}; do
    si_dup=0
    for q in "${SI_PATHS[@]}"; do [ "$q" = "$p" ] && { si_dup=1; break; }; done
    [ "$si_dup" -eq 1 ] || { SI_PATHS+=("$p"); RESUME_EXTRA_PATHS+=("$p"); }
  done
  PATHS=("${SI_PATHS[@]}")
  # One line naming what is being replayed, BEFORE the multi-minute gate chain — a stale-but-valid
  # record must be visible here, not after the run.
  echo "Resuming recorded invocation for $BR: \"$TITLE\" — ${#PATHS[@]} paths, body $(printf '%s' "$RESUME_BODY" | wc -c | tr -d ' ') bytes, recorded $RESUME_CREATED" >&2
fi

[ "${#PATHS[@]}" -gt 0 ] || { echo "no paths given" >&2; exit 1; }
# Files only: `git diff/ls-files -- <dir>` recurses and would sweep in a parallel
# agent's edits under that directory, defeating the per-file isolation. (A deleted
# file is not a dir, so it still passes — deletions are valid pathspecs.)
for p in "${PATHS[@]}"; do
  [ -d "$p" ] && {
    echo "directory path not allowed (pass individual files): $p" >&2
    echo "  list its tracked files: git ls-files -- \"$p\"" >&2
    exit 1
  }
done

# Assemble extra symlinks; prepare-gate-worktree.sh adds the universal base.
LINK_DIRS=()
[ "${#LINK_EXTRA[@]}" -gt 0 ] && LINK_DIRS+=("${LINK_EXTRA[@]}")

# Reclaim what a KILLED ship left behind, BEFORE the branch is read below (sc-2159). A ship that dies
# by SIGKILL never runs its EXIT trap, so its ephemeral worktree and branch survive and every later
# attempt refuses — the branch is "checked out in a linked worktree" and cannot even be deleted by
# hand without finding that worktree first. This reclaims only what a previous run's own record
# proves was abandoned, and refuses with a message naming the live pid otherwise.
#
# The placement is load-bearing: LOCAL_BRANCH_EXISTS below (and the nothing-to-commit guard gated on
# it) must be computed AFTER any branch this preflight deletes, or a successful reclaim still walks
# into the resume block and dies on a branch that is no longer there.
. "$SCRIPT_DIR/origin-base.sh"
. "$SCRIPT_DIR/worktree-registry.sh"
. "$SCRIPT_DIR/ship-run-record.sh"
. "$SCRIPT_DIR/reclaim-orphan-worktrees.sh"
PREFLIGHT_HINT=
PREFLIGHT_SELF=   # set when the branch's holder is THIS worktree; changes the closing advice below
# SHIP_RESOLVE_ONLY promises no side effects, so it must not reclaim anything.
[ -n "${SHIP_RESOLVE_ONLY:-}" ] || ship_reclaim_orphan_worktrees "$PWD" "$BR" || exit 1

# A non-dry retry may legitimately find the branch created by its previous attempt: the supervised
# commit can land, then return 124 while reaping a leaked descendant. Defer that collision until the
# base, body and scoped snapshot are known so we can distinguish the exact preserved commit from an
# unrelated local branch. Dry runs deliberately keep their worktree for inspection and never publish,
# so they retain the strict new-branch precondition.
LOCAL_BRANCH_EXISTS=
if git show-ref --verify -q "refs/heads/$BR"; then
  if [ -n "${SHIP_DRY_RUN:-}" ] || [ "$DRY_GATES" -eq 1 ]; then
    echo "branch already exists: $BR" >&2; exit 1
  fi
  LOCAL_BRANCH_EXISTS=1
fi
if [ -z "${SHIP_DRY_RUN:-}" ] && [ "$DRY_GATES" -eq 0 ] && ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed (needed to open the PR)" >&2; exit 1
fi
# Also reject an existing REMOTE branch — otherwise `push -u` fast-forwards onto it,
# silently appending this commit to someone else's branch/PR. (Skipped under dry-run:
# no push happens, and it avoids a network round-trip.)
if [ -z "${SHIP_DRY_RUN:-}" ] && [ "$DRY_GATES" -eq 0 ]; then
  set +e
  # Fully-qualified, NOT a bare `$BR`: a bare pattern tail-matches on path segments, so shipping `x`
  # would read `refs/heads/feat/x` as "this branch already exists" and refuse a legitimate name.
  git ls-remote --exit-code --heads origin "refs/heads/$BR" >/dev/null 2>&1
  remote_check=$?
  set -e
  # ls-remote exits 2 for "no matching ref" but ALSO non-zero on auth/network error — only exit 2
  # is a safe "branch absent"; any other failure must fail closed, or push -u could append to a PR.
  case "$remote_check" in
    0) echo "remote branch already exists: origin/$BR" >&2
       echo "  to add these changes to that branch's existing PR, re-run with --pr" >&2
       exit 1 ;;
    2) ;; # no matching remote branch → safe to create it
    *) echo "could not verify remote branch (ls-remote exit $remote_check) — refusing to push" >&2; exit 1 ;;
  esac
fi

# The PR target branch. Default: the branch we branched from — the PR merges back into it. A detached
# HEAD has no such branch, so fail fast rather than silently targeting `main` (wrong base + a bogus
# diff). With --base <branch> the PR targets THAT branch instead, so a repo whose source-of-truth
# branch differs from its PR base can ship from either without checking out / juggling worktrees.
if [ -n "$BASE_FLAG" ]; then
  # `origin/x` and `x` both mean branch x: the PR base is a branch NAME, and the tip we branch off is
  # always origin's (below) — so the two spellings must not diverge into two different bases.
  BASE_REF=${BASE_FLAG#origin/}
else
  BASE_REF=$(git symbolic-ref --quiet --short HEAD) || {
    echo "detached HEAD — run ship-branch.sh from a branch (the PR targets that branch)" >&2; exit 1
  }
fi
# Resolve owner/repo from origin (NOT gh's default — a fork's upstream remote can hijack it).
REPO=$(git remote get-url origin | sed -E 's#^.*github\.com[^:/]*[:/]##; s#\.git$##')
# A malformed origin leaves a bad REPO that would only surface AFTER the push — validate the shape now.
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "could not resolve origin to owner/repo: '$REPO'" >&2; exit 1
}

# Test seam: print the resolved PR target + repo, then exit before any side effect
# (no worktree, no stdin read, no push). Lets the regression test that guards the
# fork-repo-resolution bug run hermetically. Never set in normal use.
[ -n "${SHIP_RESOLVE_ONLY:-}" ] && { printf 'BASE_REF=%s\nREPO=%s\n' "$BASE_REF" "$REPO"; exit 0; }

# The DEFAULT base gets the same proof --base has always had (below): that it is a BRANCH ON ORIGIN.
# Without this the only thing that ever checked was `gh pr create` — AFTER the gates, the commit and
# the push — so shipping from a local-only branch (a provisioned worktree's scratch branch, a branch
# whose push failed) left a real branch on origin with no PR and printed a recovery command naming
# the same impossible base (sc-2261). BASE itself stays this checkout's HEAD: only the PR TARGET NAME
# is being validated, so nothing about the normal path changes.
#
# Placement: after the resolve-only seam (which promises no network) and before the worktree, the
# commit and the push. NOT before every side effect — ship_reclaim_orphan_worktrees above may already
# have reclaimed an abandoned worktree, and it must stay first for the reason given at its call site.
# Dry runs and dry-gates rehearsals skip it: they never push, and the fake/unreachable origin they
# usually carry makes the probe meaningless — same trade-off as the $BR probe above. An explicit
# --base still fetches origin's current tip below because that changes the content being rehearsed.
if [ -z "$BASE_FLAG" ] && [ -z "${SHIP_DRY_RUN:-}" ] && [ "$DRY_GATES" -eq 0 ]; then
  set +e
  git ls-remote --exit-code --heads origin "refs/heads/$BASE_REF" >/dev/null 2>&1
  base_check=$?
  set -e
  case "$base_check" in
    0) ;; # the PR base exists on origin → gh pr create can use it
    2) echo "base '$BASE_REF' is not on origin; pass --base <branch>" >&2
       echo "  a PR base must be a branch that exists on the remote, and this checkout is on one that is not." >&2
       ship_suggest_base "$REPO" >&2
       exit 1 ;;   # ship_suggest_base quotes its own copyable half — branch names are not safe literals
    *) echo "could not verify base '$BASE_REF' (ls-remote exit $base_check) — refusing to push" >&2; exit 1 ;;
  esac
fi

# The commit the ephemeral worktree is cut from — and therefore what the gates judge and what the PR
# diffs against. Resolved AFTER the seam above: --base needs the network, and the seam promises no
# side effects. Nothing between there and here reads $BASE.
if [ -n "$BASE_FLAG" ]; then
  # origin's tip, not the local copy: in a shared parallel-agent checkout the local base branch is
  # routinely stale, and a worktree cut from a stale base makes the gates judge code GitHub will never
  # merge into. (The PR DIFF would still be right — GitHub diffs from the merge-base — so this buys
  # gate accuracy, not diff accuracy.) reship.sh sets the precedent: it fetches its base the same way.
  # The source ref is fully-qualified `refs/heads/` — NOT a bare ref, which would also match a tag: a
  # PR base must be a BRANCH, so a sha or tag has to fail HERE, not at `gh pr create` after the push.
  # One round-trip proves both (the branch exists AND it is a branch).
  git fetch -q origin "refs/heads/$BASE_REF" 2>/dev/null || {
    echo "--base: no branch origin/$BASE_REF (a PR base must be a remote branch — not a sha or a tag)" >&2
    exit 1
  }
  BASE=$(git rev-parse FETCH_HEAD)
else
  BASE=$(git rev-parse HEAD)   # pin once: shared HEAD may advance mid-run
fi

# devkit self-host only: inspect the CALLER tree before the ephemeral worktree hides ignored,
# unbriefed dist artifacts. Installed consumer copies run the same helper, which no-ops unless the
# caller package is @norvalbv/devkit. Prefer source beside this script, then packaged .mjs.
DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mts"
[ -f "$DIST_INTEGRITY" ] || DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mjs"
node "$DIST_INTEGRITY" --root "$ROOT" --base "$BASE" -- "${PATHS[@]}"

# Preview the raw-line ratchet against the exact base baseline BEFORE creating the worktree.
. "$SCRIPT_DIR/prepare-gate-worktree.sh"
ship_size_preflight "$ROOT" "$BASE" "${PATHS[@]}"

# Nothing to commit → say so NOW. Staging (below) has exactly three inputs: the tracked diff vs
# BASE, the untracked files in scope, and the untracked-but-IGNORED files in scope (a briefed path
# under a gitignored, force-tracked tree such as devkit's own dist/). All empty ⇒ an empty index — which git only reports AFTER the
# whole gate chain has run ("nothing added to commit but untracked files present", the untracked ones
# being our own gate symlinks), whereupon the EXIT trap force-deletes the branch it just made and
# prints a bare "Deleted branch … (was …)" on stdout. The operator pays a multi-minute gate run for a
# cryptic failure. reship.sh's "no changes vs origin/$BR" guard already covers the re-push flow; here
# is its new-ship twin, hoisted ahead of the worktree so nothing is created to churn. Mirrors the two
# staging commands exactly (same BASE, same enumerations, same pathspec) so the guard cannot
# disagree with what staging will do. A git ERROR (non-zero but not "differences found") reads as
# "has changes" and falls through to the old behaviour — fail toward the status quo, never toward a
# false abort. Says "no changes in" rather than "identical to": a misspelled path also lands here
# (`git diff --quiet -- nonexistent` exits 0), and the wording stays true for it.
if [ -z "$LOCAL_BRANCH_EXISTS" ] &&
   git -C "$ROOT" diff --quiet "$BASE" -- "${PATHS[@]}" &&
   [ -z "$(git -C "$ROOT" ls-files -o --exclude-standard -- "${PATHS[@]}")" ] &&
   [ -z "$(git -C "$ROOT" ls-files -o -i --exclude-standard -- "${PATHS[@]}")" ]; then
  echo "nothing to commit: no changes in ${PATHS[*]} vs $BASE_REF (${BASE:0:7})" >&2
  if [ -n "$BASE_FLAG" ]; then
    # --base already answers "your work is committed elsewhere" — the remaining causes are a base that
    # already has this content, or a typo. Never re-suggest checking out: not doing so is the point.
    echo "these paths are already identical on origin/$BASE_REF — wrong --base, or a misspelled path?" >&2
  else
    echo "already committed, wrong checkout, or a misspelled path? ship bases the PR on this checkout's branch ($BASE_REF) — check out the branch your work is on, or pass --base <branch> to diff your working tree against a different branch instead." >&2
  fi
  exit 1
fi

WT="${TMPDIR:-/tmp}/devkit-ship-${BR//\//-}-$$"
PATCH=$(mktemp "${TMPDIR:-/tmp}/ship.XXXXXX")
STAGED_STATE=$(mktemp "${TMPDIR:-/tmp}/ship-staged.XXXXXX")
# Body: --body "<text>" wins (explicit, no temp file); then --body-file (authored once, survives
# every retry); then — on --resume — the recorded body, with stdin never consulted (a re-run heredoc
# does not survive a wrapper, and a closed stdin reads as a silently EMPTY body); else stdin
# (back-compat — a piped/here-doc body still works). TTY means no body; non-TTY uses a bounded read
# so an inherited, open-but-idle background-task pipe fails loud instead of blocking forever.
# Nothing is created yet, so aborting is clean.
. "$SCRIPT_DIR/read-stdin-body.sh"
if [ "$DRY_GATES" -eq 1 ]; then BODY=""
elif [ "$BODY_SET" -eq 1 ]; then BODY="$BODY_FLAG"
elif [ "$BODY_FILE_SET" -eq 1 ]; then
  [ -f "$BODY_FILE_FLAG" ] || { echo "--body-file: no such file: $BODY_FILE_FLAG" >&2; exit 1; }
  # cat + sentinel, never $(<file): command substitution strips EVERY trailing newline, silently
  # altering a deliberately-authored body before it is recorded.
  BODY=$(cat -- "$BODY_FILE_FLAG" && printf x) || { echo "--body-file: unreadable: $BODY_FILE_FLAG" >&2; exit 1; }
  BODY=${BODY%x}
elif [ "$RESUME" -eq 1 ]; then BODY="$RESUME_BODY"
elif [ -t 0 ]; then BODY=""
else ship_read_stdin_body; fi
# The body is the ONLY thing ship reads from stdin, and it has been read. Hand every descendant
# /dev/null instead: the gate chain runs consumer tooling for minutes and can otherwise consume the
# caller's stdin. This redirect MUST come after the read; the prompt-suppressing exports could NOT
# wait for it — remote git runs far earlier — so they sit at the top of the file.
exec 0</dev/null

# Record THIS attempt's effective invocation, so the next retry is `devkit ship --resume <branch>`.
# Every attempt re-records, resume included: the staleness clock resets while a retry chain is live,
# and a --body/--body-file override becomes what the NEXT resume replays. The DEVKIT_SHIP_* exports
# are hoisted from commit-with-gate-capture.sh's derivation (which keeps an inherited id), so the
# ship_intent event this write emits carries the same ship_id as everything the gate chain emits.
# Best-effort: a recording miss costs the retry a full re-type, never the ship.
. "$SCRIPT_DIR/repo-identity.sh"
export DEVKIT_SHIP_ID="${DEVKIT_SHIP_ID:-$(uuidgen 2>/dev/null || echo "${BR//\//-}-$$-$(date +%s)")}"
export DEVKIT_SHIP_REPO="$(devkit_repo_identity "$ROOT")" DEVKIT_SHIP_BRANCH="$BR"
export DEVKIT_SHIP_RESUMED=$RESUME
SHIP_INTENT_GENERATION=""
if [ "$DRY_GATES" -eq 0 ]; then
  SHIP_INTENT_ARGS=(write --root "$ROOT" --branch "$BR" --mode ship --title "$TITLE")
  [ -z "$BASE_FLAG" ] || SHIP_INTENT_ARGS+=(--base "$BASE_FLAG")
  for d in ${LINK_EXTRA[@]+"${LINK_EXTRA[@]}"}; do SHIP_INTENT_ARGS+=(--link "$d"); done
  [ "$QAVIS_PUBLISH" -eq 1 ] || SHIP_INTENT_ARGS+=(--no-qavis-publish)
  if [ "$RESUME" -eq 1 ]; then
    SHIP_INTENT_ARGS+=(--resumed --merge-paths --expect-generation "$RESUME_GENERATION")
    for p in ${RESUME_EXTRA_PATHS[@]+"${RESUME_EXTRA_PATHS[@]}"}; do SHIP_INTENT_ARGS+=(--donate "$p"); done
  fi
  # Capture the record's ownership token (write prints a per-attempt random generation): success may delete ONLY the
  # record this attempt wrote — a concurrent attempt's newer record must survive for ITS --resume.
  SHIP_INTENT_GENERATION=$(printf '%s' "$BODY" | node "$SHIP_INTENT" "${SHIP_INTENT_ARGS[@]}" -- "${PATHS[@]}") \
    || { SHIP_INTENT_GENERATION=""; echo "ship: invocation not recorded — the retry needs the full command (non-fatal)" >&2; }
fi
# Exported flag (not the token itself) so the SUBPROCESS gate runner's timeout banner can tell a
# recorded attempt (--resume works) from an unrecorded one (--resume would refuse by name).
export DEVKIT_SHIP_INTENT_RECORDED=$([ -n "$SHIP_INTENT_GENERATION" ] && echo 1 || echo 0)

SHIP_RUN_MODE=live
[ -z "${SHIP_DRY_RUN:-}" ] || SHIP_RUN_MODE=dry
[ "$DRY_GATES" -eq 0 ] || SHIP_RUN_MODE=dry-gates
KEEP_WT=  # set by a staged-set abort: the clobbered index IS the evidence, so never reclaim it
RECOVERY_INDEX=
RECOVERY_PARENT=  # the preserved commit's OWN parent: what its diff and manifest anchor on, since $BASE may have advanced since it was cut
RECOVERY_PATHS_ALL=
RECOVERY_PATHS_CALLER=
RECOVERY_PATHS_SCOPED=
RECOVERY_RECEIPT_REF="refs/devkit/ship-receipts/$BR"
# Sibling of the receipt, pinned in the same place at the same instant: a blob holding the
# NUL-delimited paths this ship's own gate chain added beyond the brief (sc-2089). The receipt proves
# the commit was gated; this proves which parts of it the caller did not ask for but devkit wrote.
RECOVERY_GATE_ADDS_REF="refs/devkit/ship-gate-adds/$BR"
GATE_ADDS_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-gate-adds.XXXXXX")
BRANCH_CREATED= # only this invocation's branch may be auto-deleted on an empty/failed commit
cleanup() {
  rm -f "$PATCH" "$STAGED_STATE" "$GATE_ADDS_FILE"
  [ -z "$RECOVERY_INDEX" ] || rm -f "$RECOVERY_INDEX"
  [ -z "$RECOVERY_PATHS_ALL" ] || rm -f "$RECOVERY_PATHS_ALL"
  [ -z "$RECOVERY_PATHS_CALLER" ] || rm -f "$RECOVERY_PATHS_CALLER"
  [ -z "$RECOVERY_PATHS_SCOPED" ] || rm -f "$RECOVERY_PATHS_SCOPED"
  if [ "$DRY_GATES" -eq 1 ]; then
    if ! git -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then return; fi
    if ! git worktree remove --force --force "$WT" 2>/dev/null; then
      echo "ship: dry-gates could not remove its ephemeral worktree: $WT" >&2
      trap - EXIT
      exit 1
    fi
    return
  fi
  # A staged-set invariant fired. Removing the worktree would destroy the only copy of the bad index
  # and leave nothing to diagnose from, so hand it to the operator instead (worktree AND branch).
  if [ -n "$KEEP_WT" ]; then
    echo "   Worktree KEPT for diagnosis: $WT (branch $BR)" >&2
    echo "   Inspect: git --git-dir='$(git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null || echo "$WT/.git")' ls-files | head" >&2
    echo "   Then:    git worktree remove --force '$WT' && git branch -D '$BR'" >&2
    return
  fi
  # Reclaim the ephemeral worktree + branch whenever no commit landed beyond BASE — the commit
  # failed, never ran, or was reset by the honest-banner abort in commit-with-gate-capture.sh,
  # leaving an empty branch + throwaway worktree with nothing to inspect or recover. This fires on
  # EVERY exit, incl. DRY and the fail-closed preflight exits — otherwise a failed dry-run leaks a
  # devkit-ship-* worktree + branch (they then show as "checked out in a linked worktree" and block
  # deletion). An absent branch (worktree add failed) is treated the same. Keying on the commit —
  # not on SHIP_DRY_RUN — is what the sibling reship.sh already does. Worktree first: a branch
  # checked out in a worktree can't be deleted.
  local tip; tip=$(git rev-parse -q --verify "$BR" 2>/dev/null || true)
  if [ -z "$tip" ] || [ "$tip" = "$BASE" ]; then
    git worktree remove --force "$WT" 2>/dev/null || true
    [ -n "$tip" ] && [ -n "$BRANCH_CREATED" ] && git branch -D "$BR" 2>/dev/null || true
    return
  fi
  # A commit DID land beyond BASE.
  if [ -n "${SHIP_DRY_RUN:-}" ]; then
    # Dry-run success: keep the worktree so the operator can inspect the local commit.
    echo "DRY: worktree kept at $WT (branch $BR). Inspect, then:" >&2
    echo "  git worktree remove --force '$WT' && git branch -D '$BR'" >&2
  else
    # Non-dry: remove the worktree; KEEP the branch (commit succeeded but push/PR may have failed)
    # so the work stays recoverable — it is deleted explicitly after push + PR succeed (below).
    git worktree remove --force "$WT" 2>/dev/null || true
  fi
}
trap cleanup EXIT
# Keep cleanup ordered after the active gate supervisor. A signal may target only this public shell
# (Codex task termination does), so forwarding + waiting is load-bearing: immediate exit would run
# cleanup while a reviewer still has $WT as its cwd (sc-1538).
. "$SCRIPT_DIR/review/process/gate-signal-handoff.sh"
gate_signal_handoff_init

if [ -n "$LOCAL_BRANCH_EXISTS" ]; then
  # Resume only when the existing branch proves it is the exact output this invocation would have
  # produced: one commit on this base, the same message, no out-of-scope paths, and a tree rebuilt
  # from the caller's CURRENT scoped files that is byte-for-byte identical. The temporary index makes
  # that last check include tracked, untracked and ignored files without touching the caller's index.
  RECOVERY_REASON=
  RECOVERY_HINTS=()   # optional indented lines printed between the reason and the closing advice
  # The preflight above may already know WHY this branch exists (a killed ship left it). That is the
  # missing half of every "cannot safely resume" refusal, so it rides the hint channel that already
  # prints between the reason and the closing advice — no new line shape.
  [ -z "$PREFLIGHT_HINT" ] || RECOVERY_HINTS+=("$PREFLIGHT_HINT")
  RECOVERY_COMMIT=$(git rev-parse -q --verify "$BR^{commit}" 2>/dev/null || true)
  RECOVERY_LINE=$(git rev-list --parents -n 1 "$RECOVERY_COMMIT" 2>/dev/null || true)
  RECOVERY_PARENTS=()
  read -r -a RECOVERY_PARENTS <<< "$RECOVERY_LINE"
  # sc-2273: name the simplest shape FIRST. A branch whose tip the base already contains carries
  # nothing to resume, and both arms below describe that state as a topology puzzle — the parent-count
  # arm as "its tip is not a single commit" (the root-commit case, which short-circuits before the
  # merge-base arm is ever reached), the diverges arm as three speculative causes. Neither says the
  # one fact that decides it. This REFUSES exactly as they did; it is the wording that changes, so the
  # two shapes ship-branch-resume.test.mts pins as unresumable ($BASE == the tip, and a base that has
  # already absorbed the commit) are still refused — they are both instances of this very state.
  if [ -n "$RECOVERY_COMMIT" ] && git merge-base --is-ancestor "$RECOVERY_COMMIT" "$BASE" 2>/dev/null; then
    RECOVERY_REASON="it carries no commit of its own over $BASE_REF (${BASE:0:7}) — ${RECOVERY_COMMIT:0:7} is already contained in that base"
  # $BASE is re-resolved every invocation, so on a retry it has usually MOVED. Demand the PR's merge-base
  # instead of equality: GitHub renders a PR as merge-base(base, head) -> head, so this asserts directly
  # that the PR shows exactly this one commit. Unreachable histories yield an empty fork point, which
  # compares unequal and refuses. Do NOT weaken to `--is-ancestor` — ship-branch-resume.test.mts pins the
  # two cases that would then be accepted (a base that already absorbed the commit, and $BASE == the tip).
  elif [ "${#RECOVERY_PARENTS[@]}" -ne 2 ]; then
    RECOVERY_REASON="its tip is not a single commit (a ship commit has exactly one parent)"
  else
    RECOVERY_PARENT=${RECOVERY_PARENTS[1]}
    RECOVERY_FORK=$(git merge-base "$BASE" "$RECOVERY_COMMIT" 2>/dev/null) || RECOVERY_FORK=
    if [ "$RECOVERY_FORK" != "$RECOVERY_PARENT" ]; then
      RECOVERY_REASON="its parent ${RECOVERY_PARENT:0:7} is not where $BASE_REF (${BASE:0:7}) diverges from it — a different --base, a base moved backwards, or this commit is already merged"
    fi
  fi

  # `git commit -m` applies stripspace cleanup before writing the object. Apply the same cleanup to
  # the retry input so an identical invocation containing trailing spaces compares equal to `%B`.
  EXPECTED_MESSAGE=$(printf '%s\n\n%s\n' "$TITLE" "$BODY" | git stripspace)
  ACTUAL_MESSAGE=$(git log -1 --format=%B "$RECOVERY_COMMIT" 2>/dev/null || true)
  if [ -z "$RECOVERY_REASON" ] && [ "$ACTUAL_MESSAGE" != "$EXPECTED_MESSAGE" ]; then
    RECOVERY_REASON="its commit message differs from this ship title/body"
    # A here-doc does not survive a re-run through a wrapper: a CLOSED stdin and /dev/null both read as
    # an empty body, silently and with exit 0 (read-stdin-body.sh errors only on an idle-but-OPEN pipe).
    # The message then differs on the BODY, and the generic reason sends the operator to inspect a title
    # that never changed. Only claim that when the body is the PROVEN sole divergence — the title must
    # already match, or an operator who changed BOTH would be pointed at the wrong half.
    RECOVERY_BODY=$(git log -1 --format=%b "$RECOVERY_COMMIT" 2>/dev/null || true)
    RECOVERY_SUBJECT=$(git log -1 --format=%s "$RECOVERY_COMMIT" 2>/dev/null || true)
    if [ -z "$BODY" ] && [ -n "$RECOVERY_BODY" ] && [ "$RECOVERY_SUBJECT" = "$TITLE" ]; then
      RECOVERY_REASON="this run supplied no PR body, but its commit has one"
      RECOVERY_HINTS+=("re-supply it with --body \"<text>\" — this run's stdin was empty, and an empty stdin is a valid empty body")
    fi
  fi

  # Similarity is not provenance. Only ship itself writes this private ref after a gated commit has
  # actually landed; without the exact receipt, a hand-made/--no-verify commit must never skip gates.
  # Checked BEFORE the scope comparison so provenance is what refuses an unreceipted branch, and so
  # the gate-authored tolerance below is only ever consulted for a commit devkit itself gated. The
  # order is cosmetic for the VERDICT — every check here is guarded on an empty $RECOVERY_REASON and
  # they are therefore conjunctive — but a tolerance granted before provenance is established reads
  # like a hole even when it is not one.
  RECOVERY_RECEIPT=$(git rev-parse -q --verify "$RECOVERY_RECEIPT_REF^{commit}" 2>/dev/null || true)
  if [ -z "$RECOVERY_REASON" ] && [ "$RECOVERY_RECEIPT" != "$RECOVERY_COMMIT" ]; then
    RECOVERY_REASON="it has no matching prior-ship gate receipt"
  fi

  # The paths ship's OWN gate chain added to this commit beyond the brief, recorded beside the
  # receipt the instant the commit landed (ship_record_gate_adds). A ratchet gate stages a lowered
  # baseline so it rides the same commit; assert-staged-set.sh tolerates that on the way IN, so the
  # resume has to tolerate it on the way BACK or a fully gated commit can never be published at all
  # — the sc-2089 deadlock. Tolerance is keyed on this RECORD and never on a guessed list of baseline
  # filenames: a path the caller briefed itself is by construction absent from the record, so a
  # NARROWED retry cannot smuggle a change its brief no longer names into the PR. An absent record (a
  # receipt minted by an older devkit) leaves the array empty, and an empty exclude list makes the
  # comparison below byte-identical to the strict one it replaces — fail closed by construction.
  GATE_ADD_EXCLUDE=()
  if [ -z "$RECOVERY_REASON" ]; then
    RECOVERY_GATE_ADDS_BLOB=$(git rev-parse -q --verify "$RECOVERY_GATE_ADDS_REF^{blob}" 2>/dev/null || true)
    if [ -n "$RECOVERY_GATE_ADDS_BLOB" ]; then
      while IFS= read -r -d '' gate_path; do
        GATE_ADD_EXCLUDE+=(":(exclude,literal)$gate_path")
      done < <(git cat-file blob "$RECOVERY_GATE_ADDS_BLOB")
    fi
  fi

  # Ask Git to resolve the caller's pathspecs, then compare that exact NUL-delimited set with the
  # complete changed-path set. This accepts equivalent spellings such as `./note.txt`, stays binary
  # safe for unusual filenames, and uses --no-renames so BOTH sides of a rename must be briefed.
  RECOVERY_PATHS_ALL=$(mktemp "${TMPDIR:-/tmp}/ship-recovery-paths-all.XXXXXX")
  RECOVERY_PATHS_CALLER=$(mktemp "${TMPDIR:-/tmp}/ship-recovery-paths-caller.XXXXXX")
  RECOVERY_PATHS_SCOPED=$(mktemp "${TMPDIR:-/tmp}/ship-recovery-paths-scoped.XXXXXX")
  # Anchored on the commit's OWN parent, not $BASE: scope means "what this commit changed", and with an
  # advanced base `git diff $BASE $COMMIT` also carries the INVERSE of everything merged in since, so
  # every such path would read as out-of-scope — turning one wrong refusal into a worse one. The parent
  # is the same commit GitHub picks as the PR's merge-base (guaranteed by the check above), so this set
  # IS the PR's diff. Guarded as a whole because a failed parent-count check leaves RECOVERY_PARENT
  # empty, and a bare `git diff ""` would abort under -e before the reason is ever printed.
  if [ -z "$RECOVERY_REASON" ]; then
    git diff --name-only --no-renames -z "$RECOVERY_PARENT" "$RECOVERY_COMMIT" -- > "$RECOVERY_PATHS_ALL"
    # Both sides drop the gate-authored paths, so what remains on each is the CALLER's half of the
    # commit. Equality then states exactly "this brief names everything in the commit that the gates
    # did not write themselves" — the same claim as `changed \ briefed ⊆ record`, expressed in git's
    # own pathspec algebra so it stays NUL-exact instead of going through a sort/comm round trip.
    git diff --name-only --no-renames -z "$RECOVERY_PARENT" "$RECOVERY_COMMIT" \
      -- ${GATE_ADD_EXCLUDE[@]+"${GATE_ADD_EXCLUDE[@]}"} > "$RECOVERY_PATHS_CALLER"
    git diff --name-only --no-renames -z "$RECOVERY_PARENT" "$RECOVERY_COMMIT" \
      -- "${PATHS[@]}" ${GATE_ADD_EXCLUDE[@]+"${GATE_ADD_EXCLUDE[@]}"} > "$RECOVERY_PATHS_SCOPED"
    # Emptiness stays on the UNFILTERED set: a brief consisting solely of a path a gate also touches
    # is a legitimate ship (a manual baseline burn-down), and testing the filtered set would refuse
    # it with a reason that is not true.
    if [ ! -s "$RECOVERY_PATHS_ALL" ]; then
      RECOVERY_REASON="its commit has no scoped changes"
    elif ! cmp -s "$RECOVERY_PATHS_CALLER" "$RECOVERY_PATHS_SCOPED"; then
      RECOVERY_REASON="its commit changes paths outside the requested scope"
      # Name them. The bare reason sent the sc-2089 reporter through two more failed attempts before
      # they gave up on the resume entirely. SCOPED is always a subset of CALLER, so the difference
      # is one-directional. Rendering through newlines is safe HERE and only here: the verdict was
      # already decided NUL-exactly above, so a path containing a newline degrades this hint rather
      # than the decision.
      RECOVERY_SCOPE_N=0
      RECOVERY_SCOPE_LIST=
      while IFS= read -r offending; do
        [ -n "$offending" ] || continue
        RECOVERY_SCOPE_N=$((RECOVERY_SCOPE_N + 1))
        if [ "$RECOVERY_SCOPE_N" -le 5 ]; then
          RECOVERY_SCOPE_LIST="${RECOVERY_SCOPE_LIST:+$RECOVERY_SCOPE_LIST }$offending"
        fi
      done < <(comm -23 \
        <(tr '\0' '\n' < "$RECOVERY_PATHS_CALLER" | sort -u) \
        <(tr '\0' '\n' < "$RECOVERY_PATHS_SCOPED" | sort -u))
      if [ "$RECOVERY_SCOPE_N" -gt 5 ]; then
        RECOVERY_SCOPE_LIST="$RECOVERY_SCOPE_LIST (+$((RECOVERY_SCOPE_N - 5)) more)"
      fi
      RECOVERY_HINTS+=("unbriefed paths ($RECOVERY_SCOPE_N): $RECOVERY_SCOPE_LIST")
      RECOVERY_HINTS+=("brief them too, or re-run the ORIGINAL invocation — a retry that narrows the scope cannot resume a commit the wider one made")
    fi
  fi

  if [ -z "$RECOVERY_REASON" ]; then
    RECOVERY_INDEX=$(mktemp "${TMPDIR:-/tmp}/ship-recovery-index.XXXXXX")
    rm -f "$RECOVERY_INDEX" # read-tree must create it; an empty file is not a valid index
    GIT_INDEX_FILE="$RECOVERY_INDEX" git -C "$ROOT" read-tree "$RECOVERY_COMMIT"
    # `git add` FATALS (exit 128) on a pathspec that matches nothing, and set -e turns that into a
    # dead resume. Two briefed pathspecs legitimately match nothing here, so both are filtered out
    # before the add rather than allowed to kill a commit that already passed every gate (sc-2089).
    RECOVERY_ADD_PATHS=()
    for p in "${PATHS[@]}"; do
      # (a) Commit-authoritative. Everything this pathspec contributes to the commit was written by
      # the gate chain, INSIDE the ephemeral worktree — $ROOT still holds the pre-gate bytes, so
      # re-adding from the caller's tree would guarantee a mismatch against a commit that is correct
      # and unfixable by the operator, whose copy of those bytes no longer exists anywhere. read-tree
      # already supplied the right content; leave it alone. Probes are newline-framed on purpose:
      # only emptiness is read, and `-z` inside $() makes bash strip NULs and warn on stderr.
      if [ "${#GATE_ADD_EXCLUDE[@]}" -gt 0 ] &&
         [ -n "$(git -C "$ROOT" diff --name-only --no-renames "$RECOVERY_PARENT" "$RECOVERY_COMMIT" -- "$p")" ] &&
         [ -z "$(git -C "$ROOT" diff --name-only --no-renames "$RECOVERY_PARENT" "$RECOVERY_COMMIT" -- "$p" "${GATE_ADD_EXCLUDE[@]}")" ]; then
        continue
      fi
      # (b) A path the commit DELETED. read-tree has already applied the deletion, so it is in
      # neither the recovery index nor the worktree and there is nothing left to re-add. There is no
      # --ignore-unmatch on `git add`, so the probe has to come first. Framed on $ROOT like every
      # other git call here, NOT `[ -e "$p" ]`, which resolves against the caller's cwd and misses a
      # broken symlink. --others deliberately WITHOUT --exclude-standard so a force-added ignored
      # file still counts as present. A path the caller has since RE-CREATED matches again, stays in
      # the add set, and still refuses via the tree comparison below — as it must.
      if [ -z "$(GIT_INDEX_FILE="$RECOVERY_INDEX" git -C "$ROOT" ls-files --cached --others -- "$p")" ]; then
        continue
      fi
      RECOVERY_ADD_PATHS+=("$p")
    done
    # `git add -A --` with NO pathspec stages the WHOLE worktree, so an empty set must be an explicit
    # skip. Nothing is lost by skipping: read-tree's index already IS the commit's tree.
    if [ "${#RECOVERY_ADD_PATHS[@]}" -gt 0 ]; then
      GIT_INDEX_FILE="$RECOVERY_INDEX" git -C "$ROOT" add -f -A -- "${RECOVERY_ADD_PATHS[@]}"
    fi
    RECOVERY_TREE=$(GIT_INDEX_FILE="$RECOVERY_INDEX" git -C "$ROOT" write-tree)
    BRANCH_TREE=$(git rev-parse "$RECOVERY_COMMIT^{tree}")
    if [ "$RECOVERY_TREE" != "$BRANCH_TREE" ]; then
      RECOVERY_REASON="the current scoped files no longer match its commit"
      # Name them: "some scoped file changed" is unactionable on a wide ship, and the commonest cause is
      # the gate chain's own formatter re-staging inside the worktree, not an edit the operator made.
      RECOVERY_DRIFT_N=0
      RECOVERY_DRIFT_LIST=
      while IFS= read -r drifted; do
        RECOVERY_DRIFT_N=$((RECOVERY_DRIFT_N + 1))
        if [ "$RECOVERY_DRIFT_N" -le 5 ]; then
          RECOVERY_DRIFT_LIST="${RECOVERY_DRIFT_LIST:+$RECOVERY_DRIFT_LIST }$drifted"
        fi
      done < <(git diff --name-only "$BRANCH_TREE" "$RECOVERY_TREE")
      if [ "$RECOVERY_DRIFT_N" -gt 5 ]; then
        RECOVERY_DRIFT_LIST="$RECOVERY_DRIFT_LIST (+$((RECOVERY_DRIFT_N - 5)) more)"
      fi
      RECOVERY_HINTS+=("differing paths ($RECOVERY_DRIFT_N): $RECOVERY_DRIFT_LIST")
      RECOVERY_HINTS+=("a pre-commit formatter rewrites and re-stages inside the ship worktree, so its commit can differ from your tree — see it with: git diff $BR -- <path>")
    fi
  fi

  if [ -n "$RECOVERY_REASON" ]; then
    echo "branch already exists: $BR" >&2
    echo "  cannot safely resume it: $RECOVERY_REASON" >&2
    # ${#arr[@]} (not ${arr[@]}) is the bash-3.2 + `set -u` safe emptiness test — same idiom as the
    # LINK_EXTRA check above. Hints sit BETWEEN the reason and the advice so the recognisable three-line
    # shape survives verbatim whenever none is set.
    if [ "${#RECOVERY_HINTS[@]}" -gt 0 ]; then
      for hint in "${RECOVERY_HINTS[@]}"; do echo "  $hint" >&2; done
    fi
    # This is the LAST line the operator reads, so it must not contradict the preflight. When the
    # holder is this very worktree the preflight already printed the two commands that free the
    # branch; repeating the generic advice here would send an agent off to invent a new branch name
    # instead of running them (sc-2261). Re-print the remedy rather than appending to it.
    if [ -n "$PREFLIGHT_SELF" ]; then
      _ship_orphan_report_self "$PWD" "$BR"
    else
      echo "  choose a new branch name, or inspect and remove the local branch yourself" >&2
    fi
    exit 1
  fi

  echo "Resuming preserved ship commit ${RECOVERY_COMMIT:0:7} on $BR (gate receipt verified)." >&2
  # Detached at the verified OID: a concurrent local branch update cannot change what this retry
  # pushes or what the reconcile manifest records.
  git worktree add -q --detach "$WT" "$RECOVERY_COMMIT" >&2
  # branch_created=0: a resume attaches to a branch this run did not create, so nothing downstream
  # may delete it. Written on the very next line, because between `worktree add` and this the entry
  # is registered but unattributable.
  ship_run_record_begin "$WT" "$BR" "$RECOVERY_COMMIT" 0 "$SHIP_RUN_MODE"
else
  if [ "$DRY_GATES" -eq 1 ]; then
    git worktree add -q --detach "$WT" "$BASE" >&2
    ship_run_record_begin "$WT" "$BR" "$BASE" 0 "$SHIP_RUN_MODE"
  else
    BRANCH_CREATED=1
    git worktree add -q -b "$BR" "$WT" "$BASE" >&2
    ship_run_record_begin "$WT" "$BR" "$BASE" 1 "$SHIP_RUN_MODE"
  fi

  # Tracked edits (modify + delete, binary-safe) -> worktree index.
  git -C "$ROOT" diff "$BASE" --binary -- "${PATHS[@]}" > "$PATCH"
  [ -s "$PATCH" ] && git -C "$WT" apply --index "$PATCH"

# Untracked new files in scope -> copy + stage.
  git -C "$ROOT" ls-files -o --exclude-standard -- "${PATHS[@]}" | while IFS= read -r f; do
    mkdir -p "$WT/$(dirname "$f")"
    cp -Pp "$ROOT/$f" "$WT/$f"   # -P: keep a symlink a symlink; -p: preserve mode (the +x bit) regardless of umask
    git -C "$WT" add -- "$f"
  done

# ...and the untracked files git IGNORES. `ls-files -o --exclude-standard` omits them BY DESIGN, so
# a NEW file under a gitignored-but-force-tracked tree fell through both passes: the tracked-diff
# above skips it (not in BASE), this enumeration skipped it (ignored) — and the ship pushed a PR
# missing it, with no warning. devkit's own `dist/` is exactly that shape: gitignored, contents
# force-tracked. sc-1199's `process-table.mts` shipped its source while its build output silently
# vanished, publishing a devkit whose gate supervisor could not resolve its own import.
# Every PATHS entry is caller-explicit (positional after --; directories rejected above), so
# forcing them is precisely what was asked — same reasoning as reship.sh's `git add -f` (#199).
  # A path the patch staged as DELETED is skipped: this pass exists to catch ignored files the diff
  # MISSED, never to overrule one it expressed. Without the guard, deleting a tracked file whose
  # gitignored copy is back on disk (a regenerable cache — sc-1489's receipt) silently re-adds it and
  # the deletion can never land, however many times it is shipped.
  git -C "$ROOT" ls-files -o -i --exclude-standard -- "${PATHS[@]}" | while IFS= read -r f; do
    git -C "$WT" diff --cached --quiet --diff-filter=D -- "$f" || continue
    mkdir -p "$WT/$(dirname "$f")"
    cp -Pp "$ROOT/$f" "$WT/$f"
    git -C "$WT" add -f -- "$f"
  done

# Snapshot the index the instant staging finishes — the two assertions below hold the gate chain to
# it. See assert-staged-set.sh for the clobber this defends against.
  . "$(dirname "${BASH_SOURCE[0]}")/assert-staged-set.sh"
  ship_record_staged_state "$WT" "$STAGED_STATE"
# ...and prove the objects it names are actually readable. write-tree above cannot do this: it
# persists a cache-tree and every later write-tree short-circuits on it, so a staged object that goes
# missing stays invisible to the tree comparisons (sc-1420). Establishes the "present at staging"
# end of the window; the preflight below establishes the other.
  ship_assert_staged_objects_readable "$WT" "after staging" || { ship_run_keep "staged objects unreadable after staging"; exit 1; }

# Only after caller content is staged: runtime symlinks must never enter the shipped diff.
  prepare_gate_worktree "$WT" "$ROOT" shipping ${LINK_DIRS[@]+"${LINK_DIRS[@]}"}

# Link gate configs that live in the repo but aren't in this fresh checkout (an untracked config, a
# gitignored index) so the worktree gates match a plain commit instead of silently running on defaults.
  . "$(dirname "${BASH_SOURCE[0]}")/link-gate-configs.sh"
  link_untracked_gate_configs "$WT" "$ROOT"

# Commit inside the worktree (or invoke its pre-commit hook for --dry-gates). Capture + surface the
# gate output so the shipping agent reliably sees the verdicts — git buries them on stderr. See
# commit-with-gate-capture.sh.
  . "$(dirname "${BASH_SOURCE[0]}")/commit-with-gate-capture.sh"
# The commit the worktree was cut from — lets in-chain gates (fallow) diff against IT, not their own
# main-autodetect. Unconditional (not just under --base): even the default case is more precise than
# a gate auto-detecting main, for any branch that isn't a fresh cut off main (DK-5).
  export DEVKIT_SHIP_BASE_SHA="$BASE"
  if [ "$DRY_GATES" -eq 1 ]; then
    export DEVKIT_SHIP_MODE=dry-gates
    export DEVKIT_RUN_MODE=dry-gates
    export DEVKIT_REVIEW_GUARDS=comments
    export DEVKIT_SHIP_DRY_GATES=1
    echo "🧪 Ship dry gates: exact base/path staging; running formatter, configured deterministic/structure/extra gates, and comment firewall." >&2
    echo "   Skipping decision, Qavis, domain reviewer, completeness, commit, push, and PR creation." >&2
    echo "   The comment firewall may still invoke its configured judge for a changed comment." >&2
  else
    export DEVKIT_SHIP_MODE=ship   # tags the ship_attempt telemetry (new-ship vs reship retry)
    export DEVKIT_RUN_MODE=ship    # never inherit a caller's review allowlist into a real ship
    unset DEVKIT_SHIP_DRY_GATES
  fi
# Preflight: nothing since staging is allowed to have touched the index. Cheap, and it fails BEFORE
# the operator pays for a multi-minute gate chain.
  ship_assert_staged_unchanged "$WT" "$STAGED_STATE" || { ship_run_keep "staged set changed before the commit"; exit 1; }
  ship_assert_staged_objects_readable "$WT" "preflight, before the commit" || { ship_run_keep "staged objects unreadable before the commit"; exit 1; }
  # Once git may create a commit, a signal must be recorded/forwarded but cannot immediately exit
  # after the supervisor is reaped: ship first needs to checkpoint the landed commit's gate proof.
  GATE_SIGNAL_DEFER_EXIT=1
  COMMIT_STATUS=0
  commit_with_gate_capture "$WT" "$ROOT" "$BR" "$TITLE" "$BODY" || COMMIT_STATUS=$?
# Post-commit, pre-push: the gate chain ran with this worktree's index reachable through the
# GIT_INDEX_FILE git exported into the hook. Prove the commit still contains the briefed work before
# anything leaves the machine — dry runs included, so the check is exercised on every ship path.
  SHIP_COMMIT=$(git -C "$WT" rev-parse HEAD)
  if [ "$SHIP_COMMIT" != "$BASE" ]; then
    ship_assert_commit_scope "$WT" "$BASE" "$STAGED_STATE" || { ship_run_keep "commit scope assertion failed"; exit 1; }
    # Persist proof when the commit completed but the supervisor subsequently reported its defined
    # timeout/signal statuses. Never mint a receipt for rc=1: run_gates_with_capture deliberately
    # changes a successful child to 1 when mandatory gate-log persistence fails, and retry must keep
    # failing closed in that case. A later retry may skip gates only when this ref names its exact tip.
    case "$COMMIT_STATUS" in
      0|124|129|130|131|137|143)
        git update-ref "$RECOVERY_RECEIPT_REF" "$SHIP_COMMIT"
        # Pin what the gate chain added beyond the brief, so a retry can resume a commit its OWN
        # gates widened instead of refusing it as out-of-scope (sc-2089). Written only where the
        # receipt is, so a record can never authorise a commit that has no receipt. Best effort by
        # design: every failure path here leaves the retry on the strict comparison, which is the
        # safe direction, and none of them may cost a ship that has already passed every gate.
        if ship_record_gate_adds "$WT" "$BASE" "$STAGED_STATE" "$GATE_ADDS_FILE"; then
          GATE_ADDS_BLOB=$(git -C "$ROOT" hash-object -w --stdin < "$GATE_ADDS_FILE" 2>/dev/null || true)
          if [ -n "$GATE_ADDS_BLOB" ]; then
            git update-ref "$RECOVERY_GATE_ADDS_REF" "$GATE_ADDS_BLOB"
          fi
        fi
        ;;
    esac
  fi
  # A signal can land after the gate supervisor exits but before its reap callback clears the PID.
  # Record any proven landed commit above, then honor the signal before push or success (sc-1538).
  GATE_SIGNAL_DEFER_EXIT=
  [ "$REQUESTED_SIGNAL_STATUS" -eq 0 ] || exit "$REQUESTED_SIGNAL_STATUS"
  [ "$COMMIT_STATUS" -eq 0 ] || exit "$COMMIT_STATUS"
fi

if [ "$DRY_GATES" -eq 1 ]; then
  echo "✓ Ship dry gates passed; no commit, branch, push, or PR was kept." >&2
  exit 0
fi

if [ -n "${SHIP_DRY_RUN:-}" ]; then
  echo "DRY: committed locally on $BR, skipped push + PR." >&2
  git -C "$WT" show --stat --oneline HEAD >&2
  exit 0
fi

# sc-1508: hand the pre-push hook the EXACT commit this ship built, so it can skip its
# typecheck + test:run for this one commit (CI's gate.yml re-runs both on the PR). Command-scoped —
# nothing else inherits it — and content-keyed: the hook fails closed and runs the full suite for any
# ref whose oid is not this sha, so a plain `git push` (no env) is unchanged.
if [ -n "$LOCAL_BRANCH_EXISTS" ]; then
  DEVKIT_SHIP_PREPUSH_SKIP_SHA="$RECOVERY_COMMIT" \
    git -C "$WT" push origin "$RECOVERY_COMMIT:refs/heads/$BR"
else
  DEVKIT_SHIP_PREPUSH_SKIP_SHA="$(git -C "$WT" rev-parse HEAD)" git -C "$WT" push -u origin "$BR"
fi

# Push succeeded → the branch is live on the remote and reconcilable NOW, whatever the PR step does.
# Open the PR, but a create FAILURE must NOT skip the manifest write below: recording on PR-create
# (not on push) orphans the pushed branch from reconcile forever on a single gh hiccup (wrong account,
# transient GraphQL error), so the merged work later lingers as stale local copies. Capture the
# failure instead of exiting; record the branch first, then surface the failure afterward.
PR_CREATE_FAILED=
PR_URL=$( cd "$WT" && gh pr create --repo "$REPO" --base "$BASE_REF" --head "$BR" --title "$TITLE" --body "$BODY" ) || PR_CREATE_FAILED=1
PR_NUM=""
if [ -z "$PR_CREATE_FAILED" ]; then
  echo "$PR_URL"   # surface the PR URL (we captured gh's stdout to recover the PR number below)
  # The PR number is the trailing path segment of the URL gh just printed (one gh call, not two).
  PR_NUM=${PR_URL##*/}
  [[ "$PR_NUM" =~ ^[0-9]+$ ]] || PR_NUM=""
  # Telemetry: tie this ship's id to the PR it opened, so the usage tracker links a ship row to its
  # PR directly (no gh-by-branch lookup needed). ship_result already fired during the gate chain —
  # before the PR existed — so this is a separate line the collector upserts onto the ship. Reuses
  # the DEVKIT_SHIP_ID/DEVKIT_GATE_EVENTS that the sourced commit-with-gate-capture.sh exported;
  # best-effort (`|| true`) so telemetry can never fail a ship. pr_number is a bare JSON number, else null.
  if [ -n "${DEVKIT_GATE_EVENTS:-}" ] && [ -n "${DEVKIT_SHIP_ID:-}" ]; then
    printf '{"type":"ship_pr","ship_id":"%s","devkit_version":"%s","pr_url":"%s","pr_number":%s,"ts":"%s"}\n' \
      "$(devkit_json_escape "$DEVKIT_SHIP_ID")" "$(devkit_json_escape "$DEVKIT_TELEMETRY_VERSION")" \
      "$(devkit_json_escape "$PR_URL")" "${PR_NUM:-null}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >> "$DEVKIT_GATE_EVENTS" 2>/dev/null || true
  fi
  if [ "$QAVIS_PUBLISH" -eq 1 ] && [ -n "$PR_NUM" ]; then
    . "$SCRIPT_DIR/publish-qavis.sh"
    publish_qavis_receipt \
      "$ROOT" "$PR_NUM" "${RECOVERY_PARENT:-$BASE}" "${RECOVERY_COMMIT:-$SHIP_COMMIT}"
  fi
fi

# Record what shipped the instant the PUSH succeeded — independent of `gh pr create` — so `devkit
# reconcile` can later replace these now-stale local copies in the shared tree with the merged-upstream
# version (no stash/pull). On a PR-create failure we record pr:null; reconcile self-heals it once a PR
# exists + merges (it resolves merge state by `gh pr view <branch>`, not by the stored number).
# Best-effort: a manifest miss only costs a manual reconcile later — it must never unwind the push.
# --git-root "$WT" hashes the just-COMMITTED blobs (what the PR shipped), not $ROOT's working tree —
# so a parallel agent's edit to a shipped file in this window can't be mis-recorded as the shipped blob.
# The manifest itself still lands in $ROOT (the persistent shared tree); $WT is removed right after.
# devkit's own modules are .mts in the source tree (Node strips types) and compiled .mjs in an
# installed consumer (dist). Prefer whichever exists beside this script.
# --base-sha is the sha the SHIPPED COMMIT is diffed against (classify() reads add-vs-modify from
# `cat-file -e <sha>:<path>` and a deletion's pre-deletion blob from `ls-tree <sha>`), so it must be that
# commit's OWN parent. On a new ship the two are the same value — the worktree was cut at $BASE, so the
# commit's parent IS $BASE, and RECOVERY_PARENT is empty. On a resume they diverge: $BASE was re-resolved
# this invocation and may have advanced, which would record this ship's ADD as a modify (upstream added
# the path meanwhile) or a stranger's newer blob as a delete's pre-deletion blob — silently, in both
# cases. --base-ref stays the branch NAME: that is the PR target, not a sha. It records the base this
# ship ATTEMPTED, even when `gh pr create` then rejected it — the manifest is a record of what
# happened, not of what should have happened, and reconcile resolves merge state via
# `gh pr view <branch>` rather than from this field. The recovery hint below normally re-prints this
# same base and diverges only when it has actually left origin, saying so when it does (sc-2261).
RMW="$SCRIPT_DIR/reconcile-manifest-write.mts"; [ -f "$RMW" ] || RMW="$SCRIPT_DIR/reconcile-manifest-write.mjs"
node "$RMW" \
  --root "$ROOT" --git-root "$WT" --branch "$BR" --repo "$REPO" --base-ref "$BASE_REF" --base-sha "${RECOVERY_PARENT:-$BASE}" --pr "$PR_NUM" -- "${PATHS[@]}" \
  || echo "ship-branch: reconcile manifest not recorded (non-fatal)" >&2

# The push landed, so the recorded invocation is spent — a later ship reusing this branch name must
# not resume THESE bytes. Kept on every earlier failure (that is its whole purpose), and compare-
# and-deleted on the captured generation so a concurrent attempt's newer record survives; the
# shipped paths are handed over so a record carrying a concurrently-donated UNSHIPPED remedy path
# is kept for its --resume. Stderr stays visible: a lock-busy keep must be seen.
[ -z "${SHIP_INTENT_GENERATION:-}" ] || node "$SHIP_INTENT" delete --root "$ROOT" --branch "$BR" --generation "$SHIP_INTENT_GENERATION" -- ${PATHS[@]+"${PATHS[@]}"} || true

# PR-create failed but the push + manifest record both landed: the branch is recoverable AND known to
# reconcile. Tell the operator how to open the PR by hand; reconcile cleans the branch once it merges.
if [ -n "$PR_CREATE_FAILED" ]; then
  echo "push OK but PR create failed — branch is pushed AND recorded for reconcile." >&2
  echo "Open the PR by hand (reconcile cleans the branch once it merges):" >&2
  # sc-2261's original defect was re-printing a base that could never work. The cure is NOT to
  # substitute one unconditionally: `gh pr create` fails for plenty of reasons that have nothing to do
  # with the base (an API outage, a permissions problem), and swapping a deliberately chosen
  # `--base release/1.0` for origin's default would send the operator to open the PR against the wrong
  # branch — a quieter, worse error than the one being fixed. So ASK which failure this was: the base
  # was proven to be a branch on origin before the push, so re-print it unless it has vanished since.
  set +e
  git ls-remote --exit-code --heads origin "refs/heads/$BASE_REF" >/dev/null 2>&1
  hint_base_check=$?
  set -e
  # Only exit 2 proves the base is ABSENT. ls-remote is also non-zero for auth and network trouble,
  # and treating those as deletion would announce a branch is gone on the strength of a failed lookup
  # — then swap a perfectly good base for a different one. Same three-way polarity as the probes above.
  if [ "$hint_base_check" -ne 2 ]; then
    # Present, or unverifiable. Either way the base is not shown to be the cause, so hand the command
    # back verbatim rather than substituting on a guess.
    echo "  gh pr create --repo $(ship_shell_quote "$REPO") --base $(ship_shell_quote "$BASE_REF") --head $(ship_shell_quote "$BR")" >&2
    if [ "$hint_base_check" -eq 0 ]; then
      echo "  ('$BASE_REF' is on origin, so the base is not the cause — see gh's error above.)" >&2
    else
      echo "  (could not re-verify '$BASE_REF' on origin (ls-remote exit $hint_base_check); it is the base this ship used.)" >&2
    fi
  else
    # The base is genuinely gone (deleted between the preflight and now). Only here may the hint name
    # a different one, and only one that is known to exist.
    PR_HINT_BASE=$(ship_origin_head_branch) || PR_HINT_BASE=
    echo "  gh pr create --repo $(ship_shell_quote "$REPO") --base $(ship_shell_quote "${PR_HINT_BASE:-<branch-on-origin>}") --head $(ship_shell_quote "$BR")" >&2
    if [ -n "$PR_HINT_BASE" ]; then
      echo "  ('$BASE_REF' is no longer on origin; '$PR_HINT_BASE' is origin's default branch.)" >&2
    else
      echo "  ('$BASE_REF' is no longer on origin; choose a base that is.)" >&2
    fi
  fi
  exit 1
fi

# Success: the branch is on the remote with its PR, so the local copy is redundant.
# Drop it now (worktree first — a branch checked out in a worktree can't be deleted).
# Only reached on full success; any earlier failure keeps the branch for recovery.
git worktree remove --force "$WT" 2>/dev/null || true
if [ -n "$LOCAL_BRANCH_EXISTS" ]; then
  # The preserved local branch is redundant only while it still names the commit just published.
  # A concurrent update belongs to somebody else and must survive this retry's cleanup.
  # Compare-and-delete in one ref transaction. A read followed by `git branch -D` could erase a
  # concurrent update that landed between those commands.
  git update-ref -d "refs/heads/$BR" "$RECOVERY_COMMIT" 2>/dev/null || true
else
  git branch -D "$BR" 2>/dev/null || true
fi
git update-ref -d "$RECOVERY_RECEIPT_REF" "${RECOVERY_COMMIT:-${SHIP_COMMIT:-}}" 2>/dev/null || true
# No compare-and-delete for the sibling record: the receipt uses one because it names a COMMIT a
# concurrent actor could legitimately advance, whereas this blob is devkit-private, rewritten whole
# on every ship to this branch, and worthless once the commit it describes is published.
git update-ref -d "$RECOVERY_GATE_ADDS_REF" 2>/dev/null || true
