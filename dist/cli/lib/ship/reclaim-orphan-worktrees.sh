#!/usr/bin/env bash
# The preflight that answers "somebody already has this branch checked out -- who, and are they still
# alive?" before ship decides anything about the branch. Sourced by ship-branch.sh.
#
# Reclaims a ship worktree/branch ONLY when the previous run's own record proves it was abandoned.
# Everything else refuses or reports and falls through to the behaviour ship already had.
#
# THE INVARIANT: no record, no destructive action. Every removal below is authorised by a file devkit
# itself wrote naming the pid that owned the worktree. A worktree devkit cannot attribute -- a human's
# checkout, an orphan from before this shipped, a record a consumer gate deleted -- gets one advisory
# line and is never touched. That is what makes reclamation safe to do without asking.
#
# ITS BOUND (sc-2273): a record authorises removing an ARTIFACT, never the worktree this preflight is
# EXECUTING IN. git will happily remove the caller's own cwd, taking any staged work with it and
# wedging every later `git -C "$PWD"`, so that one entry refuses and says where to re-run from. The
# same tree is reclaimed as normal from any other cwd. The advisory arms carry the weaker form of the
# same rule: they may still PRINT a removal the operator runs (devkit is not the one running it), but
# must say it cannot be run from where they are standing.
#
# ONE ACKNOWLEDGED EXCEPTION: `git worktree prune` has no per-entry form, so the dir-missing arm
# deregisters every entry whose directory is currently unreachable, including unattributable ones on
# an unmounted volume. Accepted because git runs the same prune unconditionally during `gc`, and it
# destroys no files -- only a registration git already considers dead.

# Sourced, not assumed: ship-run-record.test.mts sources THIS file directly, so its dependency has to
# travel with it rather than relying on ship-branch.sh having sourced it first.
. "$(dirname "${BASH_SOURCE[0]}")/origin-base.sh"

# ship_reclaim_orphan_worktrees <repo> <branch> [ship|reship]
# 0 = proceed (possibly after reclaiming), 1 = refuse. Sets PREFLIGHT_HINT when the caller's later
# resume refusal should explain where the branch came from, and PREFLIGHT_SELF when the blocker is
# the caller's own worktree -- which changes what that refusal's closing advice may say.
#
# The mode exists for one question only: does the CALLER create the branch? A new ship does, so a
# branch already checked out here is fatal and gets a remedy. A re-push commits in a --detach
# worktree and never touches refs/heads/<br>, so the same state is entirely benign there -- and
# telling it to delete the branch it is re-pushing would be wrong twice over.
ship_reclaim_orphan_worktrees() {
  local repo=$1 br=$2 mode=${3:-ship}
  local common record status= refuse=0
  local path= wt_branch= locked= lock_reason= entry_n=0
  local paths=() branches=() locks=() lock_reasons=()
  local self_admin= self_top=

  PREFLIGHT_HINT=
  PREFLIGHT_SELF=

  common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  [ -n "$common" ] || return 0

  # The caller's own identity is loop-INVARIANT, so resolve it once here rather than shelling out per
  # entry -- and per entry it was resolved twice, since the unattributable arm asks the question in
  # both of its branches. Both values may legitimately come back empty (a repo layout git cannot
  # answer for); _ship_orphan_is_self then answers "not self" for every entry, which is the polarity
  # that leaves ship behaving exactly as it did before any self-check existed.
  self_admin=$(git -C "$repo" rev-parse --absolute-git-dir 2>/dev/null) || self_admin=
  self_top=$(git -C "$repo" rev-parse --path-format=absolute --show-toplevel 2>/dev/null) || self_top=

  # Collect first, act second. Acting while the stream is still open would mean acting on a list that
  # may yet turn out to be truncated.
  while IFS= read -r -d '' record; do
    case "$record" in
      'devkit-worktree-list-status '*) status=${record#devkit-worktree-list-status } ;;
      'worktree '*) path=${record#worktree } ;;
      'branch '*) wt_branch=${record#branch } ;;
      'locked') locked=1 ;;
      'locked '*) locked=1; lock_reason=${record#locked } ;;
      '')
        if [ -n "$path" ]; then
          paths[entry_n]=$path
          branches[entry_n]=$wt_branch
          locks[entry_n]=$locked
          lock_reasons[entry_n]=$lock_reason
          entry_n=$((entry_n + 1))
        fi
        path=; wt_branch=; locked=; lock_reason=
        ;;
    esac
  done < <(worktree_registry_stream "$repo")

  # A partial list is NOT an empty list. Take no destructive action and leave ship exactly as it
  # behaved before this preflight existed -- a truncated read must never license deleting a branch.
  [ "$status" = 0 ] || return 0

  local i=0
  while [ "$i" -lt "$entry_n" ]; do
    _ship_orphan_consider "$repo" "$common" "$br" \
      "${paths[$i]}" "${branches[$i]}" "${locks[$i]}" "${lock_reasons[$i]}" "$mode" \
      "$self_admin" "$self_top" || refuse=1
    i=$((i + 1))
  done

  [ "$refuse" -eq 0 ]
}

