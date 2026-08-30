#!/usr/bin/env bash
# What can legally be a PR base here, and what to say when nothing can.
#
# Why a file of its own: three callers need the same answer at three different moments — the
# self-checkout remedy (before any network), ship's pre-push base refusal, and the post-push
# PR-create failure — and before sc-2261 each of them guessed separately. The recovery hint printed
# after a failed `gh pr create` re-proposed the very base that had just failed, which is how an agent
# following it verbatim retried into the same error.
#
# ERREXIT: every command substitution here is OR-guarded. The callers run under `set -euo pipefail`,
# where a bare `X=$(git ...)` propagates git's exit status — and `symbolic-ref` on an absent
# refs/remotes/origin/HEAD exits 128, which would kill the refusal these functions exist to print.

# ship_shell_quote <string>
# POSIX single-quoting for a value that is about to be printed INSIDE a copyable command. Wrapping in
# quotes is not enough on its own: git permits an apostrophe in a ref name (`release/o'neil`), which
# would close the quote and leave the rest unrunnable — and leaving names bare is worse still, since
# `$`, backticks and parentheses are legal too and a remote-supplied name would then execute as the
# operator. Each embedded quote becomes '\'' , the only construction that survives both.
ship_shell_quote() {
  printf "'%s'\n" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# ship_origin_default_branch <repo>
# Origin's default branch, resolved LOCALLY (no network). Echoes nothing when it cannot be known.
ship_origin_default_branch() {
  local repo=$1 target= cand
  target=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || target=
  # Two ways this symref lies, and both must be rejected before it is trusted. It can legally target
  # ANOTHER remote -- refs/remotes/upstream/main on a fork -- which is not an origin branch at all;
  # and it is LOCAL with nothing pruning it, so after origin's default is renamed or deleted it keeps
  # naming a ref that is gone. Neither is an error to report: fall through to the tiers below.
  case "$target" in
    origin/*) git -C "$repo" show-ref --verify -q "refs/remotes/$target" || target= ;;
    *) target= ;;
  esac
  if [ -z "$target" ]; then
    for cand in main master; do
      if git -C "$repo" show-ref --verify -q "refs/remotes/origin/$cand"; then target="origin/$cand"; break; fi
    done
  fi
  [ -z "$target" ] || printf '%s\n' "${target#origin/}"
}

# ship_origin_base_candidate <repo>
# A branch on origin that this checkout could switch to AND then ship against. Origin's default is the
# right answer when there is one; when there is not (a `git init` + `remote add` repo, a bare whose
# HEAD is unborn) the next best is a remote branch this HEAD is already ON TOP OF — that is what the
# work was cut from, so it is the base the PR wants anyway. Echoes nothing when neither holds, because
# the caller must then print a placeholder: naming a branch that does not exist is the failure mode
# this whole file exists to end.
ship_origin_base_candidate() {
  local repo=$1 cand= ref
  # A branch this HEAD is ON TOP OF wins over origin's nominal default, and the order is load-bearing:
  # work cut from origin/release, in a repo whose default is main, would otherwise be told to switch
  # to main and re-run unchanged — silently retargeting the PR at a branch it does not belong on.
  # Ancestry is what makes a base correct here; being the repo's default only makes it likely.
  #
  # Remote-tracking refs are a local CACHE: origin deletes a branch and `refs/remotes/origin/<it>`
  # survives until someone prunes. So every candidate is proven against origin before it is returned —
  # the only use of this value is printing a command the caller will run, and a name that is no longer
  # there is precisely the unusable remedy this file exists to stop. Ancestry is checked first because
  # it is free; the round-trip is paid only on real candidates, on a path already about to refuse.
  # NEAREST ancestor, not the first one the scan meets. for-each-ref is lexicographic, and `main` is
  # normally an ancestor of `release` — so taking the first match would answer `main` for work cut
  # from `release` and retarget the PR at a branch it does not belong on, which is the very error the
  # ordering above exists to prevent. Distance is the number of commits HEAD carries beyond the
  # candidate; the smallest wins, and a tie keeps the lexicographically first for determinism.
  local best= best_n= best_oid= n oid
  # objectname comes out of the SAME enumeration as the refname, and every check below is made
  # against that oid rather than re-reading the ref. A concurrent fetch can still move the ref, but it
  # can no longer make ancestry, distance and identity describe three different commits.
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    oid=${ref%% *}
    ref=${ref#* }
    [ -n "$oid" ] && [ -n "$ref" ] || continue
    [ "$ref" != "refs/remotes/origin/HEAD" ] || continue
    git -C "$repo" merge-base --is-ancestor "$oid" HEAD 2>/dev/null || continue
    n=$(git -C "$repo" rev-list --count "$oid..HEAD" 2>/dev/null) || continue
    [ -n "$n" ] || continue
    if [ -z "$best_n" ] || [ "$n" -lt "$best_n" ]; then
      best_n=$n
      best=${ref#refs/remotes/origin/}
      best_oid=$oid
    fi
  done < <(git -C "$repo" for-each-ref --format='%(objectname) %(refname)' refs/remotes/origin 2>/dev/null)
  # Pinned to the oid ancestry was decided against: existence alone would survive a force-push that
  # moved the branch off the history HEAD was shown to sit on.
  if [ -n "$best" ] && ship_origin_branch_exists "$repo" "$best" "$best_oid"; then
    printf '%s\n' "$best"
    return 0
  fi
  # No ancestor on origin: this work sits on nothing the remote has, so the default is the only
  # honest guess left. It is still proven to exist before it is offered.
  cand=$(ship_origin_default_branch "$repo") || cand=
  if [ -n "$cand" ] && ship_origin_branch_exists "$repo" "$cand"; then printf '%s\n' "$cand"; fi
}

# ship_origin_branch_exists <repo> <branch> [expected-oid]
# Does origin have this BRANCH right now, and — when an oid is given — is it still the commit the
# caller reasoned about? Fully qualified so a tag cannot answer for a branch. Strict about the exit
# code: ls-remote returns non-zero for "absent" (2) AND for auth/network trouble, so only 0 is proof
# of presence; anything else means "cannot say", which must read as absent, because advertising an
# unverified branch is the failure being prevented.
#
# The oid check is what makes an ancestry answer trustworthy. Ancestry is decided against the LOCAL
# remote-tracking ref, which is a cache; a force-push between that decision and this probe leaves the
# branch existing but no longer the commit HEAD was shown to sit on top of, and an existence-only
# check would then recommend an unrelated PR base.
ship_origin_branch_exists() {
  local repo=$1 br=$2 want=${3:-} line rc
  [ -n "$br" ] || return 1
  line=$(git -C "$repo" ls-remote --exit-code --heads origin "refs/heads/$br" 2>/dev/null)
  rc=$?
  [ "$rc" -eq 0 ] || return 1
  [ -n "$want" ] || return 0
  case "$line" in "$want"*) return 0 ;; *) return 1 ;; esac
}

# ship_origin_head_branch
# Origin's default branch straight from the REMOTE. Preferred over the local refs/remotes/origin/HEAD
# whenever the network is already in hand: that local symref is absent in every `git init` + `git
# remote add` repo, and stale in a clone whose default branch was renamed. Echoes nothing on failure.
ship_origin_head_branch() {
  local line=
  line=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$#\1#p') || line=
  [ -z "$line" ] || printf '%s\n' "$line"
}

# ship_suggest_base <owner/repo>
# One advisory line naming a base that DOES exist on origin. Never names the base that just failed:
# repeating it is what turned a recoverable ship into a loop. Prints the honest "you must choose"
# line when origin's default cannot be resolved, rather than inventing a name.
ship_suggest_base() {
  local repo=$1 suggested=
  suggested=$(ship_origin_head_branch) || suggested=
  if [ -n "$suggested" ]; then
    # The copyable half goes through the quoter; the prose half stays readable.
    echo "  origin's default branch is '$suggested' — pass --base $(ship_shell_quote "$suggested") if that is the intended target."
  else
    echo "  origin's default branch could not be resolved${repo:+ for $repo}; choose the base yourself and pass --base <branch>."
  fi
}
