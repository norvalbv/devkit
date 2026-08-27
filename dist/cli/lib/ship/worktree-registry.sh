#!/usr/bin/env bash
# A read-only view of `git worktree list`, shared by ship-branch.sh, reship.sh and
# review/worktrees.sh.
#
# WHY a shared file: four sites parsed this table with three different idioms, and only one of them
# got the failure mode right. `git worktree list` can fail mid-stream (a torn .git/worktrees entry, a
# concurrent prune). An `awk '/^worktree /'` pipeline swallows that: a truncated read is
# indistinguishable from "no worktrees registered". For ship's orphan preflight that difference
# decides whether a branch gets deleted, so the reader MUST be able to tell the two apart.
#
# The stream therefore carries git's own exit status as its final record. A consumer that does not
# see `devkit-worktree-list-status 0` must treat the whole answer as unknown and refuse, never as
# empty. `-z` keeps paths intact through newlines; hooksPath is disabled because listing must not run
# consumer hooks.

# worktree_registry_stream <repo>
# NUL-delimited porcelain records, then `devkit-worktree-list-status <n>\0`.
worktree_registry_stream() {
  local status
  if git -c core.hooksPath=/dev/null -C "$1" worktree list --porcelain -z; then
    status=0
  else
    status=$?
  fi
  printf 'devkit-worktree-list-status %s\0' "$status"
}

# worktree_registry_admin_dir <git-common-dir> <worktree-path>
# The linked worktree's ADMIN dir (<common>/worktrees/<id>), or non-zero if it has none (the main
# worktree, or an entry already pruned).
#
# Resolution is by content, not by name: the <id> segment is git's own de-duplicated basename and
# need not match the path. Each candidate's `gitdir` file names the worktree it serves, and git
# stores that path realpath-resolved -- byte-identical to what `worktree list` prints for the same
# entry (verified on macOS, where TMPDIR is a /private/var symlink). So compare against the PORCELAIN
# path, never against a caller-built $TMPDIR path, which will not match.
#
# This works even when the worktree DIRECTORY is gone: the admin dir outlives it until `prune`. That
# is what lets the caller still attribute a worktree whose files a reboot reaped.
worktree_registry_admin_dir() {
  local common=$1 path=$2 gitdir served
  for gitdir in "$common"/worktrees/*/gitdir; do
    [ -f "$gitdir" ] || continue
    IFS= read -r served < "$gitdir" || continue
    [ "${served%/.git}" = "$path" ] || continue
    printf '%s\n' "${gitdir%/gitdir}"
    return 0
  done
  return 1
}