# _ship_orphan_consider <repo> <common> <branch> <path> <wt-branch> <locked> <lock-reason> [mode]
#                       [self-admin] [self-top]
# 0 = this entry does not block, 1 = refuse.
_ship_orphan_consider() {
  local repo=$1 common=$2 br=$3 path=$4 wt_branch=$5 locked=$6 lock_reason=$7 mode=${8:-ship}
  local self_admin=${9:-} self_top=${10:-}
  local admin= rec= r_branch= r_pid= r_identity= r_base= r_created= r_keep=
  local r_gate_pid= r_gate_identity= attached= is_self=

  [ "$wt_branch" = "refs/heads/$br" ] && attached=1

  admin=$(worktree_registry_admin_dir "$common" "$path" 2>/dev/null) || admin=
  [ -n "$admin" ] && rec="$admin/devkit-ship-run"

  # Asked once, consumed by four arms below. Every one of them has a different correct answer for
  # "the blocker is the tree you are standing in", so this is a fact each arm reads, never a shared
  # remedy (sc-2273).
  _ship_orphan_is_self "$admin" "$path" "$common" "$self_admin" "$self_top" && is_self=1

  if [ -n "$rec" ] && [ -f "$rec" ]; then
    r_branch=$(ship_run_record_get "$rec" branch)
    r_pid=$(ship_run_record_get "$rec" pid)
    r_identity=$(ship_run_record_get "$rec" identity)
    r_base=$(ship_run_record_get "$rec" base)
    r_created=$(ship_run_record_get "$rec" branch_created)
    r_keep=$(ship_run_record_get "$rec" keep)
    r_gate_pid=$(ship_run_record_get "$rec" gate_pid)
    r_gate_identity=$(ship_run_record_get "$rec" gate_identity)
  fi

  # A record naming this branch is a candidate even when the worktree is DETACHED -- which is how the
  # resume path checks out, and the only way to recognise those.
  if [ -z "$attached" ] && [ "$r_branch" != "$br" ]; then
    return 0
  fi

  if [ -n "$locked" ]; then
    echo "ship: $br is checked out at $path, and that worktree is locked${lock_reason:+ ($lock_reason)}" >&2
    echo "  devkit will not touch a locked worktree — unlock it, or choose a new branch name." >&2
    PREFLIGHT_HINT="a locked worktree at $path still holds this branch"
    return 0
  fi

  if [ -z "$r_pid" ]; then
    # Rule 10: unattributable. Say what is in the way, then behave exactly as before.
    if [ "$mode" != ship ] && [ -n "$is_self" ]; then
      # A re-push cuts a DETACHED worktree at origin/<br> and never writes refs/heads/<br>, so this
      # checkout holding the branch obstructs nothing. Saying anything here would be noise at best
      # and, since the only remedy on offer is "delete it", actively wrong.
      return 0
    fi
    if [ -n "$is_self" ]; then
      # sc-2261: the blocker is the CALLER'S OWN worktree -- the state an agent lands in after being
      # told to `git switch -c <branch>` and then to ship that same branch. The generic advice below
      # would tell it to force-remove the worktree it is executing inside, and the main-tree arm's
      # "switch it off" is true but unactionable without naming what to switch TO. Print the exact
      # commands that free the branch instead, and set the self flag so ship's closing advice
      # (ship-branch.sh) says the same thing rather than "choose a new branch name".
      echo "ship: $br is checked out in THIS worktree ($path), and ship must create it." >&2
      echo "  ship commits on a branch it creates, so the branch cannot already be checked out here." >&2
      _ship_orphan_report_self "$repo" "$br"
      PREFLIGHT_SELF=1
      PREFLIGHT_HINT="this worktree ($path) is itself checked out on $br"
      return 0
    fi
    echo "ship: $br is also checked out at $path" >&2
    echo "  no devkit run record there, so devkit will not remove it — a ship may still own it." >&2
    if [ -z "$admin" ]; then
      # No admin dir means this is the repo's MAIN working tree, which git refuses to `worktree
      # remove` at all -- so the linked-worktree remedy would only produce a second error. This is
      # the ordinary case on a shared checkout that happens to sit on the branch being shipped.
      echo "  it is this repo's main working tree — switch it off $br, or ship under another name." >&2
    else
      echo "  if none is running: git worktree remove --force '$path' && git branch -D '$br'" >&2
    fi
    PREFLIGHT_HINT="another checkout at $path still holds this branch"
    return 0
  fi

  # Report whichever probe actually answered. sc-2159's own shape is "the shell died but its detached
  # gate tree kept running", so naming $r_pid unconditionally would tell the operator to kill a pid
  # that is already gone -- a no-op that then makes the force-remove advice below look like the only
  # way forward, against a worktree live reviewers are still cwd'd into.
  if _ship_orphan_alive "$r_pid" "$r_identity"; then
    _ship_orphan_report_live "$br" "$path" "$r_pid" "$r_identity" ship "$is_self"
    return 1
  fi
  if _ship_orphan_alive "$r_gate_pid" "$r_gate_identity"; then
    _ship_orphan_report_live "$br" "$path" "$r_gate_pid" "$r_gate_identity" gate "$is_self"
    return 1
  fi

  if [ -n "$r_keep" ]; then
    # The clobbered index IS the evidence a staged-set abort exists to preserve. Never reclaim it.
    echo "ship: a previous ship for $br kept its worktree deliberately — nothing was created." >&2
    echo "   Worktree KEPT for diagnosis: $path (branch $br)" >&2
    echo "   Inspect: git --git-dir='$admin' ls-files | head" >&2
    echo "   Then:    git worktree remove --force '$path' && git branch -D '$br'" >&2
    # sc-2273: the removal line stays even when it names the caller's own tree. It is the ONLY
    # cleanup a kept worktree ever gets -- withholding it would trade one run's bad advice for a
    # permanent orphan -- and unlike the reclaim arm devkit is not the one running it. What was
    # missing is that it cannot be run from where the operator is standing, which is precisely the
    # place the "Inspect:" line above invites them to.
    [ -z "$is_self" ] || echo "   (you are standing in it — run that from another checkout, not here)" >&2
    return 1
  fi

  if [ -n "$is_self" ]; then
    # sc-2273: the record proves the owner is gone, so everything below WOULD be authorised -- and
    # reclamation begins by force-removing $path, which here is the directory this shell is executing
    # inside. git carries that out (there is no self-guard), so the tree and every staged file in it
    # are destroyed, and every later `git -C "$PWD"` then fails with "Unable to read current working
    # directory" -- surfacing downstream as a push refusal blaming ls-remote for a directory devkit
    # itself deleted. The caller reaches this state by accepting ship's own invitation to go inspect a
    # worktree it kept, so it is a state ship advertises. Refuse instead: the record's authority
    # extends to the artifact, never to the tree the preflight is standing in.
    # No PREFLIGHT_HINT: that channel feeds the resume refusal downstream, which only runs when the
    # preflight returns 0. Refusing here exits at ship-branch.sh's `|| exit 1`, so a hint set on this
    # path would never be read -- the same reason the live and keep arms above set none.
    _ship_orphan_report_reclaim_self "$br" "$path" "$r_pid" "$r_identity" "$common"
    return 1
  fi

  _ship_orphan_reclaim "$repo" "$br" "$path" "$r_pid" "$r_identity" "$r_base" "$r_created"
  return 0
}

