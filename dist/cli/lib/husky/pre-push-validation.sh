#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Git's "this ref does not exist" oid is all zeros at the repository's hash width — 40 for SHA-1,
# 64 for SHA-256. Match on the shape, not a fixed-width literal, or every deletion in a SHA-256 repo
# reads as a real update. (DEVKIT_SHIP_PREPUSH_SKIP_SHA below already accepts both widths.)
is_zero_oid() {
  case "$1" in
    *[!0]* | '') return 1 ;;
    *) return 0 ;;
  esac
}
# sc-1508: the exact commit sha a `devkit ship` is pushing (set command-scoped by ship-branch.sh /
# reship.sh). Only a 40/64-hex non-zero oid is honoured; anything else — including a plain `git push`
# where the env is unset — is treated as absent, so the branch path falls through to the full suite.
SHIP_SKIP_SHA="${DEVKIT_SHIP_PREPUSH_SKIP_SHA:-}"
if ! { [[ "$SHIP_SKIP_SHA" =~ ^[0-9a-f]{40}$ ]] || [[ "$SHIP_SKIP_SHA" =~ ^[0-9a-f]{64}$ ]]; }; then
  SHIP_SKIP_SHA=
fi
GATE_PHASE=
GATE_HEAD_OID=
gate_rc=0
NON_TAG_UPDATE_COUNT=0
NON_TAG_MATCH_COUNT=0
UPDATES_FILE=$(mktemp "${TMPDIR:-/tmp}/devkit-pre-push-updates.XXXXXX")
TAG_TEMP_ROOT=
TAG_WORKTREE=
TAG_COMMITS=()
HAS_UPDATES=0
HAS_NON_TAG_UPDATE=0

. "$SCRIPT_DIR/../ship/prepare-gate-worktree.sh"

cleanup_tag_worktree() {
  if [ -n "$TAG_WORKTREE" ]; then
    git -C "$ROOT" worktree remove --force "$TAG_WORKTREE" >/dev/null 2>&1 || true
  fi
  if [ -n "$TAG_TEMP_ROOT" ]; then
    rm -rf -- "$TAG_TEMP_ROOT"
  fi
  TAG_WORKTREE=
  TAG_TEMP_ROOT=
}

cleanup() {
  cleanup_tag_worktree
  rm -f -- "$UPDATES_FILE"
}

trap cleanup EXIT
# A signal must never turn a captured failure into a different code, and must never yield 0. Once
# gate_rc holds a real verdict it wins; before that, the signal's own conventional code applies —
# which still blocks. Installed ONCE, at the top: re-pointing the traps later would leave a window
# between run_checks returning and the new trap taking effect.
signal_exit() {
  if [ "${gate_rc:-0}" -ne 0 ]; then
    exit "$gate_rc"
  fi
  exit "$1"
}
trap 'signal_exit 129' HUP
trap 'signal_exit 130' INT
trap 'signal_exit 131' QUIT
trap 'signal_exit 143' TERM

# The `|| return $?` guards are load-bearing, not style. The branch call site is now an OR-list, and
# per docs/decisions/fail-open-needs-an-errexit-safe-call.md an OR-list suppresses errexit for the
# whole dynamic extent of the call — so a bare two-subshell split would run the entire suite after a
# failed typecheck. GATE_PHASE buys "typecheck failed, so there is nothing to attribute" for free.
run_checks() {
  local worktree=$1
  # Pin the commit being judged BEFORE the suite runs. Attribution re-reading HEAD afterwards would
  # narrate the base of whatever another process advanced HEAD to, not the tree that actually failed.
  GATE_HEAD_OID=$(git -C "$worktree" rev-parse --verify HEAD 2>/dev/null || true)
  GATE_PHASE=typecheck
  (
    cd "$worktree"
    bun run typecheck
  ) || return $?
  GATE_PHASE=test
  (
    cd "$worktree"
    bun run test:run
  ) || return $?
  GATE_PHASE=
  return 0
}

append_tag_commit() {
  local candidate=$1 existing
  if [ "${#TAG_COMMITS[@]}" -gt 0 ]; then
    for existing in "${TAG_COMMITS[@]}"; do
      [ "$existing" = "$candidate" ] && return 0
    done
  fi
  TAG_COMMITS+=("$candidate")
}

