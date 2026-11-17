#!/usr/bin/env bash
# The text arm of ship's explicit-paths staging. Sourced by patch-anchor.sh.

# ship_apply_text_arm <root> <base> <patch_base> <base_ref> <patch> <err> --worktree <wt> | --index <file>
# The THREE-WAY text arm: build the fork-point-anchored patch into <patch>, apply it, and on failure
# print why. Reads GIT_PATHS and WHOLE_EXCLUDES (the carve-out never reaches this arm).
#
# ONE function behind two targets so the pre-worktree trial and real staging cannot disagree about
# what conflicts or how it is reported (sc-3496). --worktree is staging: `apply --index --3way` into
# the ephemeral worktree. --index is the trial: `apply --cached --3way` into a throwaway index already
# holding read-tree BASE, which writes stages 1/2/3 exactly as the worktree form does (git >= 2.32),
# with no branch, no worktree and nothing in the caller's own index.
#
# Returns 0 clean, 1 blocking (a same-region conflict or a base-deleted/retyped briefed path — both
# already reported), 2 the apply failed for any OTHER reason. 2 is only returned for --index: the
# trial is a preflight and fails open, whereas staging has never had a third outcome to fall into.
ship_apply_text_arm() {
  local root=$1 base=$2 patch_base=$3 base_ref=$4 patch=$5 err=$6 mode=$7 target=$8 p rec last=
  local conflicts=() vanished=()
  git -C "$root" diff "$patch_base" --binary -- \
    "${GIT_PATHS[@]}" ${WHOLE_EXCLUDES[@]+"${WHOLE_EXCLUDES[@]}"} > "$patch" || return 2
  [ -s "$patch" ] || return 0
  if [ "$mode" = --index ]; then
    GIT_INDEX_FILE=$target git -C "$root" apply --cached --3way "$patch" 2> "$err" &&
      { _ship_union_guard "$root" "$base" "$patch_base" "$base_ref" "$mode" "$target"; return; }
  else
    git -C "$target" apply --index --3way "$patch" 2> "$err" &&
      { _ship_union_guard "$root" "$base" "$patch_base" "$base_ref" "$mode" "$target"; return; }
  fi

  # (a) Same-region overlap. UNMERGED index entries are the unambiguous, locale-independent
  # marker: `git apply --3way` writes stages 1/2/3 exactly when its merge produced conflict hunks.
  # They name precisely the paths that failed, which is narrower and more actionable than the
  # base-drift overlap set (every path that moved, merged or not).
  #
  # Read NUL-delimited into an ARRAY, never through a newline-joined string: a newline is legal in a
  # filename, and splitting on it would blame fragments that do not exist and look up commits for
  # them. `ls-files -u` repeats a path once per stage (1/2/3), consecutively, so adjacent duplicates
  # collapse to one entry.
  if [ "$mode" = --index ]; then
    while IFS= read -r -d '' rec; do
      p=${rec#*$'\t'}
      [ "$p" = "$last" ] && continue
      conflicts+=("$p")
      last=$p
    done < <(GIT_INDEX_FILE=$target git -C "$root" ls-files -u -z 2>/dev/null || true)
  else
    while IFS= read -r -d '' p; do
      conflicts+=("$p")
    done < <(git -C "$target" diff --name-only -z --diff-filter=U 2>/dev/null || true)
  fi

  # (b) Structural: the base DELETED or RETYPED a briefed path out from under the patch. Git
  # reports this as "does not exist in index", then falls back to direct application and fails the
  # whole patch WITHOUT leaving any unmerged entry — so (a) would name nothing. That string is
  # translatable, so the condition is recomputed from the trees instead. --no-renames turns a
  # base-side rename into the D+A pair this filter sees; T catches file->symlink and
  # file->directory transitions, which break application the same way.
  # Intersected with what the CALLER actually changed. The base-side D/T set alone also contains
  # paths the caller never touched — the base simply deleted them — and naming those would tell an
  # operator their edits target a file they never edited, sending them to inspect the wrong path
  # while the real conflict goes unmentioned.
  while IFS= read -r -d '' p; do
    git -C "$root" diff --quiet "$patch_base" -- ":(top,literal)$p" 2>/dev/null && continue
    vanished+=("$p")
  done < <(git -C "$root" diff --name-only -z --no-renames --diff-filter=DT \
    "$patch_base" "$base" -- "${GIT_PATHS[@]}" ${WHOLE_EXCLUDES[@]+"${WHOLE_EXCLUDES[@]}"} 2>/dev/null || true)
  ship_take_gate_owned_baseline "$root" "$base" "$base_ref" "$mode" "$target" && return 0

  # Nothing this function can name: the trial stays silent and lets staging take the authoritative
  # verdict. Staging keeps its historical behaviour — git's own stderr, then the abort.
  if [ "$mode" = --index ] && [ "${#conflicts[@]}" -eq 0 ] && [ "${#vanished[@]}" -eq 0 ]; then
    return 2
  fi

  cat "$err" >&2
  # A GENERATED path (a devkit manifest, or one the consumer declares under `generated` in its
  # guard.config.json) must be pointed at its generator: hand-merging one produces a file that
  # matches neither tree (sc-2770). The declarations come from the tree being SHIPPED, so a generated
  # path the base newly declares is honoured — the worktree for staging, and for the trial the
  # config files materialised from its throwaway index into a scratch root. Captured first so a
  # failed render prints nothing partial; any failure falls back to the plain hand-merge text.
  local gen_abort=
  if [ "${#conflicts[@]}" -gt 0 ]; then gen_abort=$(_ship_generated_abort "$root" "$base_ref" "$mode" "$target" "${conflicts[@]}"); fi
  if [ -n "$gen_abort" ]; then
    printf '%s\n' "$gen_abort" >&2
  elif [ "${#conflicts[@]}" -gt 0 ]; then
    echo "ship: origin/$base_ref and your working tree changed the same region of:" >&2
    for p in "${conflicts[@]}"; do printf '  %q\n' "$p" >&2; done
    echo "  ship cannot resolve this for you — the merge has to happen where you can see both sides." >&2
  fi
  # Whichever renderer named the conflicts, name the base commits behind them too (sc-3496): the
  # advisory already knew them, and they are what the operator has to go and read.
  if [ "${#conflicts[@]}" -gt 0 ]; then
    echo "  base commits behind these conflicts since ${patch_base:0:7}:" >&2
    for p in "${conflicts[@]}"; do _ship_path_with_commits "$root" "$base" "$patch_base" "$p"; done
  fi
  if [ "${#vanished[@]}" -gt 0 ]; then
    echo "ship: origin/$base_ref has deleted or retyped briefed path(s) since ${patch_base:0:7}:" >&2
    for p in "${vanished[@]}"; do _ship_path_with_commits "$root" "$base" "$patch_base" "$p"; done
    echo "  your edits target a file the base no longer has — decide whether the deletion or your" >&2
    echo "  edit wins before shipping." >&2
  fi

  # No shallow PRE-probe, deliberately: when the fork-point blobs are absent git falls back to
  # DIRECT application of the same fork-point-anchored patch, which is still correct (that patch
  # carries no deletion hunk for base-only work), so only merge tolerance is lost. Re-anchoring at
  # BASE to dodge this would silently re-stage the sc-2451 revert on every ship in such a repo —
  # fail-open on a DIAGNOSTIC is ship_size_preflight's rule, fail-open on the PAYLOAD is the bug.
  if [ "$(git -C "$root" rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
    echo "  (shallow clone: three-way merge data may be missing — \`git fetch --unshallow\` can turn some of these into clean merges)" >&2
  fi
  echo "  Merge or rebase origin/$base_ref into this checkout, then retry the same command." >&2
  return 1
}