# _ship_orphan_report_reclaim_self <branch> <path> <pid> <identity> <common>
# "The worktree devkit would reclaim is the one you are standing in."
#
# Deliberately NOT _ship_orphan_report_self, and deliberately does not set PREFLIGHT_SELF. That
# remedy frees a NAME by renaming the branch; the blocker here is a DIRECTORY, and the branch may not
# even be checked out -- a resume worktree is --detach, so it is matched by its record rather than by
# attachment, and "this moves this worktree with it" would describe something that is not happening.
# Setting the self flag would additionally make ship-branch.sh re-print that rename as the LAST line
# read, sending an agent to re-run from the same doomed directory and land on this identical refusal.
# The only escape is to leave, so name where to go.
_ship_orphan_report_reclaim_self() {
  local br=$1 path=$2 pid=$3 identity=$4 common=$5 main=
  # <common> is the main worktree's .git directory; its parent is that checkout. A repo whose common
  # dir does not end in /.git is bare or otherwise unusual, and a guessed path is worse than none --
  # so only the suffix form yields a suggestion.
  case "$common" in */.git) main=${common%/.git} ;; esac
  echo "ship: $br is held by a worktree a killed ship left behind (pid $pid${identity:+, started $identity})," >&2
  echo "  and that worktree is THIS one ($path) — devkit will not reclaim the tree it is running in." >&2
  echo "  reclaiming force-removes it, which would discard everything uncommitted here." >&2
  if [ -n "$main" ]; then
    echo "  re-run from the main checkout and devkit will clean this up for you: cd $(ship_shell_quote "$main")" >&2
  else
    echo "  re-run from any checkout of this repo other than this one, and devkit will clean it up." >&2
  fi
}

