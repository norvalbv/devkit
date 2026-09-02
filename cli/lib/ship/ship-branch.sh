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
# and is removed on exit. Dirty-tree scope stays explicit; --from-branch is the opt-in
# exception because committed Git objects provide an ownership boundary.
#
# Usage:   ship-branch.sh <branch> "<title>" [--dry-gates] [--base <b>] [--from-branch] [--body-file <f>] [--link <d>]... [--] <path...>
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

# Bound branch-source advertisement/fetch before the already-bounded gate runner starts. The shared
# supervisor terminates the complete Git/helper process group on expiry (portable on macOS/Linux).
bounded_remote_git() {
  # .mts in source, built .mjs in an installed consumer (the gate-config-paths dual-ext idiom).
  local supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mts"
  [ -f "$supervisor" ] || supervisor="$SCRIPT_DIR/review/process/gate-supervisor.mjs"
  node "$supervisor" "${DEVKIT_REMOTE_TIMEOUT_SECONDS:-60}" -- git "$@"
}

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
FROM_BRANCH=0      # derive a frozen committed path set from origin/<base>..HEAD
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
    --from-branch)
      [ "$RESUME" -eq 0 ] || { echo "--resume replays the recorded source mode — omit --from-branch" >&2; exit 1; }
      FROM_BRANCH=1; shift ;;
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
  #   mode, sourceMode, title, base, noQavisPublish, updatePrBody, createdAt, generation,
  #   sourceAttemptId, nlinks, <links...>, body, <paths...>. New-ship ignores updatePrBody.
  [ "${#SI_FIELDS[@]}" -ge 12 ] || { echo "recorded invocation is malformed — run the full devkit ship command" >&2; exit 1; }
  SI_MODE=${SI_FIELDS[0]}
  if [ "$SI_MODE" = "reship" ]; then
    # The blocked attempt was a `--pr` re-push; hand over so the agent needn't remember which form
    # it used. POSITIVE match + one-shot marker only — an unrecognised mode must hard-error below,
    # never bounce between the two scripts.
    [ -z "${DEVKIT_SHIP_RESUME_DISPATCHED:-}" ] || { echo "recorded invocation dispatched in a loop (mode '$SI_MODE') — the manifest is inconsistent; run the full command" >&2; exit 1; }
    DEVKIT_SHIP_RESUME_DISPATCHED=1 exec bash "$SCRIPT_DIR/reship.sh" --resume "$BR" ${RESUME_ARGS[@]+"${RESUME_ARGS[@]}"}
  fi
  [ "$SI_MODE" = "ship" ] || { echo "recorded invocation has unrecognised mode '$SI_MODE' — run the full devkit ship command" >&2; exit 1; }
  SI_SOURCE_MODE=${SI_FIELDS[1]}
  case "$SI_SOURCE_MODE" in
    explicit) FROM_BRANCH=0 ;;
    branch) FROM_BRANCH=1 ;;
    *) echo "recorded invocation has unrecognised source mode '$SI_SOURCE_MODE' — run the full devkit ship command" >&2; exit 1 ;;
  esac
  TITLE=${SI_FIELDS[2]}
  BASE_FLAG=${SI_FIELDS[3]}
  [ "${SI_FIELDS[4]}" != "1" ] || QAVIS_PUBLISH=0
  RESUME_CREATED=${SI_FIELDS[6]}
  RESUME_GENERATION=${SI_FIELDS[7]}
  RESUME_SOURCE_ATTEMPT_ID=${SI_FIELDS[8]}
  SI_NLINKS=${SI_FIELDS[9]}
  case "$SI_NLINKS" in *[!0-9]*|'') echo "recorded invocation is malformed (nlinks '$SI_NLINKS')" >&2; exit 1 ;; esac
  si_i=10
  si_body_at=$((10 + SI_NLINKS))
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
  if [ "$FROM_BRANCH" -eq 1 ] && [ "${#PATHS[@]}" -gt 0 ]; then
    echo "--from-branch resume has frozen path membership and refuses extra paths; run a fresh full --from-branch invocation to derive a new committed set" >&2
    exit 1
  fi
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

[ "$FROM_BRANCH" -eq 0 ] || [ -n "$BASE_FLAG" ] || { echo "--from-branch requires --base <remote-branch>" >&2; exit 1; }
if [ "$RESUME" -eq 0 ] && [ "$FROM_BRANCH" -eq 1 ] && [ "${#PATHS[@]}" -gt 0 ]; then
  echo "--from-branch derives its path set and cannot be combined with explicit paths" >&2
  exit 1
fi
[ "$FROM_BRANCH" -eq 1 ] || [ "${#PATHS[@]}" -gt 0 ] || { echo "no paths given" >&2; exit 1; }
if [ "$FROM_BRANCH" -eq 1 ]; then
  # The mode constructs its own root-anchored literal selectors. Ambient Git pathspec modes either
  # reinterpret those magic prefixes as plain text or conflict with them, so they are not inputs.
  unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
fi
# Files only: `git diff/ls-files -- <dir>` recurses and would sweep in a parallel
# agent's edits under that directory, defeating the per-file isolation. (A deleted
# file is not a dir, so it still passes — deletions are valid pathspecs.)
if [ "$FROM_BRANCH" -eq 0 ]; then
  for p in "${PATHS[@]}"; do
    [ -d "$p" ] && {
      echo "directory path not allowed (pass individual files): $p" >&2
      echo "  list its tracked files: git ls-files -- \"$p\"" >&2
      exit 1
    }
  done