# ---------------------------------------------------------------------------------------------
# sc-2198: narrate WHOSE fault a blocked push is. Never decide it.
#
# On 2026-08-27 main was red for 5h15m; a developer pushing an unrelated two-file change saw five
# failures in files they had never touched, read a correct block as flake, and pushed --no-verify.
# The block was right. What was missing was any way to tell "I broke this" from "main is red".
#
# THE INVARIANT: every line below runs AFTER the verdict is captured, is reached through an
# errexit-suppressing OR-list, contains no `exit`, and returns non-zero (printing nothing) on every
# unhappy path. The authoritative run_checks keeps zero added flags, zero redirection and zero
# pipes, so a green suite can never be reddened by anything here.
# ---------------------------------------------------------------------------------------------

# attribution_base
# Print a locally-resolvable base commit for the tree run_checks just judged, or print nothing and
# return non-zero. The base is derived ONLY from the ref lines this push negotiated with the remote:
# git supplies remote_oid on stdin, freshly agreed with the remote moments ago, which is why the
# rejection of origin/main in ratchets-blame-the-change-not-the-tree does not bind here. There is no
# tracking-ref fallback — that WOULD be the rejected comparison, and a brand-new branch simply has no
# base this push agreed on. Ambiguity degrades to silence rather than a guess.
attribution_base() {
  local head_oid lref loid rref roid
  local picked= picked_set=0

  head_oid=$GATE_HEAD_OID
  [ -n "$head_oid" ] || return 1

  while read -r lref loid rref roid; do
    [ -n "${rref:-}" ] || continue
    case "$rref" in refs/tags/*) continue ;; esac
    is_zero_oid "$loid" && continue # a deletion has no tree to judge
    if [ "$loid" = "$head_oid" ]; then
      # Two refs carrying the same tree to different remote tips: whichever we picked would be an
      # arbitrary function of input order, so pick neither.
      if [ "$picked_set" -eq 1 ] && [ "$picked" != "$roid" ]; then
        return 1
      fi
      picked=$roid
      picked_set=1
    fi
  done < "$UPDATES_FILE"

  # run_checks tested the WORKTREE, i.e. GATE_HEAD_OID's tree. A ref that carries some other commit
  # — pushing `feature` while checked out on `main` — was never the thing measured, so attributing
  # this run's failures to its base would name the wrong change. Only an update whose local oid IS
  # the tested tree may supply the base; anything else is silence.
  [ "$picked_set" -eq 1 ] || return 1

  # A brand-new branch (an all-zero remote oid) or a tip this checkout has never fetched.
  is_zero_oid "$picked" && return 1
  git -C "$ROOT" cat-file -e "${picked}^{commit}" 2>/dev/null || return 1

  # A force-push or rebase makes the remote tip a non-ancestor; the shared point is the honest base.
  # When the tip IS an ancestor — the common case — merge-base returns it unchanged, so this is free.
  git -C "$ROOT" merge-base "$head_oid" "$picked" 2>/dev/null
}

# attribute_push_failure
# Narration for a FAILED run_checks. Returns non-zero for "nothing honest to say". Its sole call site
# swallows that with `|| true`, so no statement in here can change the push verdict. There is no
# `exit` anywhere below this line.
attribute_push_failure() {
  local base subject conclusion

  [ "${DEVKIT_PREPUSH_ATTRIBUTION:-1}" = 0 ] && return 1
  # A typecheck failure produced no test results, so there is nothing to attribute — at zero cost.
  [ "$GATE_PHASE" = test ] || return 1

  base=$(attribution_base) || return 1
  [ -n "$base" ] || return 1

  subject=$(git -C "$ROOT" log -1 --format='%h  %s  (%an)' "$base" 2>/dev/null) || subject=$base

  # CI's verdict on the base, when it is worth anything. ONLY the `success` arm is acted on, and
  # that asymmetry is deliberate: devkit's own `gate` workflow currently concludes `failure` on
  # every main commit for an unrelated fixture reason (autonomous report 62314729 / sc-1896), so a
  # "CI already failed at your base" line would fire on 100% of pushes and become a standing excuse
  # to --no-verify — the exact behaviour this whole change exists to remove. A `success` is rare,
  # informative, and points AT the pusher; it starts working by itself the day the gate goes green.
  if command -v gh >/dev/null 2>&1; then
    conclusion=$(gh api "repos/{owner}/{repo}/commits/$base/check-runs" \
      --jq '[.check_runs[] | select(.name=="gate") | .conclusion] | first' 2>/dev/null) || conclusion=
  fi

  echo "" >&2
  if [ "${conclusion:-}" = success ]; then
    echo "i CI passed at the push base - the failures above are in your change:" >&2
    echo "      base $subject" >&2
    return 0
  fi
  echo "i these failures may pre-date your push. To check, run the suite at the base:" >&2
  echo "      base $subject" >&2
  echo "     git worktree add --detach /tmp/devkit-base $base \\" >&2
  echo "       && (cd /tmp/devkit-base && bun install && bun run test:run)" >&2
  echo "   Anything that fails there too is not yours. Your push is still blocked either way -" >&2
  echo "   '--no-verify' hands whatever is broken to the next person." >&2
  return 0
}

cat > "$UPDATES_FILE"
while read -r local_ref local_oid remote_ref remote_oid; do
  [ -n "${remote_ref:-}" ] || continue
  HAS_UPDATES=1
  if [[ "$remote_ref" != refs/tags/* ]]; then
    HAS_NON_TAG_UPDATE=1
    NON_TAG_UPDATE_COUNT=$((NON_TAG_UPDATE_COUNT + 1))
    if [ -n "$SHIP_SKIP_SHA" ] && [ "$local_oid" = "$SHIP_SKIP_SHA" ]; then
      NON_TAG_MATCH_COUNT=$((NON_TAG_MATCH_COUNT + 1))
    fi
    continue
  fi
  is_zero_oid "$local_oid" && continue
  tag_commit=$(git -C "$ROOT" rev-parse --verify "${local_oid}^{commit}")
  append_tag_commit "$tag_commit"
done < "$UPDATES_FILE"

# Branch and mixed pushes retain the existing contract: validate the caller's exact worktree.
if [ "$HAS_UPDATES" -eq 0 ] || [ "$HAS_NON_TAG_UPDATE" -eq 1 ]; then
  # sc-1508: skip the heavy suite ONLY for a devkit ship of the exact commit(s) it just built — every
  # non-tag ref being pushed must be the ship sha, and there must be at least one. Anything else fails
  # closed to the full suite: a plain `git push` (SHIP_SKIP_SHA unset), a branch DELETION (local_oid is
  # all-zero, never the sha), or a piggybacked second branch (count > matches). The skip is content-keyed,
  # not "a ship is running", and CI's .github/workflows/gate.yml re-runs typecheck + test:run on the PR —
  # so the check is not dropped, only moved server-side. A skipped run is announced (never silent).
  if [ -n "$SHIP_SKIP_SHA" ] && [ "$NON_TAG_UPDATE_COUNT" -gt 0 ] \
     && [ "$NON_TAG_MATCH_COUNT" -eq "$NON_TAG_UPDATE_COUNT" ]; then
    echo "devkit pre-push: $SHIP_SKIP_SHA is a devkit ship — typecheck + test:run are gated by CI" >&2
    echo "  (.github/workflows/gate.yml) on the PR; skipping the local pre-push suite." >&2
    echo "  A plain git push still runs the full suite." >&2
    exit 0
  fi
  run_checks "$ROOT" || gate_rc=$?
  if [ "$gate_rc" -ne 0 ]; then
    # `|| true` is the safety argument: it supplies a zero status so `set -e` cannot abort here, AND
    # it suppresses errexit for the whole call, so nothing inside can short-circuit the script. The
    # verdict was captured before it ran, and signal_exit already prefers it over any signal code.
    attribute_push_failure || true
    exit "$gate_rc"
  fi
  exit 0
fi

# A tag deletion has no source tree to validate.
[ "${#TAG_COMMITS[@]}" -gt 0 ] || exit 0

for tag_commit in "${TAG_COMMITS[@]}"; do
  TAG_TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/devkit-pre-push-tag.XXXXXX")
  TAG_WORKTREE="$TAG_TEMP_ROOT/worktree"
  echo "devkit pre-push: validating tagged commit $tag_commit in an isolated worktree" >&2
  git -C "$ROOT" worktree add -q --detach "$TAG_WORKTREE" "$tag_commit"
  prepare_gate_worktree "$TAG_WORKTREE" "$ROOT" "tag validation"
  run_checks "$TAG_WORKTREE"
  cleanup_tag_worktree
done
