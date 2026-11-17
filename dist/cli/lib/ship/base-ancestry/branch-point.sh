#!/usr/bin/env bash
# Branch-point and inbound-work narration for the base resolvers in origin-base.sh. Sourced by it.

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
  local nearest= fork= cand= cand_oid= rc=0 behind= contained= extra=0 shown=

  # Truncated history answers "not an ancestor" for genuine ancestors, which would refuse every ship
  # from a depth-limited CI clone — the one place no human is present to read a remedy.
  if [ "$(git -C "$repo" rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
    return 0
  fi

  # Every origin line HEAD sits on that branched at or after the fork point must be in the base. A
  # line merged in from before it is content the PR carries, so distance never picks the verdict.
  fork=$(git -C "$repo" merge-base "$base_oid" "$head" 2>/dev/null) || rc=$?
  case "$rc" in
    0 | 1) ;;
    *) echo "note: base relatedness could not be verified (git merge-base exited $rc); continuing." >&2
       return 0 ;;
  esac
  # Against the PINNED base oid, never the local tracking ref a force-push leaves stale. No fork
  # point (unrelated histories, exit 1) drops --contains, so every line HEAD sits on is checked.
  nearest=$(ship_origin_ancestor_branch "$repo" "$head" "--no-merged=$base_oid" ${fork:+"--contains=$fork"}) || nearest=
  [ -n "$nearest" ] || return 0
  cand_oid=${nearest%% *}
  cand=${nearest#* }

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
  [ "$cand" = "$base_ref" ] || echo "  to stack on origin/$base_ref instead, redo only this change on a checkout of origin/$base_ref (do not merge it in), then ship again." >&2
  echo "  to target origin/$base_ref anyway: GUARD_SHIP_BASE_OK=1 — the gate worktree is then cut from" >&2
  echo "  a different line, so guard-size, guard-clone and structure results are not about your change." >&2
  return 1
}

# ship_base_inbound_note <repo> <base-oid> <head> <path>...
# ADVISORY: commits on the briefed paths already pushed to another origin branch — a merged-in line,
# a squashed parent's stale ref, or this work's own earlier push — so the wording stays conditional.
ship_base_inbound_note() {
  local repo=$1 base_oid=$2 head=$3 p all own inbound n ref first on=
  shift 3
  local sel=()
  for p in "$@"; do sel+=(":(top,literal)$p"); done
  [ "${#sel[@]}" -gt 0 ] || return 0
  all=$(git -C "$repo" rev-list --no-merges --full-history "$head" "^$base_oid" -- "${sel[@]}" 2>/dev/null) || return 0
  [ -n "$all" ] || return 0
  own=$(git -C "$repo" rev-list --no-merges --full-history "$head" "^$base_oid" --not --remotes=origin -- "${sel[@]}" 2>/dev/null) || return 0
  inbound=$all
  [ -z "$own" ] || inbound=$(grep -vxF -f <(printf '%s\n' "$own") <<<"$all" || true)
  [ -n "$inbound" ] || return 0
  n=$(printf '%s\n' "$inbound" | wc -l | tr -d ' ')
  first=${inbound%%$'\n'*}
  while IFS= read -r ref; do
    [ "$ref" != "refs/remotes/origin/HEAD" ] || continue
    on=origin/${ref#refs/remotes/origin/}
    break
  done < <(git -C "$repo" for-each-ref --contains "$first" --format='%(refname)' refs/remotes/origin 2>/dev/null)
  echo "note: $n commit(s) on the briefed paths are already on another origin branch${on:+ (first is on $on)};" >&2
  echo "  any change of theirs the base lacks ships in this PR:" >&2
  printf '%s\n' "$inbound" | head -n 5 | git -C "$repo" log --no-walk=unsorted --stdin --format='  %h %s' >&2 2>/dev/null || true
  [ "$n" -le 5 ] || echo "  (+$((n - 5)) more)" >&2
  return 0
}
