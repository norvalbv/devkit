#!/usr/bin/env bash
# Sourced by ship-branch.sh + reship.sh. Ship briefs literal files only: `git diff/ls-files -- <dir>`
# recurses and would sweep in a parallel agent's edits under that directory, defeating per-file
# isolation. A deleted file is not a dir, so it still passes — deletions are valid paths.

# ship_refuse_dir_paths <root> <path>... — return 1 naming EVERY directory argument at once, so a
# brief with three directories costs one correction, not three. Paths are tested on <root> because
# every git call that consumes them runs there: from a subdirectory a cwd-relative test lets a
# root-level directory through. A symlink is a file to git, so one pointing at a directory passes.
ship_refuse_dir_paths() {
  local root=$1 p quoted= literal=
  shift
  for p in "$@"; do
    # `-L` on the path as given: `link/` resolves through the link, so it is refused like the
    # directory it names, which git cannot ship as the symlink entry either.
    [ -d "$root/$p" ] && [ ! -L "$root/$p" ] || continue
    quoted="$quoted $(printf '%q' "$p")"
    literal="$literal $(printf '%q' ":(literal)$p")"
  done
  [ -n "$quoted" ] || return 0
  # The remedy names the CHANGED set, not `git ls-files` (every tracked file, over-briefing the
  # ship). --no-renames keeps a rename's deleted side; the cd keeps untracked paths root-relative;
  # :(literal) keeps a directory named `*` or `:(exclude)*` from acting as a glob or magic (sc-2425).
  # Untracked is listed FIRST: a path another agent stages between the two reads is then caught by
  # one or the other (diff HEAD sees the staged add), never missed by both; sort -u drops the repeat.
  echo "directory path not allowed (pass individual files):$quoted" >&2
  echo "  list the changed files under them, and review the list — a shared checkout holds others' edits:" >&2
  echo "  cd \"\$(git rev-parse --show-toplevel)\" && { git ls-files -o --exclude-standard --$literal; git diff --name-only --no-renames HEAD --$literal; } | sort -u" >&2
  return 1
}
