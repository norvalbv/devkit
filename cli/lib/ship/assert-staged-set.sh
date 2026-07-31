#!/usr/bin/env bash
# Staged-set invariants for the ephemeral ship/reship worktree — shared by ship-branch.sh (new-ship)
# and reship.sh (--pr).
#
# WHY: git EXPORTS an absolute GIT_DIR/GIT_INDEX_FILE into any hook it runs in a LINKED worktree,
# which is exactly how ship commits. Everything the gate chain spawns inherits them, so a tool that
# runs git against a DIFFERENT repository writes THAT repository's index over the ship's staged diff
# — no file on disk changes, so nothing else notices. That happened: a ship's 28 staged paths were
# replaced by a foreign 216-entry index, turning the pending commit into a ~5,976-file deletion of
# the whole repo. Only a reviewer's judgement stopped it from being pushed.
#
# devkit scrubs the git environment at every gate/judge boundary now (see __dk_no_git_env in the
# generated hook and withoutGitEnv in gate-engine/judge/judge-isolation.mts), but the gate chain runs
# arbitrary consumer tooling for minutes at a time and cannot be assumed airtight. These checks are
# the cheap invariant that turns "silently ship a whole-repo deletion" into a loud abort.
#
# The checks are deliberately EXACT, never heuristic — a ship that flaps is a ship nobody trusts:
#   · preflight   the index must be byte-identical to what staging produced (nothing has run yet)
#   · post-commit every path staging put in the index must still be in the commit or have been
#                 normalized exactly back to its base state, and unbriefed DELETIONS must not
#                 outnumber the briefed set
# The post-commit check cannot demand exact equality: the biome step reformats and re-stages briefed
# files, and the ratchet gates stage a lowered baseline so it rides the same commit (see
# gate-engine/ratchets/git-index.mts). Both may add to the commit; a formatter may also turn a
# briefed tracked path into a legitimate no-op by restoring its base content.

# ship_record_staged_state <worktree> <state-file>
# Snapshot the index the instant staging finishes: tree oid on line 1, staged paths after it.
ship_record_staged_state() {
  local wt=$1 state=$2 tree
  tree=$(git -C "$wt" write-tree) || return 1
  {
    printf '%s\n' "$tree"
    git -C "$wt" diff --cached --no-renames --name-only
  } > "$state"
}

_ship_state_tree() { head -n 1 "$1"; }
_ship_state_paths() { tail -n +2 "$1"; }

# A missing commit path is a legitimate formatter no-op only when it existed in the base and the
# post-hook worktree is clean for that path. Requiring base membership keeps a clobbered newly-added
# file from passing as a no-op; including ignored/untracked status keeps force-added files visible.
_ship_path_matches_base() {
  local wt=$1 base=$2 path=$3 status
  git -C "$wt" cat-file -e "$base:$path" 2>/dev/null || return 1
  status=$(git -C "$wt" status --porcelain=v1 --untracked-files=all --ignored=matching -- "$path") \
    || return 2
  [ -z "$status" ]
}

# ship_assert_staged_unchanged <worktree> <state-file>
# Preflight, run immediately before the commit: nothing between staging and here may touch the index
# (prepare_gate_worktree and link_untracked_gate_configs only create UNTRACKED symlinks), so this is
# an exact equality check. Catches a clobber that lands before the gate chain even starts.
ship_assert_staged_unchanged() {
  local wt=$1 state=$2 expected actual
  expected=$(_ship_state_tree "$state")
  actual=$(git -C "$wt" write-tree) || {
    echo "🛑 ship: the ship worktree's index is unreadable (\`git write-tree\` failed)." >&2
    return 1
  }
  [ "$actual" = "$expected" ] && return 0
  {
    echo "🛑 ship: ABORTED — the ship worktree's index changed between staging and the commit."
    echo "   expected tree $expected, found $actual. Nothing had run yet that is allowed to touch it,"
    echo "   so another process wrote this worktree's index (\$GIT_INDEX_FILE leak?). Nothing pushed."
    printf '   staged now: %s path(s)\n' "$(git -C "$wt" diff --cached --name-only | grep -c . || true)"
  } >&2
  return 1
}

# ship_assert_commit_scope <worktree> <base> <state-file>
# Post-commit, run BEFORE the push: the commit must still contain the work that was staged.
ship_assert_commit_scope() {
  local wt=$1 base=$2 state=$3 changed missing lost path rc briefed_n del_extra_n
  changed=$(git -C "$wt" diff --no-renames --name-only "$base" HEAD) || {
    echo "🛑 ship: could not diff the ship commit against its base ($base)." >&2
    return 1
  }

  # (1) Every path staging put in the index must still be in the commit unless a formatter restored
  # an existing base path exactly to its base state. Index clobbers leave the intended worktree
  # change behind (including force-added ignored files), so they remain distinguishable and fatal.
  missing=$(comm -23 \
    <(_ship_state_paths "$state" | sort -u) \
    <(printf '%s\n' "$changed" | sort -u))
  if [ -n "$missing" ]; then
    lost=
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      if _ship_path_matches_base "$wt" "$base" "$path"; then
        echo "↳ ship: $path normalized to its base content during pre-commit; treating it as a no-op." >&2
        continue
      else
        rc=$?
      fi
      if [ "$rc" -gt 1 ]; then
        echo "🛑 ship: could not verify the post-commit state of $path." >&2
        return 1
      fi
      lost+="${lost:+$'\n'}$path"
    done <<< "$missing"
  fi
  if [ -n "$lost" ]; then
    {
      echo "🛑 ship: ABORTED — the commit is missing work that was staged. Nothing pushed."
      echo "   The gate chain ran for minutes with this worktree's index reachable via \$GIT_INDEX_FILE;"
      echo "   something replaced it. Staged paths absent from the commit:"
      printf '%s\n' "$lost" | sed 's/^/     /'
    } >&2
    return 1
  fi

  # (2) The incident shape: a foreign index turns the commit into a bulk deletion of files the ship
  # was never asked to touch. A ratchet gate legitimately heal-deletes a baseline or two, so this
  # bounds unbriefed deletions by the briefed count rather than forbidding them.
  briefed_n=$(_ship_state_paths "$state" | grep -c . || true)
  del_extra_n=$(comm -13 \
    <(_ship_state_paths "$state" | sort -u) \
    <(git -C "$wt" diff --no-renames --name-only --diff-filter=D "$base" HEAD | sort -u) \
    | grep -c . || true)
  if [ "$del_extra_n" -gt "$briefed_n" ]; then
    {
      echo "🛑 ship: ABORTED — the commit deletes $del_extra_n path(s) it was never asked to touch,"
      echo "   more than the $briefed_n path(s) actually briefed. That is the signature of a clobbered"
      echo "   index, not a ship. Nothing pushed."
    } >&2
    return 1
  fi
}
