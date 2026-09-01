#!/usr/bin/env bash
# WHERE ship's explicit-paths staging patch is anchored, and which briefed paths cannot survive a
# three-way merge. Sourced by ship-branch.sh.
#
# `--base <b>` re-resolves BASE to origin's CURRENT tip, but the caller's working tree was cut at an
# older ancestor. A BASE-anchored `git diff <BASE> -- <paths>` therefore reports every byte the base
# added inside those paths as a DELETION, and staging it produces a commit that is a descendant of
# the new base carrying an explicit revert — which GitHub merges without a conflict, because from
# git's point of view the branch genuinely asked for the deletion. Nothing anywhere objects (sc-2451).
#
# Anchoring the patch at the FORK POINT and re-merging is the only framing under which base-only work
# survives. docs/decisions/base-drift-surfaced-at-read-time rejected a ship-time block on the grounds
# that "git merges these three-way, so a same-region overwrite already surfaces as a conflict at
# merge" — ship re-cutting caller content onto the refreshed base is exactly what destroys that
# guarantee, so restoring three-way at APPLY time makes that record's premise true rather than
# contradicting it.

# ship_patch_base <root> <base>
# The commit this checkout forked from, or the base itself when that cannot be improved on.
#
# Echoing BASE unchanged is the load-bearing default, not a fallback nobody hits: the ship default arm
# sets BASE=$(git rev-parse HEAD), so the merge base IS BASE and the entire mechanism below stays
# switched off, byte-for-byte. An unrelated-histories or shallow-graft failure lands in the same place.
ship_patch_base() {
  local root=$1 base=$2 fork
  fork=$(git -C "$root" merge-base "$base" HEAD 2>/dev/null) || fork=
  printf '%s\n' "${fork:-$base}"
}

# _ship_whole_add <path>
# Append to WHOLE_POSITIVES unless already present. Linear scan on purpose: the briefed set is
# caller-typed and small, and an associative array would need bash 4 (macOS ships 3.2).
_ship_whole_add() {
  local seen
  for seen in ${WHOLE_POSITIVES[@]+"${WHOLE_POSITIVES[@]}"}; do
    [ "$seen" = "$1" ] && return 0
  done
  WHOLE_POSITIVES+=("$1")
}

