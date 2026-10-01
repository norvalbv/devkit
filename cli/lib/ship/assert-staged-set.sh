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
# Snapshot the index the instant staging finishes: tree oid on line 1, then the staged paths
# NUL-delimited. Without -z git C-quotes any name holding a non-ASCII byte, a quote, a backslash or a
# newline, and the quoted spelling names no file — so a formatter no-op on such a path was judged
# LOST, aborting an honest ship.
ship_record_staged_state() {
  local wt=$1 state=$2 tree
  tree=$(git -C "$wt" write-tree) || return 1
  {
    printf '%s\n' "$tree"
    git -C "$wt" diff --cached --no-renames --name-only -z
  } > "$state"
}

_ship_state_tree() { head -n 1 "$1"; }
_ship_state_paths() { tail -n +2 "$1"; }
_ship_nul_count() { tr -cd '\0' | wc -c | tr -d ' '; }

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

# _ship_staged_missing_objects <worktree>
# Print "<oid>\t<path>" for every index entry whose object is absent from the object database.
#
# WHY NOT `git write-tree` (which the assertions below already run): write_index_as_tree
# short-circuits on cache_tree_fully_valid(), which verifies only that the cached TREE objects exist
# — never the blobs. ship_record_staged_state's write-tree PERSISTS that cache-tree into the index,
# so every later write-tree re-reads a cached oid and cannot see a blob that has gone missing.
# Verified: stage a file, write-tree, delete the loose blob, write-tree again -> same oid, exit 0.
#
# WHY NOT `git rev-list --objects <tree>`: with --missing=allow-any it silently OMITS the missing
# object rather than naming it, and without it rev-list aborts on the first one, so neither form can
# enumerate what is gone.
#
# Gitlinks (mode 160000) are skipped: a submodule's commit lives in the SUBMODULE's object database
# and is absent from the superproject's by design, so checking them would report a false positive on
# every repo with a submodule.
_ship_staged_missing_objects() {
  local wt=$1 pairs missing
  pairs=$(git -C "$wt" ls-files -s \
    | awk '$1 != "160000" { line = $0; sub(/^[^\t]*\t/, "", line); print $2 "\t" line }') || return 2
  [ -n "$pairs" ] || return 0
  missing=$(printf '%s\n' "$pairs" | cut -f1 | sort -u \
    | git -C "$wt" cat-file --batch-check 2>/dev/null \
    | awk '$2 == "missing" { print $1 }') || return 2
  [ -n "$missing" ] || return 0
  printf '%s\n' "$pairs" | grep -F -f <(printf '%s\n' "$missing") || true
}

# ship_assert_staged_objects_readable <worktree> <label>
# Every object the index names must be readable from the ship worktree's object database. sc-1420: a
# ship died ten minutes into the gate chain when `git diff --cached` could not read a staged object,
# and every existing invariant here passed straight through it — the tree oid was unchanged and the
# staged path set was intact, because the missing object is not something a tree comparison reads.
ship_assert_staged_objects_readable() {
  local wt=$1 label=$2 missing rc=0
  missing=$(_ship_staged_missing_objects "$wt") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "🛑 ship: could not enumerate the ship worktree's index to verify its objects ($label)." >&2
    return 1
  fi
  [ -z "$missing" ] && return 0
  {
    echo "🛑 ship: ABORTED — objects the index references are NOT in the object database ($label)."
    echo "   These are staged entries whose content git can no longer read, so any gate that reads"
    echo "   the staged diff will fail with \`fatal: unable to read <oid>\`. Nothing pushed."
    printf '%s\n' "$missing" | sed 's/^/     /'
    _ship_report_object_environment "$wt"
  } >&2
  return 1
}

# The evidence that tells the two candidate causes apart, captured at the moment of failure:
# a genuine DELETION from the shared object database, or ship and the gate chain simply looking at
# DIFFERENT object databases (ship runs in the caller's environment; gates are spawned through
# __dk_no_git_env, which strips GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES).
_ship_report_object_environment() {
  local wt=$1
  echo "   --- object-database evidence (sc-1420) ---"
  printf '   git-common-dir: %s\n' "$(git -C "$wt" rev-parse --git-common-dir 2>&1)"
  printf '   objects dir:    %s\n' "$(git -C "$wt" rev-parse --git-path objects 2>&1)"
  printf '   GIT_OBJECT_DIRECTORY=%s\n' "${GIT_OBJECT_DIRECTORY-<unset>}"
  printf '   GIT_ALTERNATE_OBJECT_DIRECTORIES=%s\n' "${GIT_ALTERNATE_OBJECT_DIRECTORIES-<unset>}"
  printf '   gc.auto=%s pruneExpire=%s worktreePruneExpire=%s\n' \
    "$(git -C "$wt" config --get gc.auto || echo '<default>')" \
    "$(git -C "$wt" config --get gc.pruneExpire || echo '<default>')" \
    "$(git -C "$wt" config --get gc.worktreePruneExpire || echo '<default>')"
  echo "   count-objects: $(git -C "$wt" count-objects -v 2>&1 | tr '\n' ' ')"
  echo "   worktrees still registered:"
  git -C "$wt" worktree list --porcelain 2>&1 | sed 's/^/     /'
}

# ship_assert_staged_unchanged <worktree> <state-file>
# Preflight, run immediately before the commit: nothing between staging and here may touch the index
# (prepare_gate_worktree and link_untracked_gate_configs write only the WORKING TREE), so this is
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
    printf '   staged now: %s path(s)\n' "$(git -C "$wt" diff --cached --name-only -z | _ship_nul_count)"
  } >&2
  return 1
}