fi

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
if [ -n "$LOCAL_BRANCH_EXISTS" ] && [ "$FROM_BRANCH" -eq 1 ] && [ "$RESUME" -eq 0 ]; then
  echo "branch already exists: $BR" >&2
  echo "  a fresh --from-branch invocation cannot adopt a prior receipt; use devkit ship --resume '$BR' to replay its recorded v3 branch source, or choose a new branch name" >&2
  exit 1
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
  bounded_remote_git ls-remote --exit-code --heads origin "refs/heads/$BR" >/dev/null 2>&1
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
SOURCE_HEAD=""
# The CALLER's worktree HEAD, pinned HERE rather than beside the export below: in a shared
# parallel-agent checkout $ROOT can gain a commit between staging and the gates, which would name a
# tree the caller never read (sc-2480). Empty when unreadable; the gate then reports no divergence.
CALLER_HEAD=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)
if [ "$FROM_BRANCH" -eq 1 ]; then
  # A post-commit receipt resume publishes the immutable gated OID, so the caller's current HEAD is
  # not an input. Pre-commit/new runs pin it before the network step and never chase a moving HEAD.
  [ -n "$LOCAL_BRANCH_EXISTS" ] || SOURCE_HEAD=$(git -C "$ROOT" rev-parse HEAD)

  # Pin the advertised branch OID, then fetch its objects without a destination or FETCH_HEAD. This
  # uses the normal fetch transport (including HTTPS remote helpers) while creating no ref that can
  # survive SIGKILL. A force-update between the two calls can make the advertised object unavailable;
  # one retry obtains a new coherent advertisement rather than guessing.
  BASE_ADVERTISEMENT=$(mktemp "${TMPDIR:-/tmp}/ship-base-advertisement.XXXXXX")
  BASE=""
  base_attempt=0
  while [ "$base_attempt" -lt 2 ] && [ -z "$BASE" ]; do
    base_attempt=$((base_attempt + 1))
    set +e
    bounded_remote_git -C "$ROOT" ls-remote --exit-code --heads origin "refs/heads/$BASE_REF" > "$BASE_ADVERTISEMENT" 2>/dev/null
    base_advertise_status=$?
    set -e
    case "$base_advertise_status" in
      0) ;;
      2) rm -f "$BASE_ADVERTISEMENT"
         echo "--base: no branch origin/$BASE_REF (a PR base must be a remote branch — not a sha or a tag)" >&2
         exit 1 ;;
      *) rm -f "$BASE_ADVERTISEMENT"
         echo "--from-branch: could not verify origin/$BASE_REF (ls-remote exit $base_advertise_status)" >&2
         exit 1 ;;
    esac
    advertised_oid=""
    advertised_ref=""
    advertised_extra=""
    advertised_lines=0
    while read -r candidate_oid candidate_ref candidate_extra; do
      advertised_lines=$((advertised_lines + 1))
      advertised_oid=$candidate_oid
      advertised_ref=$candidate_ref
      advertised_extra=$candidate_extra
    done < "$BASE_ADVERTISEMENT"
    if [ "$advertised_lines" -ne 1 ] || [ "$advertised_ref" != "refs/heads/$BASE_REF" ] || [ -n "$advertised_extra" ]; then
      rm -f "$BASE_ADVERTISEMENT"
      echo "--from-branch: origin/$BASE_REF returned an invalid advertised identity; refusing to guess" >&2
      exit 1
    fi
    bounded_remote_git -C "$ROOT" fetch -q --no-tags --no-write-fetch-head --refmap= origin "refs/heads/$BASE_REF" 2>/dev/null || {
      rm -f "$BASE_ADVERTISEMENT"
      echo "--from-branch: could not fetch the advertised origin/$BASE_REF commit" >&2
      exit 1
    }
    if git -C "$ROOT" cat-file -e "$advertised_oid^{commit}" 2>/dev/null; then BASE=$advertised_oid; fi
  done
  rm -f "$BASE_ADVERTISEMENT"
  [ -n "$BASE" ] || {
    echo "--from-branch: origin/$BASE_REF moved incompatibly during both pin attempts; retry" >&2
    exit 1
  }
elif [ -n "$BASE_FLAG" ]; then
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

  # Which of the paths being shipped ALSO moved on the base since this branch diverged (sc-2297).
  # ADVISORY — it prints and never blocks. Git merges these three-way, so a same-region overwrite
  # surfaces as a conflict at merge; a block here would instead fire on every legitimate concurrent
  # edit of a shared file in a parallel-agent repo, which is the ignorable-signal failure this whole
  # feature exists to end. What it CAN catch is the case a clean merge hides: a path hand-edited
  # after reading a stale local copy.
  #
  # Only on the --base arm. The default arm sets BASE from local HEAD with no fetch, and it is
  # unreachable from a provisioned worktree anyway — the ls-remote probe above already refuses any
  # branch that is not on origin, which every worktree scratch branch is.
  #
  # --exit-zero plus `|| true` so a drift verdict (exit 3) and any failure to compute one are both
  # incapable of failing the ship: the same fail-open polarity ship_size_preflight uses.
  BASE_DRIFT="$SCRIPT_DIR/base-drift/cli.mts"
  [ -f "$BASE_DRIFT" ] || BASE_DRIFT="$SCRIPT_DIR/base-drift/cli.mjs"
  if [ -f "$BASE_DRIFT" ]; then
    node "$BASE_DRIFT" --root "$ROOT" --base "$BASE_REF" --ship --exit-zero -- "${PATHS[@]}" || true
  fi
else
  BASE=$(git rev-parse HEAD)   # pin once: shared HEAD may advance mid-run
fi