# _ship_orphan_is_self <admin> <path> <common> <self-admin> <self-top>
# Is the blocking worktree the one ship was invoked FROM? Compared by git ADMIN DIR:
# `rev-parse --absolute-git-dir` returns <common>/worktrees/<id> for a linked worktree and <common>
# for the main one -- exactly what worktree_registry_admin_dir yields, which is empty for the main
# tree. Both are git-canonical and realpath-resolved, so this sidesteps the /private/var symlink
# forms that made path-keying unusable in this file (see the header's Rejected note).
#
# The empty-admin arm needs the extra path check, because empty means TWO things: "the main worktree,
# which has no admin dir" and "resolution failed" -- the registry cannot key a worktree whose path
# holds a newline, since the gitdir file it matches on is read a line at a time. Without the check, a
# caller sitting in the main tree satisfies self == common and would claim an unresolvable OTHER
# checkout as its own, then advise renaming that checkout's branch. So identify the main worktree
# positively instead of inferring it from an absence.
#
# Pure comparison: the caller's two values are resolved once per preflight, not once per entry (they
# cannot change while the loop runs). An empty <self-admin> means git could not answer for the
# caller, and every entry then reads as NOT self -- the polarity that keeps the pre-self-check
# behaviour rather than claiming someone else's tree on a failed probe.
_ship_orphan_is_self() {
  local admin=$1 path=$2 common=$3 self_admin=$4 self_top=$5
  [ -n "$self_admin" ] || return 1
  if [ -n "$admin" ]; then
    [ "$self_admin" = "$admin" ]
  else
    [ "$self_admin" = "$common" ] || return 1
    [ -n "$self_top" ] && [ "$self_top" = "$path" ]
  fi
}