# _ship_classify_modes <root> <anchor> <pathspec...>
# Symlink (120000) and gitlink (160000) entries at EITHER endpoint.
#
# `--raw -z` frames each entry as TWO NUL records — the ":<srcmode> <dstmode> <srcsha> <dstsha>
# <status>" meta line, then the path — so the loop consumes a PAIR per iteration. `--no-renames` is
# not cosmetic here: with rename detection on, an R record carries a THIRD record (src then dst) and
# the pairing desynchronises for every entry after it.
#
# --raw is the only source for this, because a retargeted symlink reports to --numstat as a perfectly
# ordinary "1<TAB>1" text edit. A numstat-only classifier would route it into the three-way arm and
# abort on it.
_ship_classify_modes() {
  local root=$1 anchor=$2 raw meta path src rest dst
  shift 2
  raw=$(mktemp "${TMPDIR:-/tmp}/ship-classify-raw.XXXXXX") || return 1
  git -C "$root" diff --raw -z --no-renames "$anchor" -- "$@" > "$raw" || { rm -f "$raw"; return 1; }
  while IFS= read -r -d '' meta; do
    IFS= read -r -d '' path || break
    meta=${meta#:}
    src=${meta%% *}
    rest=${meta#* }
    dst=${rest%% *}
    case "$src $dst" in
      *120000* | *160000*) _ship_whole_add "$path" ;;
    esac
  done < "$raw"
  rm -f "$raw"
}

# _ship_classify_binary <root> <anchor> <pathspec...>
# Blobs git cannot diff as text at either endpoint. `--numstat -z` frames each entry as ONE NUL
# record, "<added><TAB><deleted><TAB><path>", and reports "-<TAB>-" exactly when the content is
# binary — which is precisely the set `git apply --3way` has no way to merge.
_ship_classify_binary() {
  local root=$1 anchor=$2 num record path
  shift 2
  num=$(mktemp "${TMPDIR:-/tmp}/ship-classify-num.XXXXXX") || return 1
  git -C "$root" diff --numstat -z --no-renames "$anchor" -- "$@" > "$num" || { rm -f "$num"; return 1; }
  while IFS= read -r -d '' record; do
    case $record in
      '-'$'\t''-'$'\t'*)
        path=${record#*$'\t'}
        path=${path#*$'\t'}
        _ship_whole_add "$path"
        ;;
    esac
  done < "$num"
  rm -f "$num"
}

# ship_classify_whole_file <root> <base> <patch-base> -- <pathspec...>
# Populate three parallel views of the paths that must keep today's BASE-anchored whole-file staging:
#   WHOLE_POSITIVES  raw names, for operator-facing messages
#   WHOLE_SELECTORS  :(top,literal) pathspecs, for the whole-file `git diff`
#   WHOLE_EXCLUDES   :(top,literal,exclude) pathspecs, subtracted from the three-way arm
#
# WHY these paths are carved out: `git apply --3way` conflicts UNCONDITIONALLY on a binary, symlink or
# gitlink whose base copy also moved — there is no textual merge to attempt — so routing them through
# it would turn ships that work today into hard aborts. That is the "fires on every legitimate
# concurrent edit of a shared file" failure base-drift-surfaced-at-read-time refuses, and it would buy
# nothing: whole-file replacement has no partial-revert hazard, because there is no surviving base
# region to lose. The residual cost is narrow and booked honestly: when BOTH sides changed such a
# path there is no merge to attempt, so the caller's copy wins and ship_warn_whole_file_drift says so.
# A path only the BASE changed is left alone entirely — see ship_stage_whole_file.
#
# Classified from the UNION of BOTH anchorings rather than one. A path can be binary at BASE and text
# at PATCH_BASE (the base converted it to binary) or the reverse. The first false-aborts in the
# three-way arm because the INDEX side is binary; the second because the generated PATCH is binary.
# The union is the only set for which the text patch is a real text patch on the generation side AND
# the merge side, and it strictly contains today's binary set, so the whole-file arm never shrinks.
ship_classify_whole_file() {
  local root=$1 base=$2 patch_base=$3 path
  shift 3
  [ "${1:-}" = "--" ] && shift
  WHOLE_POSITIVES=()
  WHOLE_SELECTORS=()
  WHOLE_EXCLUDES=()
  _ship_classify_modes "$root" "$base" "$@" || return 1
  _ship_classify_binary "$root" "$base" "$@" || return 1
  if [ "$patch_base" != "$base" ]; then
    _ship_classify_modes "$root" "$patch_base" "$@" || return 1
    _ship_classify_binary "$root" "$patch_base" "$@" || return 1
  fi
  # Names come out of `git diff -z`, so they are raw and repo-root-relative — but a filename may
  # legally contain `*` or start with `:`, which a bare pathspec would reinterpret as magic. Same
  # reasoning as the `:(top,literal)` GIT_PATHS construction in ship-branch.sh.
  #
  # EXCLUDES covers EVERY classified path: none of them may reach the three-way arm, whoever changed
  # it, because ship_stage_whole_file below owns all of them and decides each one atomically at
  # staging time. SELECTORS is the same set as a positive pathspec, used only by the pre-worktree
  # nothing-to-commit guard, which is a preflight and already fails toward "has changes".
  for path in ${WHOLE_POSITIVES[@]+"${WHOLE_POSITIVES[@]}"}; do
    WHOLE_SELECTORS+=(":(top,literal)$path")
    WHOLE_EXCLUDES+=(":(top,literal,exclude)$path")
  done
}

# _ship_here_entry <root> <path>
# "<mode> <oid>" for the caller's CURRENT version of a path, with the blob written into the object
# database so the oid is durable. Nothing printed, exit 1, when the path is absent.
#
# The write is what makes the caller race-free: once the blob exists under its own hash, a later edit
# in the shared checkout cannot change what that oid refers to.
_ship_here_entry() {
  local root=$1 path=$2 oid verify indexed head target before after
  # Gitlinks first: a submodule pointer lives in the INDEX, and its commit object is in the
  # submodule's database, so there is nothing on disk to hash and no blob to write.
  indexed=$(git -C "$root" ls-files -s -- ":(top,literal)$path" 2>/dev/null) || indexed=
  case $indexed in
    160000\ *)
      # A 160000 index entry OUTLIVES `rm -rf sub/`, so the index alone cannot tell "the caller
      # deleted this submodule" from "the pointer is unchanged". Reporting the stale entry for a
      # directory that is gone would compare the fork point against itself and silently drop a
      # deletion the caller explicitly briefed; absence is the honest answer, and it is also what
      # ship already does for a submodule that was never populated.
      [ -d "$root/$path" ] || return 1
      indexed=${indexed#* }
      indexed=${indexed%% *}
      # A POPULATED submodule's own HEAD wins over the superproject's index entry. Checking a
      # submodule out to a new commit without running `git add` in the superproject is ordinary
      # submodule workflow, and it leaves `ls-files -s` reporting the OLD commit — so trusting the
      # index would again compare the fork point against itself and drop the briefed pointer move.
      if [ -e "$root/$path/.git" ]; then
        head=$(git -C "$root/$path" rev-parse HEAD 2>/dev/null) || head=
        [ -z "$head" ] || indexed=$head
      fi
      printf '160000 %s\n' "$indexed"
      return 0
      ;;
  esac
  if [ -L "$root/$path" ]; then
    # Exit 2, not 1: the `-L` test already proved the entry existed, so a failure now means it was
    # removed or retyped under us. Reporting that as plain absence would turn a concurrent deletion
    # into a shipped deletion the caller never asked for.
    #
    # readlink's output goes to a FILE, never down a pipe into hash-object. In a pipeline only the
    # LAST command's status survives by default, so a readlink that fails mid-race would leave
    # hash-object happily succeeding on empty input and staging a symlink with an empty target. This
    # file is SOURCED and must not depend on the caller having set `pipefail` to notice that.
    # `--no-filters` because the blob IS the raw target string; gitattributes never apply to it, and
    # the temp path's own attributes must not be consulted.
    target=$(mktemp "${TMPDIR:-/tmp}/ship-symlink-target.XXXXXX") || return 2
    if ! readlink -n "$root/$path" > "$target" 2>/dev/null; then
      rm -f "$target"
      return 2
    fi
    oid=$(git -C "$root" hash-object -w --no-filters -- "$target" 2>/dev/null) || oid=
    rm -f "$target"
    [ -n "$oid" ] || return 2
    printf '120000 %s\n' "$oid"
  elif [ -f "$root/$path" ]; then
    # Read the whole entry TWICE and require both halves to agree. The checkout is shared, so a
    # parallel agent may chmod or rewrite this file at any moment; a single read can therefore capture
    # a mode that never went with those bytes, or — while a writer is mid-rewrite — a torn byte stream
    # that never existed on disk at all. Exit 2 means "it moved under us", which the caller turns into
    # a retryable abort rather than staging the hybrid.
    #
    # DETECTION, not atomicity, and the distinction is deliberate. POSIX offers no way to snapshot a
    # file's bytes and mode atomically from a shell, and `git add` reading a concurrently-written file
    # has exactly this exposure — so the honest goal is to make a concurrent write loud instead of
    # silent, not to claim it cannot happen. A writer active during either read changes the second
    # oid, and identical reads that bracket a rewrite mean the bytes staged are a state the file
    # genuinely held.
    if [ -x "$root/$path" ]; then before=100755; else before=100644; fi
    oid=$(git -C "$root" hash-object -w -- "$path" 2>/dev/null) || return 2
    verify=$(git -C "$root" hash-object -w -- "$path" 2>/dev/null) || return 2
    if [ -x "$root/$path" ]; then after=100755; else after=100644; fi
    [ "$before" = "$after" ] && [ "$oid" = "$verify" ] || return 2
    printf '%s %s\n' "$after" "$oid"
  else
    return 1
  fi
}

# _ship_tree_entry <root> <rev> <path>
# "<mode> <oid>" for a path in a commit, or nothing when the commit does not carry it.
_ship_tree_entry() {
  local root=$1 rev=$2 path=$3 entry
  entry=$(git -C "$root" ls-tree "$rev" -- ":(top,literal)$path" 2>/dev/null) || return 1
  [ -n "$entry" ] || return 1
  # "<mode> <type> <oid>\t<path>"
  printf '%s %s\n' "${entry%% *}" "$(printf '%s' "${entry#* * }" | cut -f1)"
}

# ship_stage_whole_file <root> <wt> <patch-base> <path...>
# Stage the non-mergeable carve-out into the ship worktree, deciding each path from a SINGLE read.
#
# The obvious shape — probe "did the caller change it?", then later `git diff` the bytes — is not
# safe here. The caller's checkout is SHARED and a parallel agent may edit these paths at any moment
# (devkit's stated premise), so a decision taken from one read and bytes taken from a later one can
# disagree: an edit that lands in between is dropped from the ship, and a revert that lands in between
# turns the staged whole-file diff back into a revert of the base's own work. Both are silent.
#
# Here the oid that ANSWERS the question is the oid that gets STAGED, and it is written to the object
# database before either use, so nothing that happens to the working tree afterwards can change it.
# The worktree is cut from BASE, so a path this function skips simply keeps the base's version.
ship_stage_whole_file() {
  local root=$1 wt=$2 patch_base=$3 path here fork here_rc
  shift 3
  for path in "$@"; do
    here_rc=0
    here=$(_ship_here_entry "$root" "$path") || here_rc=$?
    if [ "$here_rc" -gt 1 ]; then
      echo "ship: $path changed in the caller checkout while it was being staged — retry the same command" >&2
      return 1
    fi
    [ "$here_rc" -eq 0 ] || here=
    fork=$(_ship_tree_entry "$root" "$patch_base" "$path") || fork=
    [ "$here" != "$fork" ] || continue          # caller never touched it — leave the base's version
    if [ -z "$here" ]; then
      # Present at the fork point, gone from the caller's tree: an explicit deletion to carry over.
      git -C "$wt" update-index --force-remove -- "$path" || return 1
      # -r because a gitlink materialises as a DIRECTORY in the worktree, and a plain `rm -f` on one
      # fails — which under the caller's `set -e` would kill the ship outright. The target is always
      # inside the throwaway ship worktree, never the caller's checkout.
      rm -rf -- "$wt/$path"
      continue
    fi
    git -C "$wt" update-index --add --cacheinfo "${here% *},${here#* },$path" || return 1
    # Put the bytes on disk too: the gate chain reads and may reformat briefed files, and a staged
    # entry with no working-tree file reads as a deletion to everything downstream. A gitlink is the
    # one entry with nothing to write — its commit lives in the submodule's own database.
    #
    # NOT best-effort. A materialisation that fails after the index update (a required smudge filter
    # exiting non-zero, a permission error) leaves the index and the worktree describing different
    # content — and every gate downstream reads the WORKTREE while the commit takes the INDEX, so the
    # ship would validate one thing and commit another.
    if [ "${here% *}" != 160000 ]; then
      git -C "$wt" checkout-index -f -- "$path" || {
        echo "ship: could not materialise $path in the ship worktree" >&2
        return 1
      }
    fi
  done
}

# ship_untracked_matches_base <root> <base> <path>
# Is this path, untracked HERE, byte-and-type identical to what the base tracks at the same name?
# Exit 0 = identical (safe to copy, it changes nothing), 1 = differs or absent.
#
# Both halves of "identical" are load-bearing:
#
# MODE, because content equality alone would let a regular file whose bytes happen to equal a
# symlink's target silently replace that symlink, converting the entry's type with nothing to review.
#
# TYPE-CORRECT HASHING, because `git hash-object <path>` FOLLOWS a symlink and hashes its TARGET'S
# CONTENT, while git stores the target STRING. Comparing the two forms reads a byte-identical symlink
# as a conflict and aborts a ship that is entirely fine — a false abort on the exact shape (a base
# that added a symlink a generator also produced locally) this probe is most likely to meet.
#
# The regular-file branch hashes through the REPO-RELATIVE path so .gitattributes filters resolve the
# same way they did when the base's blob was written; an absolute path outside the worktree would
# skip them and mismatch on any repo using text=auto.
ship_untracked_matches_base() {
  local root=$1 base=$2 path=$3 entry base_mode base_oid here_mode here_oid here_target
  entry=$(git -C "$root" ls-tree "$base" -- ":(top,literal)$path" 2>/dev/null) || return 1
  [ -n "$entry" ] || return 1
  base_mode=${entry%% *}
  entry=${entry#* }          # "blob <oid>\t<path>"
  entry=${entry#* }          # "<oid>\t<path>"
  base_oid=${entry%%$'\t'*}
  [ -n "$base_mode" ] && [ -n "$base_oid" ] || return 1

  if [ -L "$root/$path" ]; then
    here_mode=120000
    # `readlink -n`, never `$(readlink ...)`. Plain readlink appends a newline git does not store, and
    # the obvious correction — command substitution, which strips it — strips ALL trailing newlines,
    # including ones that are genuinely part of the target. A POSIX symlink target is an arbitrary
    # byte string, so `ln -s $'a\n' lnk` is legal: git stores "a\n" while the substitution yields "a",
    # and this probe would report an identical symlink as a clobber and abort a valid ship. Verified
    # against git's own blob: -n matches, substitution does not.
    #
    # Routed through a FILE rather than a pipe for the same reason as _ship_here_entry: in a pipeline
    # only the last command's status survives unless the caller happens to have set `pipefail`, so a
    # failing readlink would leave hash-object succeeding on empty input. Here that would compute the
    # empty blob, compare unequal, and abort a ship over a symlink it never actually read.
    here_target=$(mktemp "${TMPDIR:-/tmp}/ship-probe-target.XXXXXX") || return 1
    if ! readlink -n "$root/$path" > "$here_target" 2>/dev/null; then
      rm -f "$here_target"
      return 1
    fi
    here_oid=$(git -C "$root" hash-object --no-filters -- "$here_target" 2>/dev/null) || here_oid=
    rm -f "$here_target"
    [ -n "$here_oid" ] || return 1
  elif [ -f "$root/$path" ]; then
    if [ -x "$root/$path" ]; then here_mode=100755; else here_mode=100644; fi
    here_oid=$(git -C "$root" hash-object -- "$path" 2>/dev/null) || return 1
  else
    return 1   # a directory or a dangling link is never "identical" to a tracked blob
  fi

  [ "$base_mode" = "$here_mode" ] && [ "$base_oid" = "$here_oid" ]
}

# ship_warn_whole_file_drift <root> <base> <patch-base> <base-ref>
# The carve-out has one knowing gap left: when BOTH sides changed a non-mergeable path there is no
# merge to attempt, so the caller's copy replaces the base's wholesale and the base's version is lost
# exactly as it was before sc-2451. A path only the BASE changed is not affected — ship_stage_whole_file
# leaves those alone — so only the genuine both-sides case is worth saying, and saying more would
# retrain the reader to ignore it.
#
# Advisory rather than blocking, for the same reason the carve-out exists: a block here would fire on
# every legitimate concurrent edit of a shared asset. But it must never be SILENT, because a reviewer
# noticing by luck is the failure this whole ticket is about. Being advisory, it is also allowed to
# read the working tree a second time — a stale answer here costs a line of output, never content.
ship_warn_whole_file_drift() {
  local root=$1 base=$2 patch_base=$3 base_ref=$4 path replaced=()
  [ "$patch_base" != "$base" ] || return 0
  for path in ${WHOLE_POSITIVES[@]+"${WHOLE_POSITIVES[@]}"}; do
    git -C "$root" diff --quiet "$patch_base" -- ":(top,literal)$path" 2>/dev/null && continue
    git -C "$root" diff --quiet "$patch_base" "$base" -- ":(top,literal)$path" 2>/dev/null && continue
    replaced+=("$path")
  done
  [ "${#replaced[@]}" -gt 0 ] || return 0
  echo "⚠️  ship: you and origin/$base_ref both changed these non-mergeable path(s) since ${patch_base:0:7}:" >&2
  for path in "${replaced[@]}"; do printf '     %q\n' "$path" >&2; done
  echo "     Binary, symlink and submodule entries cannot be three-way merged, so your copy replaces" >&2
  echo "     the base's wholesale. Check you are not discarding the base's version of them." >&2
}