# ship_assert_commit_scope <worktree> <base> <state-file>
# Post-commit, run BEFORE the push: the commit must still contain the work that was staged.
ship_assert_commit_scope() {
  # `lost` MUST be initialized here, not just inside the `if` below. Under `set -u` a bare `local x`
  # is UNSET in bash 4.4+ (CI, every Linux runner), so reading it on the clean path — the path every
  # honest ship takes — aborts the ship with "lost: unbound variable". macOS bash 3.2 treats it as
  # empty instead, which is why the suite is green locally and red in CI.
  local wt=$1 base=$2 state=$3 lost='' path rc briefed_n present_n del_extra_n
  local -a staged=() keep=() skip=()
  # NUL-delimited end to end (see ship_record_staged_state). `literal` keeps a glob-named path from
  # matching its neighbours.
  while IFS= read -r -d '' path; do
    staged+=("$path")
    keep+=(":(top,literal)$path")
    skip+=(":(top,exclude,literal)$path")
  done < <(_ship_state_paths "$state")
  briefed_n=${#staged[@]}

  # (1) Every path staging put in the index must still be in the commit unless a formatter restored
  # an existing base path exactly to its base state. Index clobbers leave the intended worktree
  # change behind (including force-added ignored files), so they remain distinguishable and fatal.
  # One diff settles the honest ship: if every staged path is still changed, nothing is missing.
  # Only a shortfall pays for the per-path walk that names the culprits.
  if [ "$briefed_n" -gt 0 ]; then
    present_n=$(set -o pipefail
      git -C "$wt" diff --no-renames --name-only -z "$base" HEAD -- "${keep[@]}" | _ship_nul_count) || {
      echo "🛑 ship: could not diff the ship commit against its base ($base)." >&2
      return 1
    }
    if [ "$present_n" -ne "$briefed_n" ]; then
      for path in "${staged[@]}"; do
        rc=0
        git -C "$wt" diff --quiet --no-renames "$base" HEAD -- ":(top,literal)$path" || rc=$?
        [ "$rc" -eq 1 ] && continue # still changed in the commit
        if [ "$rc" -eq 0 ]; then
          _ship_path_matches_base "$wt" "$base" "$path" || rc=$?
          if [ "$rc" -eq 0 ]; then
            printf '↳ ship: %q normalized to its base content during pre-commit; treating it as a no-op.\n' "$path" >&2
            continue
          fi
        fi
        if [ "$rc" -gt 1 ]; then
          printf '🛑 ship: could not verify the post-commit state of %q.\n' "$path" >&2
          return 1
        fi
        lost+="${lost:+$'\n'}$(printf '%q' "$path")"
      done
    fi
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
  # A pathspec of only exclusions means "everything except these", so an empty briefed set counts
  # every deletion.
  del_extra_n=$(git -C "$wt" diff --no-renames --name-only -z --diff-filter=D "$base" HEAD \
    -- ${skip[@]+"${skip[@]}"} | _ship_nul_count)
  if [ "$del_extra_n" -gt "$briefed_n" ]; then
    {
      echo "🛑 ship: ABORTED — the commit deletes $del_extra_n path(s) it was never asked to touch,"
      echo "   more than the $briefed_n path(s) actually briefed. That is the signature of a clobbered"
      echo "   index, not a ship. Nothing pushed."
    } >&2
    return 1
  fi
}

# ship_record_gate_adds <worktree> <base> <state-file> <out-file>
# Write, NUL-delimited, every path the GATE CHAIN put in the commit that the caller never briefed.
#
# WHY: the check above deliberately TOLERATES a ratchet gate staging a lowered baseline so it rides
# the same commit (see this file's header). ship-branch.sh's resume path did not, so a commit whose
# gates widened it could pass every gate, land, and then be unpublishable by the identical retry that
# is its documented recovery (sc-2089). The resume needs the same tolerance — but bounded to paths a
# gate REALLY wrote, never to a guessed list of baseline filenames, or a narrowed retry could smuggle
# an unbriefed change into a PR. This instant is the only place that still knows both sides, so it
# writes the answer down and ship pins it beside the gate receipt.
#
# Both sides are enumerated with `git diff -z` so the record is byte-comparable with the resume
# side's own enumeration and stays binary safe for unusual filenames. The briefed side is derived
# from the staged TREE on line 1 of the state file rather than its recorded path list, so the record
# compares base against exactly what was staged.
ship_record_gate_adds() {
  local wt=$1 base=$2 state=$3 out=$4 tree briefed path
  local -a exclude=()
  tree=$(_ship_state_tree "$state") || return 1
  [ -n "$tree" ] || return 1
  briefed=$(mktemp "${TMPDIR:-/tmp}/ship-briefed.XXXXXX") || return 1
  if ! git -C "$wt" diff --no-renames --name-only -z "$base" "$tree" > "$briefed"; then
    rm -f "$briefed"
    return 1
  fi
  while IFS= read -r -d '' path; do
    exclude+=(":(top,exclude,literal)$path")
  done < "$briefed"
  rm -f "$briefed"
  # `literal` is load-bearing: without it a briefed path containing a glob character would exclude
  # its NEIGHBOURS too, dropping real gate writes out of the record. A pathspec made only of negative
  # entries means "everything except these", so an empty briefed set correctly records the whole
  # changed set rather than nothing.
  git -C "$wt" diff --no-renames --name-only -z "$base" HEAD \
    -- ${exclude[@]+"${exclude[@]}"} > "$out"
}