# _ship_orphan_report_self <repo> <branch>
# The remedy for "you are standing on the branch you asked ship to create".
#
# It RENAMES, and it is the only shape offered. Every delete-shaped remedy has the same defect:
# whether the branch is safe to remove is decided here and acted on seconds later, so any answer can
# be stale by then -- `git branch -D` forces past a commit that landed in between, `git branch -d`
# asks the wrong question (merged into HEAD, false once you move to an older base), and even a
# compare-and-delete on the tip drops the last ref if the covering ref is pruned in the window. A
# rename cannot lose a commit under ANY interleaving, and freeing the NAME is all ship needs. The
# leftover is one branch to drop once the PR is open -- far cheaper than an unreachable commit.
#
# And it never moves the working tree. An earlier draft led with `git switch <base>` so the ship
# command could stay unchanged, but this worktree holds the uncommitted work being shipped: a switch
# can legitimately refuse when those edits collide with the base, handing back a command that fails.
# `git branch -m` carries the worktree onto the new name without touching a file, so it works in
# every state. The cost is that HEAD then sits on a branch origin does not have, which is exactly
# what --base is for -- and naming the PR target explicitly is no loss on the one path where an
# inferred base was the original bug.
_ship_orphan_report_self() {
  local repo=$1 br=$2 base freed tip
  # The destination name is chosen by the OPERATOR'S shell, at the moment the command runs, not here.
  # Picking one now means probing for a free name and then handing over a command that runs seconds
  # later -- a check-then-act whose only outcome on a lost race is a rename that refuses and a caller
  # back where they started. `$$` is expanded on execution and is unique among live processes; the
  # tip disambiguates a reused pid from an older run. Both parts are ours (hex and a shell builtin),
  # so this half is deliberately left OUTSIDE the quoting the source branch gets.
  tip=$(git -C "$repo" rev-parse --short --verify --quiet "refs/heads/$br") || tip=
  freed="devkit-freed-${tip:-nohead}-\$\$"
  base=$(ship_origin_base_candidate "$repo") || base=
  # Every ref name in a copyable line goes through ship_shell_quote. These are meant to be pasted
  # into a shell, and a branch name is not a safe literal in either direction: `$`, backticks and
  # parentheses are legal, so a bare name could execute as the operator, and an apostrophe is legal
  # too, so a naive wrapper would emit an unmatched quote and an unrunnable command.
  echo "  free the name by renaming it — this moves this worktree with it, and touches no file:" >&2
  echo "    git branch -m $(ship_shell_quote "$br") \"$freed\"" >&2
  echo "  then re-run ship, naming the PR base (HEAD is then on a branch origin does not have):" >&2
  echo "    devkit ship $(ship_shell_quote "$br") \"<title>\" --base $(ship_shell_quote "${base:-<branch-on-origin>}") -- <paths>" >&2
  echo "  (renaming keeps every commit; drop the renamed branch once the PR is open)" >&2
}

# _ship_orphan_alive <pid> <recorded-identity>
# An empty recorded identity (a `ps` without -o support) degrades to presence only, which fails
# toward ALIVE -- a recycled pid then reads as live and we refuse instead of reclaiming. That is the
# correct polarity: refusing costs a message, reclaiming wrongly costs a running ship's worktree.
_ship_orphan_alive() {
  local pid=$1 recorded=$2 current
  [ -n "$pid" ] || return 1
  ship_run_pid_present "$pid" || return 1
  [ -n "$recorded" ] || return 0
  current=$(ship_run_identity "$pid")
  [ "$current" = "$recorded" ]
}