if [ "$FROM_BRANCH" -eq 1 ]; then
  if [ -z "$LOCAL_BRANCH_EXISTS" ]; then
    set +e
    git -C "$ROOT" merge-base --is-ancestor "$BASE" "$SOURCE_HEAD" >/dev/null 2>&1
    ancestry_status=$?
    set -e
    case "$ancestry_status" in
      0) ;;
      1) echo "--from-branch: origin/$BASE_REF (${BASE:0:7}) is not an ancestor of HEAD (${SOURCE_HEAD:0:7}); rebase/merge the base, or deepen a shallow checkout, then retry" >&2; exit 1 ;;
      *) echo "--from-branch: could not verify ancestry (git exit $ancestry_status); fetch/deepen the repository and retry" >&2; exit 1 ;;
    esac

    if [ "$RESUME" -eq 0 ]; then
      BRANCH_PATHS_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-branch-paths.XXXXXX")
      if ! git -C "$ROOT" diff --name-only --no-renames -z "$BASE" "$SOURCE_HEAD" -- \
        | node "$SHIP_INTENT" validate-paths > "$BRANCH_PATHS_FILE"; then
        rm -f "$BRANCH_PATHS_FILE"
        exit 1
      fi
      while IFS= read -r -d '' branch_path; do PATHS+=("$branch_path"); done < "$BRANCH_PATHS_FILE"
      rm -f "$BRANCH_PATHS_FILE"
    fi
  fi
  [ "${#PATHS[@]}" -gt 0 ] || {
    echo "--from-branch: origin/$BASE_REF and HEAD have no committed path differences" >&2
    exit 1
  }

  # Raw PATHS are the storage/display identity. Only Git selectors receive this separately audited,
  # root-anchored literal representation, so names such as '*.txt' and ':(exclude)*' stay filenames.
  GIT_PATHS=()
  for p in "${PATHS[@]}"; do GIT_PATHS+=(":(top,literal)$p"); done

  if [ -z "$LOCAL_BRANCH_EXISTS" ]; then
    # `literal` prevents wildcard/magic reinterpretation but a literal that is now a DIRECTORY still
    # recursively selects descendants. Prove Git's actual BASE..HEAD selection is a subset of the
    # frozen identities before any overlay check or staging can absorb a newly committed child.
    BRANCH_MEMBERS_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-branch-members.XXXXXX")
    BRANCH_SELECTED_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-branch-selected.XXXXXX")
    printf '%s\0' "${PATHS[@]}" > "$BRANCH_MEMBERS_FILE"
    git -C "$ROOT" diff --name-only --no-renames -z "$BASE" "$SOURCE_HEAD" -- "${GIT_PATHS[@]}" > "$BRANCH_SELECTED_FILE"
    if ! node "$SHIP_INTENT" validate-membership --members-file "$BRANCH_MEMBERS_FILE" < "$BRANCH_SELECTED_FILE"; then
      rm -f "$BRANCH_MEMBERS_FILE" "$BRANCH_SELECTED_FILE"
      exit 1
    fi
    rm -f "$BRANCH_SELECTED_FILE"

    GITLINKS_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-branch-gitlinks.XXXXXX")
    : > "$GITLINKS_FILE"
    git -C "$ROOT" ls-tree -r -z "$BASE" -- "${GIT_PATHS[@]}" >> "$GITLINKS_FILE"
    git -C "$ROOT" ls-tree -r -z "$SOURCE_HEAD" -- "${GIT_PATHS[@]}" >> "$GITLINKS_FILE"
    GITLINK_PATHS=()
    while IFS= read -r -d '' tree_entry; do
      tree_meta=${tree_entry%%$'\t'*}
      [ "${tree_meta%% *}" = "160000" ] || continue
      tree_path=${tree_entry#*$'\t'}
      gitlink_seen=0
      for p in ${GITLINK_PATHS[@]+"${GITLINK_PATHS[@]}"}; do [ "$p" = "$tree_path" ] && { gitlink_seen=1; break; }; done
      [ "$gitlink_seen" -eq 1 ] || GITLINK_PATHS+=("$tree_path")
    done < "$GITLINKS_FILE"
    rm -f "$GITLINKS_FILE"
    if [ "${#GITLINK_PATHS[@]}" -gt 0 ]; then
      echo "--from-branch does not ship changed gitlink/submodule entries:" >&2
      for p in "${GITLINK_PATHS[@]}"; do printf '  %q\n' "$p" >&2; done
      rm -f "$BRANCH_MEMBERS_FILE"
      exit 1
    fi
    # Every member came from `git diff --name-only`, so it identifies a leaf entry in BASE, HEAD,
    # or both. Do not reject a member merely because it is a directory in the current checkout: a
    # valid file -> directory transition yields both the deleted file `foo` and added `foo/bar`.

    INDEX_OVERLAYS=$(mktemp "${TMPDIR:-/tmp}/ship-branch-index.XXXXXX")
    WORKTREE_OVERLAYS=$(mktemp "${TMPDIR:-/tmp}/ship-branch-worktree.XXXXXX")
    UNTRACKED_OVERLAYS=$(mktemp "${TMPDIR:-/tmp}/ship-branch-untracked.XXXXXX")
    IGNORED_OVERLAYS=$(mktemp "${TMPDIR:-/tmp}/ship-branch-ignored.XXXXXX")
    git -C "$ROOT" diff --cached --name-only -z "$SOURCE_HEAD" -- "${GIT_PATHS[@]}" \
      | node "$SHIP_INTENT" filter-membership --members-file "$BRANCH_MEMBERS_FILE" > "$INDEX_OVERLAYS"
    git -C "$ROOT" diff --name-only -z -- "${GIT_PATHS[@]}" \
      | node "$SHIP_INTENT" filter-membership --members-file "$BRANCH_MEMBERS_FILE" > "$WORKTREE_OVERLAYS"
    git -C "$ROOT" ls-files -o --exclude-standard -z -- "${GIT_PATHS[@]}" \
      | node "$SHIP_INTENT" filter-membership --members-file "$BRANCH_MEMBERS_FILE" > "$UNTRACKED_OVERLAYS"
    git -C "$ROOT" ls-files -o -i --exclude-standard -z -- "${GIT_PATHS[@]}" \
      | node "$SHIP_INTENT" filter-membership --members-file "$BRANCH_MEMBERS_FILE" > "$IGNORED_OVERLAYS"
    if [ -s "$INDEX_OVERLAYS" ] || [ -s "$WORKTREE_OVERLAYS" ] || [ -s "$UNTRACKED_OVERLAYS" ] || [ -s "$IGNORED_OVERLAYS" ]; then
      echo "--from-branch refuses uncommitted overlays on --from-branch paths; commit or remove these exact overlays:" >&2
      for overlay_pair in \
        "$INDEX_OVERLAYS:index" "$WORKTREE_OVERLAYS:worktree" \
        "$UNTRACKED_OVERLAYS:untracked" "$IGNORED_OVERLAYS:ignored"; do
        overlay_file=${overlay_pair%:*}; overlay_kind=${overlay_pair##*:}
        while IFS= read -r -d '' p; do printf '  %q (%s)\n' "$p" "$overlay_kind" >&2; done < "$overlay_file"
      done
      rm -f "$BRANCH_MEMBERS_FILE" "$INDEX_OVERLAYS" "$WORKTREE_OVERLAYS" "$UNTRACKED_OVERLAYS" "$IGNORED_OVERLAYS"
      exit 1
    fi
    rm -f "$BRANCH_MEMBERS_FILE" "$INDEX_OVERLAYS" "$WORKTREE_OVERLAYS" "$UNTRACKED_OVERLAYS" "$IGNORED_OVERLAYS"
    CURRENT_HEAD=$(git -C "$ROOT" rev-parse HEAD)
    [ "$CURRENT_HEAD" = "$SOURCE_HEAD" ] || {
      echo "--from-branch: HEAD moved while the committed snapshot was prepared (${SOURCE_HEAD:0:7} -> ${CURRENT_HEAD:0:7}); retry" >&2
      exit 1
    }
    echo "--from-branch: ${#PATHS[@]} committed path(s), origin/$BASE_REF ${BASE:0:7} -> HEAD ${SOURCE_HEAD:0:7}" >&2
    for p in "${PATHS[@]}"; do printf '  %q\n' "$p" >&2; done
  fi
else
  GIT_PATHS=("${PATHS[@]}")
fi

# Where the staging patch is ANCHORED, and which briefed paths cannot be three-way merged. See
# patch-anchor.sh for the full reasoning; the short version is that --base re-resolves BASE to
# origin's current tip while the caller's tree was cut at an older ancestor, so a BASE-anchored diff
# stages a REVERT of everything the base landed in between (sc-2451).
#
# --from-branch is skipped outright: it diffs a pinned COMMIT PAIR whose ancestry was already proven
# above, so its merge base IS BASE and the classification would be pure cost. Everywhere else
# ship_patch_base echoes BASE unchanged unless the base genuinely moved under this checkout, which
# keeps the default arm and every in-sync ship byte-identical to before.
. "$SCRIPT_DIR/patch-anchor.sh"
WHOLE_POSITIVES=()
WHOLE_SELECTORS=()
WHOLE_EXCLUDES=()
PATCH_BASE=$BASE
if [ "$FROM_BRANCH" -eq 0 ]; then
  PATCH_BASE=$(ship_patch_base "$ROOT" "$BASE")
  if [ "$PATCH_BASE" != "$BASE" ]; then
    ship_classify_whole_file "$ROOT" "$BASE" "$PATCH_BASE" -- "${GIT_PATHS[@]}"
    echo "ship: origin/$BASE_REF moved to ${BASE:0:7} since this checkout forked at ${PATCH_BASE:0:7} — staging is anchored at the fork point and three-way merged." >&2
    ship_warn_whole_file_drift "$ROOT" "$BASE" "$PATCH_BASE" "$BASE_REF"
  fi
fi

# Preview the raw-line ratchet against the exact base baseline BEFORE creating the worktree.
# NOTE: this measures the CALLER's files against BASE, while a fork-point-anchored ship commits the
# three-way MERGE of those files with the base — so when PATCH_BASE differs the preview can UNDER-count
# a file the base grew. It fails CLOSED (the authoritative in-worktree ratchet still runs and still
# blocks), and it is already --exit-zero advisory, so the imprecision is accepted rather than chased.
. "$SCRIPT_DIR/prepare-gate-worktree.sh"
if [ "$FROM_BRANCH" -eq 0 ] || [ -z "$LOCAL_BRANCH_EXISTS" ]; then
  ship_size_preflight "$ROOT" "$BASE" "${PATHS[@]}"
fi

# Nothing to commit → say so NOW. Staging (below) has exactly three inputs: the tracked diff vs
# BASE, the untracked files in scope, and the untracked-but-IGNORED files in scope (a briefed path
# under a gitignored, force-tracked tree such as devkit's own dist/). All empty ⇒ an empty index — which git only reports AFTER the
# whole gate chain has run ("nothing added to commit but untracked files present", the untracked ones
# being our own gate symlinks), whereupon the EXIT trap force-deletes the branch it just made and
# prints a bare "Deleted branch … (was …)" on stdout. The operator pays a multi-minute gate run for a
# cryptic failure. reship.sh's "no changes vs origin/$BR" guard already covers the re-push flow; here
# is its new-ship twin, hoisted ahead of the worktree so nothing is created to churn. Mirrors ALL
# staging commands exactly — the fork-point-anchored three-way arm over the text pathspec, the
# BASE-anchored whole-file arm over its carve-out, and both enumerations — so the guard cannot
# disagree with what staging will do. It is still not SUFFICIENT once the anchorings differ: a
# fork-point patch can be non-empty here and yet collapse to an empty index when the base has since
# landed byte-identical content, which is why the post-staging emptiness check below exists as its
# second half. A git ERROR (non-zero but not "differences found") reads as
# "has changes" and falls through to the old behaviour — fail toward the status quo, never toward a
# false abort. Says "no changes in" rather than "identical to": a misspelled path also lands here
# (`git diff --quiet -- nonexistent` exits 0), and the wording stays true for it.
if [ -z "$LOCAL_BRANCH_EXISTS" ] &&
   git -C "$ROOT" diff --quiet "$PATCH_BASE" ${SOURCE_HEAD:+"$SOURCE_HEAD"} -- \
     "${GIT_PATHS[@]}" ${WHOLE_EXCLUDES[@]+"${WHOLE_EXCLUDES[@]}"} &&
   { [ "${#WHOLE_SELECTORS[@]}" -eq 0 ] ||
     git -C "$ROOT" diff --quiet "$BASE" ${SOURCE_HEAD:+"$SOURCE_HEAD"} -- "${WHOLE_SELECTORS[@]}"; } &&
   [ -z "$(git -C "$ROOT" ls-files -o --exclude-standard -- "${GIT_PATHS[@]}")" ] &&
   [ -z "$(git -C "$ROOT" ls-files -o -i --exclude-standard -- "${GIT_PATHS[@]}")" ]; then
  echo "nothing to commit: no changes in ${PATHS[*]} vs $BASE_REF (${BASE:0:7})" >&2
  if [ -n "$BASE_FLAG" ] && [ "$PATCH_BASE" != "$BASE" ]; then
    # "identical on origin/<base>" would be FALSE here: what was compared is the FORK POINT, because
    # that is what staging compares. Saying otherwise sends an operator whose --base is entirely
    # correct off to inspect a base state ship never looked at.
    echo "these paths are unchanged since this checkout forked from origin/$BASE_REF at ${PATCH_BASE:0:7} (origin/$BASE_REF has since moved to ${BASE:0:7}) — wrong --base, or a misspelled path?" >&2
  elif [ -n "$BASE_FLAG" ]; then
    # --base already answers "your work is committed elsewhere" — the remaining causes are a base that
    # already has this content, or a typo. Never re-suggest checking out: not doing so is the point.
    echo "these paths are already identical on origin/$BASE_REF — wrong --base, or a misspelled path?" >&2
  else
    echo "already committed, wrong checkout, or a misspelled path? ship bases the PR on this checkout's branch ($BASE_REF) — check out the branch your work is on, or pass --base <branch> to diff your working tree against a different branch instead." >&2
  fi
  exit 1
fi

WT="${TMPDIR:-/tmp}/devkit-ship-${BR//\//-}-$$"
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
# The caller's checkout and the exact shipped paths, for gates that must tell the operator what to
# run OUTSIDE the ephemeral worktree (qavis-advisory: `qavis qa --staged` must see these staged in
# ROOT, where the receipt it writes is linked back into the gate worktree — sc-2487).
export DEVKIT_SHIP_ROOT="$ROOT"
export DEVKIT_SHIP_FROM_BRANCH="$FROM_BRANCH"
# Each path base64-encoded and ':'-joined: env values cannot carry NUL, and a newline or colon in a
# valid filename must survive the round trip into the printed remedy.
DEVKIT_SHIP_PATHS=""
for __dk_p in ${PATHS[@]+"${PATHS[@]}"}; do
  DEVKIT_SHIP_PATHS="${DEVKIT_SHIP_PATHS}$(printf '%s' "$__dk_p" | base64 | tr -d '\n'):"
done
export DEVKIT_SHIP_PATHS
export DEVKIT_SHIP_RESUMED=$RESUME
SHIP_INTENT_GENERATION=""
SHIP_SOURCE_ATTEMPT_ID=
export DEVKIT_SHIP_INTENT_RECORDED=0
if [ "$DRY_GATES" -eq 0 ]; then
  SHIP_INTENT_ARGS=(write --root "$ROOT" --branch "$BR" --mode ship --title "$TITLE")
  [ "$FROM_BRANCH" -eq 0 ] || SHIP_INTENT_ARGS+=(--source-mode branch)
  [ -z "$BASE_FLAG" ] || SHIP_INTENT_ARGS+=(--base "$BASE_FLAG")
  for d in ${LINK_EXTRA[@]+"${LINK_EXTRA[@]}"}; do SHIP_INTENT_ARGS+=(--link "$d"); done
  [ "$QAVIS_PUBLISH" -eq 1 ] || SHIP_INTENT_ARGS+=(--no-qavis-publish)
  if [ "$RESUME" -eq 1 ]; then
    SHIP_INTENT_ARGS+=(--resumed --expect-generation "$RESUME_GENERATION")
    if [ "$FROM_BRANCH" -eq 0 ]; then
      SHIP_INTENT_ARGS+=(--merge-paths)
      for p in ${RESUME_EXTRA_PATHS[@]+"${RESUME_EXTRA_PATHS[@]}"}; do SHIP_INTENT_ARGS+=(--donate "$p"); done
    elif [ -n "$LOCAL_BRANCH_EXISTS" ]; then
      # A preserved branch+receipt retry keeps the source owner that receipt binds. A pre-commit
      # retry has no local ship branch and intentionally refreshes bytes from current HEAD.
      SHIP_INTENT_ARGS+=(--source-attempt-id "$RESUME_SOURCE_ATTEMPT_ID")
    else
      SHIP_SOURCE_ATTEMPT_ID=$(uuidgen 2>/dev/null || echo "$DEVKIT_SHIP_ID-source-$$-$RANDOM")
      SHIP_INTENT_ARGS+=(--source-attempt-id "$SHIP_SOURCE_ATTEMPT_ID")
    fi
  fi
fi

record_ship_intent() {
  [ "$DRY_GATES" -eq 0 ] || return 0
  # Capture the record's ownership token (write prints a per-attempt random generation): success may delete ONLY the
  # record this attempt wrote — a concurrent attempt's newer record must survive for ITS --resume.
  SHIP_INTENT_GENERATION=$(printf '%s' "$BODY" | node "$SHIP_INTENT" "${SHIP_INTENT_ARGS[@]}" -- "${PATHS[@]}") \
    || { SHIP_INTENT_GENERATION=""; echo "ship: invocation not recorded — the retry needs the full command (non-fatal)" >&2; }
  [ -n "$SHIP_INTENT_GENERATION" ] || SHIP_SOURCE_ATTEMPT_ID=
  # Exported flag (not the token itself) so the SUBPROCESS gate runner's timeout banner can tell a
  # recorded attempt (--resume works) from an unrecorded one (--resume would refuse by name).
  export DEVKIT_SHIP_INTENT_RECORDED=$([ -n "$SHIP_INTENT_GENERATION" ] && echo 1 || echo 0)
  if [ "$FROM_BRANCH" -eq 1 ] && [ -n "$SHIP_INTENT_GENERATION" ]; then
    if [ -z "$SHIP_SOURCE_ATTEMPT_ID" ]; then
      if [ "$RESUME" -eq 1 ] && [ -n "$LOCAL_BRANCH_EXISTS" ]; then SHIP_SOURCE_ATTEMPT_ID=$RESUME_SOURCE_ATTEMPT_ID
      else SHIP_SOURCE_ATTEMPT_ID=$SHIP_INTENT_GENERATION
      fi
    fi
  fi
}

# A preserved-commit resume must win its intent CAS before the receipt/source-owner comparison
# below. Fresh attempts wait for atomic branch creation instead, so a losing creator never records.
[ -z "$LOCAL_BRANCH_EXISTS" ] || record_ship_intent

DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mts"
[ -f "$DIST_INTEGRITY" ] || DIST_INTEGRITY="$SCRIPT_DIR/dist-integrity.mjs"

PATCH=$(mktemp "${TMPDIR:-/tmp}/ship.XXXXXX")
# Captured stderr of the three-way apply. `--3way` narrates "Applied patch to 'x' cleanly." for every
# path it had to merge — routine once the fork-point anchoring engages — so its stderr is held back
# and only surfaced on failure, where git has already named each offending path better than a
# reconstruction could.
APPLY_ERR=$(mktemp "${TMPDIR:-/tmp}/ship-apply-err.XXXXXX")
STAGED_STATE=$(mktemp "${TMPDIR:-/tmp}/ship-staged.XXXXXX")
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
RECOVERY_RECEIPT_INTENT_REF="refs/devkit/ship-receipt-intents/$BR"
RECOVERY_RECEIPT_INTENT_BLOB=
# Sibling of the receipt, pinned in the same place at the same instant: a blob holding the
# NUL-delimited paths this ship's own gate chain added beyond the brief (sc-2089). The receipt proves
# the commit was gated; this proves which parts of it the caller did not ask for but devkit wrote.
RECOVERY_GATE_ADDS_REF="refs/devkit/ship-gate-adds/$BR"
GATE_ADDS_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-gate-adds.XXXXXX")
BRANCH_CREATED= # only this invocation's branch may be auto-deleted on an empty/failed commit
cleanup() {
  rm -f "$PATCH" "$APPLY_ERR" "$STAGED_STATE" "$GATE_ADDS_FILE"
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

# This integrity boundary is caller-root-only and must run before any worktree/branch creation. A
# failure is still resumable: record the invocation after the read-only check fails, then exit.
set +e
node "$DIST_INTEGRITY" --root "$ROOT" --base "$BASE" -- "${PATHS[@]}"
DIST_INTEGRITY_STATUS=$?
set -e
if [ "$DIST_INTEGRITY_STATUS" -ne 0 ]; then
  [ "$DEVKIT_SHIP_INTENT_RECORDED" -eq 1 ] || record_ship_intent
  exit "$DIST_INTEGRITY_STATUS"
fi

if [ -n "$LOCAL_BRANCH_EXISTS" ]; then
  # Resume only when the existing branch proves it is the exact output this invocation would have
  # produced: one commit on this base, the same message, and no out-of-scope paths. Explicit-path
  # retries also rebuild a tree from the caller's CURRENT scoped files byte-for-byte. Branch-source
  # retries intentionally do not: their v3 intent already froze the path membership, and the receipt
  # proves the preserved commit is the already-gated snapshot to publish even when a gate formatted it.
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
  if [ -z "$RECOVERY_REASON" ] && [ "$FROM_BRANCH" -eq 1 ]; then
    # A branch-source receipt belongs to one source attempt, not merely to a branch name and
    # commit message. Two full attempts can both pass the absent-branch preflight before either one
    # creates it; the newer intent must never publish the older attempt's gated bytes. The sibling
    # blob is updated atomically with the receipt below and names the stable source attempt id this
    # resume successfully re-recorded. Its separate generation still rotates for record CAS/cleanup;
    # a lost CAS leaves SHIP_SOURCE_ATTEMPT_ID empty and must refuse rather than trust stale read data.
    RECOVERY_RECEIPT_INTENT_BLOB=$(git rev-parse -q --verify "$RECOVERY_RECEIPT_INTENT_REF^{blob}" 2>/dev/null || true)
    RECOVERY_RECEIPT_SOURCE_ATTEMPT_ID=
    [ -z "$RECOVERY_RECEIPT_INTENT_BLOB" ] || RECOVERY_RECEIPT_SOURCE_ATTEMPT_ID=$(git cat-file blob "$RECOVERY_RECEIPT_INTENT_BLOB" 2>/dev/null || true)
    if [ -z "$SHIP_SOURCE_ATTEMPT_ID" ] || [ "$RECOVERY_RECEIPT_SOURCE_ATTEMPT_ID" != "$SHIP_SOURCE_ATTEMPT_ID" ]; then
      RECOVERY_REASON="its gate receipt belongs to a different recorded branch-source attempt"
    fi
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
        GATE_ADD_EXCLUDE+=(":(top,exclude,literal)$gate_path")
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
    git -C "$ROOT" diff --name-only --no-renames -z "$RECOVERY_PARENT" "$RECOVERY_COMMIT" -- > "$RECOVERY_PATHS_ALL"
    # Both sides drop the gate-authored paths, so what remains on each is the CALLER's half of the
    # commit. Equality then states exactly "this brief names everything in the commit that the gates
    # did not write themselves" — the same claim as `changed \ briefed ⊆ record`, expressed in git's
    # own pathspec algebra so it stays NUL-exact instead of going through a sort/comm round trip.
    git -C "$ROOT" diff --name-only --no-renames -z "$RECOVERY_PARENT" "$RECOVERY_COMMIT" \
      -- ${GATE_ADD_EXCLUDE[@]+"${GATE_ADD_EXCLUDE[@]}"} > "$RECOVERY_PATHS_CALLER"
    git -C "$ROOT" diff --name-only --no-renames -z "$RECOVERY_PARENT" "$RECOVERY_COMMIT" \
      -- "${GIT_PATHS[@]}" ${GATE_ADD_EXCLUDE[@]+"${GATE_ADD_EXCLUDE[@]}"} > "$RECOVERY_PATHS_SCOPED"
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

  if [ -z "$RECOVERY_REASON" ] && [ "$FROM_BRANCH" -eq 1 ]; then
    # A receipt means this exact commit already passed the gates. Reconstructing it from SOURCE_HEAD
    # would deadlock whenever a gate formatted one of the frozen paths inside the ship worktree: those
    # bytes never reach the caller's branch. Resume the receipt's immutable OID; only a PRE-COMMIT
    # retry (where no preserved branch exists yet) refreshes bytes from the caller's current HEAD.
    :
  elif [ -z "$RECOVERY_REASON" ]; then
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
      # The second reason a correct commit legitimately differs from $ROOT, and the one this resume
      # check cannot distinguish: when the base moved under this checkout, the preserved commit holds
      # a three-way MERGE of the caller's edits with the base, while $ROOT holds the caller's raw
      # bytes. The refusal is fail-closed and stays — re-deriving the merge here would mean rebuilding
      # the recovery tree through the same staging path — but it must not read as unexplained drift.
      if [ "$PATCH_BASE" != "$BASE" ]; then
        RECOVERY_HINTS+=("origin/$BASE_REF moved since this checkout forked (${PATCH_BASE:0:7} -> ${BASE:0:7}), so the preserved commit carries a three-way MERGE of your edits with the base — it is EXPECTED to differ from your raw files; compare with: git diff $BR -- <path>")
      fi
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
  # The atomic branch/worktree claim comes before the intent write: only its winner may own the
  # resumable record. Dist integrity already passed against the caller root before this claim.
  record_ship_intent

  # Tracked edits (modify + delete, binary-safe) -> worktree index. Branch mode reads only the
  # pinned commit pair; explicit mode keeps the historical BASE-to-working-tree behavior whenever the
  # base has not moved under this checkout, and anchors at the fork point when it has.
  if [ "$PATCH_BASE" = "$BASE" ]; then
    git -C "$ROOT" diff "$BASE" ${SOURCE_HEAD:+"$SOURCE_HEAD"} --binary -- "${GIT_PATHS[@]}" > "$PATCH"
    if [ -s "$PATCH" ]; then git -C "$WT" apply --index "$PATCH"; fi
  else
    # WHOLE-FILE ARM FIRST. It is unconditional, so running it second could overwrite a three-way
    # merge result if a path ever landed in both sets. Every classified path goes through it, and it
    # decides each one from a single content read — see ship_stage_whole_file for why a probe-then-diff
    # pair is unsafe against the shared checkout this reads.
    if [ "${#WHOLE_POSITIVES[@]}" -gt 0 ]; then
      ship_stage_whole_file "$ROOT" "$WT" "$PATCH_BASE" "${WHOLE_POSITIVES[@]}"
    fi

    # TEXT ARM. The three-way set is expressed by SUBTRACTION from the caller's own pathspec rather
    # than as a rebuilt file list: the positive side then cannot degenerate to "all paths", and a path
    # the classification enumeration missed still reaches this arm — failing toward including the
    # caller's work rather than dropping it. An all-carve-out brief simply yields an empty patch.
    git -C "$ROOT" diff "$PATCH_BASE" --binary -- \
      "${GIT_PATHS[@]}" ${WHOLE_EXCLUDES[@]+"${WHOLE_EXCLUDES[@]}"} > "$PATCH"
    if [ -s "$PATCH" ] && ! git -C "$WT" apply --index --3way "$PATCH" 2> "$APPLY_ERR"; then
      # `git apply` is ATOMIC: the structural failure below stages nothing at all, and the conflict
      # failure leaves stages 1/2/3 that make ship_record_staged_state's write-tree fatal 128. Either
      # way there is nothing to salvage and nothing to gate, so abort HERE — before the snapshot, and
      # long before the multi-minute gate chain the operator would otherwise pay for.
      cat "$APPLY_ERR" >&2

      # (a) Same-region overlap. UNMERGED index entries are the unambiguous, locale-independent
      # marker: `git apply --3way` writes stages 1/2/3 exactly when its merge produced conflict hunks.
      # `ls-files -u` names precisely the paths that failed, which is narrower and more actionable
      # than the base-drift overlap set (every path that moved, merged or not).
      APPLY_CONFLICTS=$(git -C "$WT" diff --name-only --diff-filter=U 2>/dev/null || true)
      if [ -n "$APPLY_CONFLICTS" ]; then
        echo "ship: origin/$BASE_REF and your working tree changed the same region of:" >&2
        while IFS= read -r p; do [ -n "$p" ] && printf '  %q\n' "$p" >&2; done <<< "$APPLY_CONFLICTS"
        echo "  ship cannot resolve this for you — the merge has to happen where you can see both sides." >&2
      fi

      # (b) Structural: the base DELETED or RETYPED a briefed path out from under the patch. Git
      # reports this as "does not exist in index", then falls back to direct application and fails the
      # whole patch WITHOUT leaving any unmerged entry — so (a) would name nothing. That string is
      # translatable, so the condition is recomputed from the trees instead. --no-renames turns a
      # base-side rename into the D+A pair this filter sees; T catches file->symlink and
      # file->directory transitions, which break application the same way.
      # Intersected with what the CALLER actually changed. The base-side D/T set alone also contains
      # paths the caller never touched — the base simply deleted them — and naming those would tell an
      # operator their edits target a file they never edited, sending them to inspect the wrong path
      # while the real conflict goes unmentioned.
      APPLY_VANISHED=
      while IFS= read -r p; do
        [ -n "$p" ] || continue
        git -C "$ROOT" diff --quiet "$PATCH_BASE" -- ":(top,literal)$p" 2>/dev/null && continue
        APPLY_VANISHED="${APPLY_VANISHED}${p}"$'\n'
      done <<< "$(git -C "$ROOT" diff --name-only --no-renames --diff-filter=DT \
        "$PATCH_BASE" "$BASE" -- "${GIT_PATHS[@]}" ${WHOLE_EXCLUDES[@]+"${WHOLE_EXCLUDES[@]}"} 2>/dev/null || true)"
      if [ -n "$APPLY_VANISHED" ]; then
        echo "ship: origin/$BASE_REF has deleted or retyped briefed path(s) since ${PATCH_BASE:0:7}:" >&2
        while IFS= read -r p; do [ -n "$p" ] && printf '  %q\n' "$p" >&2; done <<< "$APPLY_VANISHED"
        echo "  your edits target a file the base no longer has — decide whether the deletion or your" >&2
        echo "  edit wins before shipping." >&2
      fi

      # No shallow PRE-probe, deliberately: when the fork-point blobs are absent git falls back to
      # DIRECT application of the same fork-point-anchored patch, which is still correct (that patch
      # carries no deletion hunk for base-only work), so only merge tolerance is lost. Re-anchoring at
      # BASE to dodge this would silently re-stage the sc-2451 revert on every ship in such a repo —
      # fail-open on a DIAGNOSTIC is ship_size_preflight's rule, fail-open on the PAYLOAD is the bug.
      if [ "$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
        echo "  (shallow clone: three-way merge data may be missing — \`git fetch --unshallow\` can turn some of these into clean merges)" >&2
      fi
      echo "  Merge or rebase origin/$BASE_REF into this checkout, then retry the same command." >&2
      exit 1
    fi
  fi

  if [ "$FROM_BRANCH" -eq 0 ]; then
    # Untracked new files in explicit scope -> copy + stage.
    #
    # MATERIALISED, then read in the PARENT shell. `ls-files | while read` runs the body in a
    # SUBSHELL, where the abort below would set an exit status nobody reads and staging would sail
    # straight on. Same temp-file idiom as the branch-paths and gitlink enumerations above; preferred
    # over `done < <(...)`, which loses the enumerator's own failure to set -e.
    UNTRACKED_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-untracked.XXXXXX")
    git -C "$ROOT" ls-files -o --exclude-standard -- "${PATHS[@]}" > "$UNTRACKED_FILE"
    UNTRACKED_CLOBBER=()
    while IFS= read -r f; do
      # A path untracked HERE can still be TRACKED at the refreshed base: the base ADDED it after this
      # checkout forked. Copying wholesale would silently replace the base's version — the untracked
      # twin of sc-2451, and invisible to the patch arm above because the fork point has no such path
      # at all. Only checked when the base actually moved, so the default arm stays byte-identical.
      #
      mkdir -p "$WT/$(dirname "$f")"
      cp -Pp "$ROOT/$f" "$WT/$f"   # -P: keep a symlink a symlink; -p: preserve mode (the +x bit) regardless of umask
      # Checked AFTER the copy, and against the COPY. A path untracked here can still be TRACKED at
      # the refreshed base — the base added it after this checkout forked — and copying wholesale
      # would silently replace the base's version, the untracked twin of sc-2451. Validating the
      # caller's file and then copying it would be two reads of a SHARED checkout a parallel agent may
      # be editing, so what got copied need not be what was approved; the worktree copy is private, so
      # hashing THAT closes the window. Mode and content both, because a regular file whose bytes
      # equal a symlink's target would otherwise convert the entry's type unreviewed.
      if [ "$PATCH_BASE" != "$BASE" ] &&
        git -C "$WT" cat-file -e "$BASE:$f" 2>/dev/null &&
        ! ship_untracked_matches_base "$WT" "$BASE" "$f"; then
        UNTRACKED_CLOBBER+=("$f")
        continue
      fi
      git -C "$WT" add -- "$f"
    done < "$UNTRACKED_FILE"
    rm -f "$UNTRACKED_FILE"
    # Both untracked passes accumulate into UNTRACKED_CLOBBER and are reported together below, so an
    # operator whose ignored and non-ignored paths both collide fixes them in one pass rather than
    # discovering the second only after clearing the first.

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
  # The deletion the guard reads is now anchored where staging is: sc-1489's shape (the caller deletes
  # a file tracked at their OWN fork point) still emits it and is unaffected, but a path the base
  # added after the fork has no deletion to express, so it is force-added here as a new file.
    IGNORED_FILE=$(mktemp "${TMPDIR:-/tmp}/ship-ignored.XXXXXX")
    git -C "$ROOT" ls-files -o -i --exclude-standard -- "${PATHS[@]}" > "$IGNORED_FILE"
    while IFS= read -r f; do
      git -C "$WT" diff --cached --quiet --diff-filter=D -- "$f" || continue
      mkdir -p "$WT/$(dirname "$f")"
      cp -Pp "$ROOT/$f" "$WT/$f"
      # The same base-clobber check the ordinary untracked pass runs, for the same reason: `-f` makes
      # this pass FORCE the add, so a path the base added after the fork — ignored and untracked in
      # this stale checkout, which is exactly devkit's own `dist/` shape — would otherwise replace the
      # base's version with no merge and no diff to review. Materialised to a temp file and read in
      # the parent shell so the abort is not swallowed by a pipeline subshell.
      if [ "$PATCH_BASE" != "$BASE" ] &&
        git -C "$WT" cat-file -e "$BASE:$f" 2>/dev/null &&
        ! ship_untracked_matches_base "$WT" "$BASE" "$f"; then
        UNTRACKED_CLOBBER+=("$f")
        continue
      fi
      git -C "$WT" add -f -- "$f"
    done < "$IGNORED_FILE"
    rm -f "$IGNORED_FILE"
    if [ "${#UNTRACKED_CLOBBER[@]}" -gt 0 ]; then
      echo "ship: origin/$BASE_REF already tracks these briefed path(s) with different content, but they are untracked in this checkout:" >&2
      for p in "${UNTRACKED_CLOBBER[@]}"; do printf '  %q\n' "$p" >&2; done
      echo "  shipping them would replace the base's version wholesale, with no merge and no diff to review." >&2
      echo "  Merge origin/$BASE_REF into this checkout so git can reconcile them, then retry." >&2
      exit 1
    fi
  fi

# Second half of the nothing-to-commit guard, at the only other point where the answer is knowable.
# That guard proves the caller's tree DIFFERS from the fork point. Once the two anchorings differ that
# is no longer sufficient to prove the ship CONTAINS anything: a fork-point patch applies cleanly and
# stages NOTHING when origin/$BASE_REF has since landed byte-identical content (a cherry-pick, or a
# sibling agent shipping the same change first). Without this the operator pays the whole gate chain
# to reach git's cryptic "nothing added to commit but untracked files present" — where the untracked
# files it names are our OWN gate symlinks — and the EXIT trap then deletes the branch underneath them.
#
# Placed AFTER both untracked passes, which can legitimately be the sole payload, and BEFORE
# ship_record_staged_state, whose write-tree succeeds on an empty index and would let this slide past.
# Only the total case is spoken for: a partially collapsed ship is correct, and leaves a non-empty
# index that never reaches here.
  if git -C "$WT" diff --cached --quiet; then
    if [ "$PATCH_BASE" != "$BASE" ]; then
      echo "nothing to commit: origin/$BASE_REF (${BASE:0:7}) already contains every briefed change" >&2
      echo "  your tree differs from where this checkout forked (${PATCH_BASE:0:7}), but $BASE_REF has since" >&2
      echo "  landed identical content for ${PATHS[*]} — there is nothing left for this PR to carry." >&2
    else
      # Anchorings agree, so the pre-worktree guard has already proven a difference exists and the
      # patch stages exactly what it expresses — this is unreachable by the sc-2451 route. Kept as a
      # backstop with honest wording rather than repeating a claim about the base that was not tested.
      echo "nothing to commit: staging ${PATHS[*]} vs $BASE_REF (${BASE:0:7}) produced an empty index" >&2
    fi
    exit 1
  fi

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
# Pinned far above, before staging — see CALLER_HEAD.
  export DEVKIT_SHIP_SOURCE_HEAD="$CALLER_HEAD"
  if [ "$DRY_GATES" -eq 1 ]; then
    export DEVKIT_SHIP_MODE=dry-gates
    export DEVKIT_RUN_MODE=dry-gates
    export DEVKIT_REVIEW_GUARDS=comments
    export DEVKIT_SHIP_DRY_GATES=1
    echo "🧪 Ship dry gates: exact base/path staging; running formatter, configured deterministic/structure/extra gates, and the comment budget gate." >&2
    echo "   Skipping decision, Qavis, domain reviewer, completeness, commit, push, and PR creation." >&2
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
        RECEIPT_WRITTEN=0
        if [ "$FROM_BRANCH" -eq 1 ]; then
          if [ -n "$SHIP_SOURCE_ATTEMPT_ID" ]; then
            RECOVERY_RECEIPT_INTENT_BLOB=$(printf '%s' "$SHIP_SOURCE_ATTEMPT_ID" | git -C "$ROOT" hash-object -w --stdin)
            # One ref transaction prevents a crash or competing attempt from leaving a receipt for
            # one commit paired with another source attempt's ownership token.
            git -C "$ROOT" update-ref --stdin <<EOF
start
update $RECOVERY_RECEIPT_REF $SHIP_COMMIT
update $RECOVERY_RECEIPT_INTENT_REF $RECOVERY_RECEIPT_INTENT_BLOB
prepare
commit
EOF
            RECEIPT_WRITTEN=1
          else
            echo "ship: branch-source gate receipt not recorded because this attempt did not own a recorded invocation; an interrupted run cannot be resumed" >&2
          fi
        else
          git update-ref "$RECOVERY_RECEIPT_REF" "$SHIP_COMMIT"
          RECEIPT_WRITTEN=1
        fi
        # Pin what the gate chain added beyond the brief, so a retry can resume a commit its OWN
        # gates widened instead of refusing it as out-of-scope (sc-2089). Written only where the
        # receipt is, so a record can never authorise a commit that has no receipt. Best effort by
        # design: every failure path here leaves the retry on the strict comparison, which is the
        # safe direction, and none of them may cost a ship that has already passed every gate.
        if [ "$RECEIPT_WRITTEN" -eq 1 ] && ship_record_gate_adds "$WT" "$BASE" "$STAGED_STATE" "$GATE_ADDS_FILE"; then
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
RMW_PATH_MODE=()
[ "$FROM_BRANCH" -eq 0 ] || RMW_PATH_MODE+=(--literal-paths)
node "$RMW" \
  --root "$ROOT" --git-root "$WT" --branch "$BR" --repo "$REPO" --base-ref "$BASE_REF" --base-sha "${RECOVERY_PARENT:-$BASE}" --tip-sha "${RECOVERY_COMMIT:-$SHIP_COMMIT}" --pr "$PR_NUM" \
  ${RMW_PATH_MODE[@]+"${RMW_PATH_MODE[@]}"} -- "${PATHS[@]}" \
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
[ -z "$RECOVERY_RECEIPT_INTENT_BLOB" ] || git update-ref -d "$RECOVERY_RECEIPT_INTENT_REF" "$RECOVERY_RECEIPT_INTENT_BLOB" 2>/dev/null || true
# No compare-and-delete for the sibling record: the receipt uses one because it names a COMMIT a
# concurrent actor could legitimately advance, whereas this blob is devkit-private, rewritten whole
# on every ship to this branch, and worthless once the commit it describes is published.
git update-ref -d "$RECOVERY_GATE_ADDS_REF" 2>/dev/null || true
