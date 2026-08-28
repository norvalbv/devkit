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
# ONE ACKNOWLEDGED EXCEPTION: `git worktree prune` has no per-entry form, so the dir-missing arm
# deregisters every entry whose directory is currently unreachable, including unattributable ones on
# an unmounted volume. Accepted because git runs the same prune unconditionally during `gc`, and it
# destroys no files -- only a registration git already considers dead.

# ship_reclaim_orphan_worktrees <repo> <branch>
# 0 = proceed (possibly after reclaiming), 1 = refuse. Sets PREFLIGHT_HINT when the caller's later
# resume refusal should explain where the branch came from.
ship_reclaim_orphan_worktrees() {
  local repo=$1 br=$2
  local common record status= refuse=0
  local path= wt_branch= locked= lock_reason= entry_n=0
  local paths=() branches=() locks=() lock_reasons=()

  PREFLIGHT_HINT=

  common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  [ -n "$common" ] || return 0

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
      "${paths[$i]}" "${branches[$i]}" "${locks[$i]}" "${lock_reasons[$i]}" || refuse=1
    i=$((i + 1))
  done

  [ "$refuse" -eq 0 ]
}

# _ship_orphan_consider <repo> <common> <branch> <path> <wt-branch> <locked> <lock-reason>
# 0 = this entry does not block, 1 = refuse.
_ship_orphan_consider() {
  local repo=$1 common=$2 br=$3 path=$4 wt_branch=$5 locked=$6 lock_reason=$7
  local admin= rec= r_branch= r_pid= r_identity= r_base= r_created= r_keep=
  local r_gate_pid= r_gate_identity= attached=

  [ "$wt_branch" = "refs/heads/$br" ] && attached=1

  admin=$(worktree_registry_admin_dir "$common" "$path" 2>/dev/null) || admin=
  [ -n "$admin" ] && rec="$admin/devkit-ship-run"

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
    _ship_orphan_report_live "$br" "$path" "$r_pid" "$r_identity" ship
    return 1
  fi
  if _ship_orphan_alive "$r_gate_pid" "$r_gate_identity"; then
    _ship_orphan_report_live "$br" "$path" "$r_gate_pid" "$r_gate_identity" gate
    return 1
  fi

  if [ -n "$r_keep" ]; then
    # The clobbered index IS the evidence a staged-set abort exists to preserve. Never reclaim it.
    echo "ship: a previous ship for $br kept its worktree deliberately — nothing was created." >&2
    echo "   Worktree KEPT for diagnosis: $path (branch $br)" >&2
    echo "   Inspect: git --git-dir='$admin' ls-files | head" >&2
    echo "   Then:    git worktree remove --force '$path' && git branch -D '$br'" >&2
    return 1
  fi

  _ship_orphan_reclaim "$repo" "$br" "$path" "$r_pid" "$r_identity" "$r_base" "$r_created"
  return 0
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

# _ship_orphan_report_live <branch> <path> <pid> <identity> <ship|gate>
_ship_orphan_report_live() {
  local br=$1 path=$2 pid=$3 identity=$4 role=$5 state
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
