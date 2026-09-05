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

# ship_truthy <value>
# devkit's GUARD_*/DEVKIT_* flag truthiness, in shell. Mirrors envBool/envFlag in
# gate-engine/config.mts: empty, "0", "false" or "no" (any case, surrounding whitespace ignored) is
# OFF; anything else is ON.
#
# Worth a function rather than a `[ -n "$X" ]` at each site. Every other devkit surface reads
# GUARD_X=0 as OFF, so a bare non-empty test lets an operator or CI profile that exports a flag as
# "0" — meaning disabled — silently DISABLE the gate instead. A guard that disappears when someone
# spells "off" the way the rest of the tool spells it is worse than no guard, because the run still
# looks guarded.
ship_truthy() {
  local v=${1:-}
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
    '' | 0 | false | no) return 1 ;;
    *) return 0 ;;
  esac
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

# ship_origin_ancestor_branch <repo> [head]
# The NEAREST branch on origin that <head> sits on top of, as `<oid> <name>`. Echoes nothing — and
# returns 1 — when no ref under refs/remotes/origin is an ancestor of it. `head` defaults to HEAD;
# a caller that has already PINNED the commit it is reasoning about must pass that oid, because a
# shared checkout's HEAD moves under it and the two answers would then describe different lines.
#
# Split out of ship_origin_base_candidate for sc-2357. That function answers "a branch this checkout
# could switch to and then ship against", which has a second tier: when nothing is an ancestor it
# falls through to origin's DEFAULT. That fall-through is the right answer to its question and the
# wrong answer to this one — a default branch the work does not sit on has no branch point, so a
# caller reasoning about ancestry would be handed a commit HEAD was never built on. Callers that need
# "what is this work actually built on" must be able to get NO answer, which is what this tier does.
#
# LOCAL ONLY, deliberately: no ls-remote proof. The oid is for an ancestry decision, not for printing,
# and ship's base check consults it on every --base run where the happy path must cost no network.
# Every caller that goes on to PRINT the name proves it with ship_origin_branch_exists first.
ship_origin_ancestor_branch() {
  local repo=$1 head=${2:-HEAD} ref
  # NEAREST ancestor, not the first one the scan meets. for-each-ref is lexicographic, and `main` is
  # normally an ancestor of `release` — so taking the first match would answer `main` for work cut
  # from `release` and retarget the PR at a branch it does not belong on. Distance is the number of
  # commits HEAD carries beyond the candidate; the smallest wins, and a tie keeps the
  # lexicographically first for determinism.
  local best= best_n= best_oid= n oid
  # objectname comes out of the SAME enumeration as the refname, and every check below is made
  # against that oid rather than re-reading the ref. A concurrent fetch can still move the ref, but it
  # can no longer make ancestry, distance and identity describe three different commits.
  #
  # `--merged HEAD` does the ancestry filtering inside the ONE enumeration git already runs, replacing
  # a `merge-base --is-ancestor` spawn per origin ref. That cost is why base-drift/resolve-base.mts
  # declined to port this scan, and why sc-2357 could not afford it on ship's hot path until now: a
  # repo with a thousand origin refs paid a thousand processes to learn what one for-each-ref knows.
  # rev-list then runs only over the ancestors, which is normally a handful.
  #
  # `--merged=<oid>`, attached, never `--merged <oid>`: the option's argument is documented optional,
  # so the detached spelling reads as a REF PATTERN in some parsers and silently leaves the filter on
  # live HEAD — which in a shared checkout is the wrong line, and fails open without a word. (Measured
  # identical on git 2.50.1; the attached form is unambiguous under every reading.)
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    oid=${ref%% *}
    ref=${ref#* }
    [ -n "$oid" ] && [ -n "$ref" ] || continue
    [ "$ref" != "refs/remotes/origin/HEAD" ] || continue
    n=$(git -C "$repo" rev-list --count "$oid..$head" 2>/dev/null) || continue
    [ -n "$n" ] || continue
    if [ -z "$best_n" ] || [ "$n" -lt "$best_n" ]; then
      best_n=$n
      best=${ref#refs/remotes/origin/}
      best_oid=$oid
    fi
  done < <(git -C "$repo" for-each-ref "--merged=$head" --format='%(objectname) %(refname)' refs/remotes/origin 2>/dev/null)
  [ -n "$best" ] || return 1
  # A ref name cannot contain a space, so one space separates the two fields unambiguously.
  printf '%s %s\n' "$best_oid" "$best"
}

# ship_origin_base_candidate <repo>
# A branch on origin that this checkout could switch to AND then ship against. Origin's default is the
# right answer when there is one; when there is not (a `git init` + `remote add` repo, a bare whose
# HEAD is unborn) the next best is a remote branch this HEAD is already ON TOP OF — that is what the
# work was cut from, so it is the base the PR wants anyway. Echoes nothing when neither holds, because
# the caller must then print a placeholder: naming a branch that does not exist is the failure mode
# this whole file exists to end.
ship_origin_base_candidate() {
  local repo=$1 cand= nearest= best= best_oid=
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
  nearest=$(ship_origin_ancestor_branch "$repo") || nearest=
  if [ -n "$nearest" ]; then
    best_oid=${nearest%% *}
    best=${nearest#* }
    # Pinned to the oid ancestry was decided against: existence alone would survive a force-push that
    # moved the branch off the history HEAD was shown to sit on.
    if ship_origin_branch_exists "$repo" "$best" "$best_oid"; then
      printf '%s\n' "$best"
      return 0
    fi
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

# ship_origin_head_branch [repo]
# Origin's default branch straight from the REMOTE. Preferred over the local refs/remotes/origin/HEAD
# whenever the network is already in hand: that local symref is absent in every `git init` + `git
# remote add` repo, and stale in a clone whose default branch was renamed. Echoes nothing on failure.
#
# Takes the repo like its siblings rather than reading the caller's cwd. ship_suggest_base is handed
# a repo path, so a cwd-bound `origin` here answers about a DIFFERENT repository whenever the two
# differ — recommending one checkout's default branch as another's base.
ship_origin_head_branch() {
  local repo=${1:-.} line=
  line=$(git -C "$repo" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$#\1#p') || line=
  [ -z "$line" ] || printf '%s\n' "$line"
}

# ship_base_contains_branch_point <repo> <base-ref> <base-oid> [head]
# Is the requested PR base RELATED to the work being shipped? Returns 0 to proceed and 1 to refuse,
# printing its own message either way. sc-2357.
#
# The failure this ends: ship proves only that --base is a branch on origin, then cuts the ephemeral
# gate worktree from that base's tip. A base from a DIFFERENT line therefore hands every gate a tree
# the change was never written against — ratchet ceilings from one line judging sources from another,
# clone pairs that only exist across the two — and each failure is internally consistent, so the
# natural response is to "fix" it. The reported incident cost three ship cycles and twelve clone
# allowlist entries written and reverted, none of which were about the change or about the base.
#
# The predicate is CONTAINMENT, and that choice is load-bearing twice over.
#
#   - It is not the --from-branch predicate (`merge-base --is-ancestor $BASE HEAD`). On this arm a
#     base that has advanced past the fork point is the NORMAL case — the premise of the whole
#     base-drift feature — so that predicate would refuse nearly every legitimate ship.
#   - It is not a distance or a sha inequality. base-drift-surfaced-at-read-time Rejected(b) bars a
#     count-keyed signal: in a shared parallel-agent checkout HEAD never advances as PRs merge, so a
#     count is permanently red and gets tuned out. The distance is NARRATED here and never fires.
#
# Fail-open on every "cannot tell": a shallow clone has truncated ancestry, a git error is not a
# verdict, and no origin ancestor means the check simply has no input. Fail-open on a diagnostic is
# ship_size_preflight's rule. Known blind spot: it reads refs/remotes/origin, so a narrow
# remote.origin.fetch that never mirrored the work's line leaves nothing to compare against.
#
# `head` is the commit the caller PINNED, not a fresh read. ship pins CALLER_HEAD before staging
# precisely because a shared checkout's HEAD moves under a running ship; re-reading it here would let
# this verdict describe a line the rest of the run never touched.
ship_base_contains_branch_point() {
  local repo=$1 base_ref=$2 base_oid=$3 head=${4:-HEAD}
  local nearest= cand= cand_oid= rc=0 behind= contained= extra=0 shown=

  # Truncated history answers "not an ancestor" for genuine ancestors, which would refuse every ship
  # from a depth-limited CI clone — the one place no human is present to read a remedy.
  if [ "$(git -C "$repo" rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
    return 0
  fi

  # Tier 1 only. The default-branch fall-through carries no branch point, and refusing against a
  # commit this work was never built on would print a fabricated fact — see ship_origin_ancestor_branch.
  nearest=$(ship_origin_ancestor_branch "$repo" "$head") || nearest=
  [ -n "$nearest" ] || return 0
  cand_oid=${nearest%% *}
  cand=${nearest#* }

  # No name shortcut. `cand = base_ref` looks like proof the base is right, and is not: the candidate
  # oid comes from the local tracking ref, the base oid from this run's fetch, and a force-push
  # between them leaves the two NAMES equal while the pinned base no longer contains the branch point.
  # Skipping the probe there would wave through the one case that needs it most. Every ship pays one
  # extra spawn; a base that merely advanced answers 0 immediately.
  #
  # Against the PINNED base oid, never refs/remotes/origin/<base>: that tracking ref is a local cache
  # this file's header already warns about, and it is simply absent under a narrow fetch refspec —
  # where merge-base exits 128 and a naive test would read "unrelated" for every ship in the repo.
  git -C "$repo" merge-base --is-ancestor "$cand_oid" "$base_oid" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) ;;
    *) echo "note: base relatedness could not be verified (git merge-base exited $rc); continuing." >&2
       return 0 ;;
  esac

  # Sharing NO ancestor is the strongest possible answer of "this base does not contain the branch
  # point", so it refuses like every other non-containment rather than being waved through.
  behind=$(git -C "$repo" rev-list --count "$base_oid..$cand_oid" 2>/dev/null) || behind=
  # Which branches DO carry this branch point — the fact that turns "wrong base" into "this base".
  # Capped: a release line can be mirrored across dozens of refs, and a screen of names buries the
  # one-line remedy under it.
  #
  # Enumerated by FULL refname, and shortened here rather than by `%(refname:short)`. That formatter
  # renders refs/remotes/origin/HEAD as the bare string `origin`, so a skip written against
  # "origin/HEAD" never matches and the symref is listed as a branch — and worse, consumes one of the
  # four slots a real branch needed.
  local listed=0
  while IFS= read -r contained; do
    [ -n "$contained" ] || continue
    [ "$contained" != "refs/remotes/origin/HEAD" ] || continue
    contained=origin/${contained#refs/remotes/origin/}
    if [ "$listed" -lt 4 ]; then
      shown=${shown:+$shown, }$contained
      listed=$((listed + 1))
    else
      extra=$((extra + 1))
    fi
  done < <(git -C "$repo" for-each-ref --contains "$cand_oid" --format='%(refname)' refs/remotes/origin 2>/dev/null)

  if ship_truthy "${GUARD_SHIP_BASE_OK:-}"; then
    echo "GUARD_SHIP_BASE_OK: shipping into origin/$base_ref, which does not contain this work's branch point ${cand_oid:0:9} (origin/$cand)." >&2
    echo "  The gate worktree is cut from a different line, so guard-size, guard-clone and structure results are not about your change." >&2
    return 0
  fi

  echo "branch point ${cand_oid:0:9} (origin/$cand) is not contained in origin/$base_ref" >&2
  [ -z "$behind" ] || echo "  origin/$base_ref is missing $behind commit(s) that this work is built on" >&2
  [ "$extra" -eq 0 ] || shown="$shown (+$extra more)"
  [ -z "$shown" ] || echo "  contained by: $shown" >&2
  # Proven against origin before it is offered: the copyable half of a refusal that names a branch
  # origin no longer has is the unusable remedy this file exists to end.
  #
  # Suppressed when the candidate IS the requested base — that happens only when the base moved off
  # the branch point under this checkout, where "pass --base <the base you passed>" is no remedy at
  # all. The caller has to fetch or rebase instead, which is what the line below says.
  if [ "$cand" = "$base_ref" ]; then
    echo "  origin/$base_ref moved off this work's branch point (the local ref still says ${cand_oid:0:9});" >&2
    echo "  fetch and rebase onto it, or ship against a branch that still carries the branch point." >&2
  elif ship_origin_branch_exists "$repo" "$cand" "$cand_oid"; then
    echo "  the branch this work sits on top of is '$cand' — pass --base $(ship_shell_quote "$cand")" >&2
  fi
  echo "  to target origin/$base_ref anyway: GUARD_SHIP_BASE_OK=1 — the gate worktree is then cut from" >&2
  echo "  a different line, so guard-size, guard-clone and structure results are not about your change." >&2
  return 1
}

# ship_suggest_base <owner/repo> [repo-path] [pinned-head]
# One advisory line naming a base that DOES exist on origin. Never names the base that just failed:
# repeating it is what turned a recoverable ship into a loop. Prints the honest "you must choose"
# line when neither tier can answer, rather than inventing a name.
#
# `<owner/repo>` is a GitHub slug for the message, not a path; `[repo-path]` is the checkout the
# ancestry tier reads, defaulting to the caller's cwd.
#
# ANCESTRY FIRST (sc-2357). This hint is printed to a checkout whose branch is not on origin — every
# provisioned worktree scratch branch — so it is the sentence that chooses the --base an agent then
# passes. Answering origin's DEFAULT there is how a worktree cut from a release line gets told to
# ship into main: the base is then unrelated to the work, ship's gate worktree is cut from another
# line, and the resulting size/clone/structure failures are about neither the change nor the base.
# ship_origin_ancestor_branch answers what the work is actually built on, and the two tiers say
# DIFFERENT sentences on purpose — a candidate must never be announced as the repository's default.
ship_suggest_base() {
  local repo=$1 root=${2:-.} head=${3:-} suggested= nearest= ancestor= ancestor_oid=
  # An EMPTY pin is cannot-tell, and the ancestor tier is skipped rather than re-reading live HEAD.
  # Falling back would name a branch derived from a commit this run never reasoned about — in a
  # shared checkout, a sibling's — which is the unusable remedy this whole file exists to end. The
  # default tier does not depend on HEAD, so the caller still gets a name.
  if [ -n "$head" ]; then
    nearest=$(ship_origin_ancestor_branch "$root" "$head") || nearest=
  fi
  if [ -n "$nearest" ]; then
    ancestor_oid=${nearest%% *}
    ancestor=${nearest#* }
    # Proven against origin before it is printed, pinned to the oid ancestry was decided against —
    # the same rule ship_origin_base_candidate follows, for the same reason.
    if ship_origin_branch_exists "$root" "$ancestor" "$ancestor_oid"; then
      echo "  the branch this work sits on top of is '$ancestor' — pass --base $(ship_shell_quote "$ancestor") if that is the intended target."
      return 0
    fi
  fi
  suggested=$(ship_origin_head_branch "$root") || suggested=
  if [ -n "$suggested" ]; then
    # The copyable half goes through the quoter; the prose half stays readable.
    echo "  origin's default branch is '$suggested' — pass --base $(ship_shell_quote "$suggested") if that is the intended target."
  else
    echo "  no branch on origin could be resolved as a base${repo:+ for $repo}; choose the base yourself and pass --base <branch>."
  fi
}