# _ship_orphan_report_live <branch> <path> <pid> <identity> <ship|gate> [is-self]
_ship_orphan_report_live() {
  local br=$1 path=$2 pid=$3 identity=$4 role=$5 is_self=${6:-} state
  state=$(ship_run_process_state "$pid")
  echo "ship: another ship for $br is still running — nothing was created." >&2
  if [ "$role" = gate ]; then
    # Naming the role matters: the ship shell is already gone, so `ps` will not show a ship command
    # for this pid and the operator would otherwise conclude the record is stale.
    echo "  its shell is gone, but its gate tree is still running — reviewers still hold that worktree." >&2
  fi
  echo "  run: pid $pid${identity:+, started $identity}, worktree $path" >&2
  case "$state" in
    T*)
      # A background process group that reads the terminal is suspended, not failed. It presents as a
      # hang with no output, which is unguessable without being told.
      echo "  it is STOPPED (state T) — a backgrounded ship that tries to read the terminal is suspended by SIGTTIN." >&2
      echo "  resume it with: kill -CONT $pid    (or stop it for good: kill -TERM $pid)" >&2
      ;;
    *) echo "  wait for it to finish, or stop it: kill -TERM $pid" >&2 ;;
  esac
  [ -d "$path" ] || echo "  its worktree directory no longer exists, so it cannot finish — stop it: kill -TERM $pid" >&2
  # Deliberately conditional on the process being gone FIRST. Removing a worktree that live reviewers
  # have as their cwd corrupts the run still using it (sc-1538), so this must never read as the
  # alternative to waiting.
  echo "  only once nothing is running there: git worktree remove --force '$path' && git branch -D '$br'" >&2
  # sc-2273: ADD to this line, never replace it. The command above is already gated on the process
  # being gone, which is the hazard that matters here; substituting the rename remedy would tell the
  # operator to move refs/heads/<br> out from under a ship that still holds it checked out and will
  # push -u it -- a worse outcome than the one being corrected. The only missing fact is positional.
  [ -z "$is_self" ] || echo "  you are standing in that worktree — cd out before running it." >&2
}

# _ship_orphan_reclaim <repo> <branch> <path> <pid> <identity> <recorded-base> <branch-created>
# The owner is provably gone and left nothing to preserve.
_ship_orphan_reclaim() {
  local repo=$1 br=$2 path=$3 pid=$4 identity=$5 base=$6 created=$7 tip

  # Worktree first: a branch checked out in a linked worktree cannot be deleted. `remove` refuses an
  # entry whose directory is already gone, so that case takes `prune` -- the only supported verb for
  # it, and one whose blast radius is by definition entries that are already dead.
  if [ -d "$path" ]; then
    git -C "$repo" worktree remove --force "$path" >/dev/null 2>&1 || true
    if [ -d "$path" ]; then
      # Removal failed (a permission problem, a busy mount). Announcing success and then deleting the
      # branch would strand a still-registered worktree pointing at a ref that no longer exists —
      # worse than the orphan we started with. `update-ref -d` has no checked-out guard of its own.
      echo "ship: could not reclaim the worktree of a killed ship at $path — left as is." >&2
      PREFLIGHT_HINT="a worktree from a killed ship (pid $pid) still holds this branch at $path"
      return 0
    fi
  else
    # `prune` is GLOBAL, so it is reserved for the one case `remove` cannot serve: an entry whose
    # directory is already gone, which `remove` rejects outright. Everything it can additionally
    # deregister is by definition an entry with no directory left, but keeping it off the ordinary
    # path means a normal reclaim touches nothing but its own target.
    git -C "$repo" worktree prune >/dev/null 2>&1 || true
  fi
  echo "ship: reclaimed the worktree of a ship that was killed (pid $pid${identity:+, started $identity}): $path" >&2

  tip=$(git -C "$repo" rev-parse -q --verify "refs/heads/$br" 2>/dev/null) || tip=
  [ -n "$tip" ] || return 0

  if [ "$tip" = "$base" ] && [ "$created" = "1" ]; then
    # Compare-and-delete in one ref transaction: a `branch -D` after a separate read could erase an
    # update that landed in between, and only the run that CREATED this branch may delete it.
    if git -C "$repo" update-ref -d "refs/heads/$br" "$base" 2>/dev/null; then
      echo "ship: its branch $br held no commit — deleted." >&2
    else
      echo "ship: $br moved while being reclaimed — left alone." >&2
      PREFLIGHT_HINT="a killed ship (pid $pid) created this branch; its worktree was reclaimed"
    fi
    return 0
  fi

  # A commit landed, or the branch was somebody else's to begin with. The resume block downstream
  # verifies receipt, base, message and tree, and refuses with its own specific reason if it cannot.
  echo "ship: its commit ${tip:0:7} is still on $br — checking whether this run can resume it." >&2
  PREFLIGHT_HINT="this branch is what a killed ship left behind (pid $pid); its worktree was reclaimed, but its commit was never published"
  return 0
}
