#!/usr/bin/env bash
# Overlay refusal, base-conflict preflight and intent-record helpers for ship-branch.sh. Sourced by it.

# Lists index/worktree/untracked/ignored overlays on the NUL-separated members; 1 when any, 2 when
# unlisted. Callers sit in `||`, where errexit is off, so every listing failure returns explicitly.
ship_refuse_overlays() {  # <root> <source-head> <members-file> [header-prefix]
  local root=$1 head=$2 members=$3 prefix=${4:-} found=0 kind p listed
  local sel=()
  while IFS= read -r -d '' p; do sel+=(":(top,literal)$p"); done < "$members"
  [ "${#sel[@]}" -gt 0 ] || return 0
  listed=$(mktemp "${TMPDIR:-/tmp}/ship-branch-overlays.XXXXXX") || return 2
  for kind in index worktree untracked ignored; do
    case "$kind" in
      index) git -C "$root" diff --cached --name-only -z "$head" -- "${sel[@]}" ;;
      worktree) git -C "$root" diff --name-only -z -- "${sel[@]}" ;;
      untracked) git -C "$root" ls-files -o --exclude-standard -z -- "${sel[@]}" ;;
      ignored) git -C "$root" ls-files -o -i --exclude-standard -z -- "${sel[@]}" ;;
    esac | node "$SHIP_INTENT" filter-membership --members-file "$members" > "$listed" \
      || { echo "--from-branch: could not list $kind overlays on --from-branch paths" >&2; rm -f "$listed"; return 2; }
    while IFS= read -r -d '' p; do
      [ "$found" -eq 1 ] || echo "${prefix}--from-branch refuses uncommitted overlays on --from-branch paths; commit or remove these exact overlays:" >&2
      found=1
      printf '  %q (%s)\n' "$p" "$kind" >&2
    done < "$listed"
  done
  rm -f "$listed"
  [ "$found" -eq 0 ]
}

# Take staging's hunk-level verdict BEFORE any branch or worktree exists (sc-3496). The same function
# staging calls below, pointed at a throwaway index holding BASE instead of the ephemeral worktree,
# so the two cannot disagree about what conflicts or how it is named. It used to run only after the
# worktree claim, so a conflict the base-drift advisory had already named cost a branch+worktree
# created and deleted for nothing; it now runs first among the blocking preflights. Still hunk-level,
# never path-level: base-drift-surfaced-at-read-time Rejected(a) is untouched.
#
# Staging stays AUTHORITATIVE. $ROOT is a shared checkout, so a clean trial does not promise a clean
# apply later; the rare conflict a concurrent edit would have dissolved is an accepted false block.
# Skipped when the branch already exists, so a preserved-commit --resume still reaches its own
# refusal. Fails OPEN on anything but a named conflict — it is a preflight, not the payload.
ship_text_arm_trial() {
  local idx patch err rc=0
  idx=$(mktemp "${TMPDIR:-/tmp}/ship-trial-index.XXXXXX") || return 0
  rm -f "$idx" # read-tree must create it; an empty file is not a valid index
  patch=$(mktemp "${TMPDIR:-/tmp}/ship-trial.XXXXXX") || return 0
  err=$(mktemp "${TMPDIR:-/tmp}/ship-trial-err.XXXXXX") || { rm -f "$patch"; return 0; }
  if GIT_INDEX_FILE=$idx git -C "$ROOT" read-tree "$BASE" 2>/dev/null; then
    ship_apply_text_arm "$ROOT" "$BASE" "$PATCH_BASE" "$BASE_REF" "$patch" "$err" --index "$idx" || rc=$?
  fi
  rm -f "$idx" "$idx.lock" "$patch" "$err"
  [ "$rc" -ne 1 ] && return 0
  echo "ship: preflight — blocked before creating a branch or worktree; nothing was staged or gated." >&2
  return 1
}

# Both base-conflict refusals as one blocking preflight, a no-op unless the base moved past the fork
# point. A preserved-commit retry only warns, so it still reaches the --resume recovery check.
ship_base_conflict_preflight() {
  [ "$FROM_BRANCH" -eq 0 ] && [ "$PATCH_BASE" != "$BASE" ] || return 0
  if ! ship_refuse_whole_file_drift "$ROOT" "$BASE" "$PATCH_BASE" "$BASE_REF" ${LOCAL_BRANCH_EXISTS:+--advise}; then
    echo "ship: preflight — blocked before creating a branch or worktree; nothing was staged or gated." >&2
    return 1
  fi
  [ -n "$LOCAL_BRANCH_EXISTS" ] || ship_text_arm_trial
}

record_ship_intent() {
  RESUME_EXTRAS_UNRECORDED=0
  [ "$DRY_GATES" -eq 0 ] || return 0
  ! ship_prequeue_active || return 0
  # Capture the record's ownership token (write prints a per-attempt random generation): success may delete ONLY the
  # record this attempt wrote — a concurrent attempt's newer record must survive for ITS --resume.
  SHIP_INTENT_GENERATION=$(printf '%s' "$BODY" | node "$SHIP_INTENT" "${SHIP_INTENT_ARGS[@]}" -- "${PATHS[@]}") \
    || { SHIP_INTENT_GENERATION=""; echo "ship: invocation not recorded — the retry needs the full command (non-fatal)" >&2; }
  [ -n "$SHIP_INTENT_GENERATION" ] || SHIP_SOURCE_ATTEMPT_ID=
  # Exported flag (not the token itself) so the SUBPROCESS gate runner's timeout banner can tell a
  # recorded attempt (--resume works) from an unrecorded one (--resume would refuse by name).
  export DEVKIT_SHIP_INTENT_RECORDED=$([ -n "$SHIP_INTENT_GENERATION" ] && echo 1 || echo 0)
  if [ "$FROM_BRANCH" -eq 1 ] && [ -n "$SHIP_INTENT_GENERATION" ]; then
    if [ -z "$SHIP_SOURCE_ATTEMPT_ID" ]; then
      if [ "$RESUME" -eq 1 ] && [ -n "$LOCAL_BRANCH_EXISTS" ]; then SHIP_SOURCE_ATTEMPT_ID=$RESUME_SOURCE_ATTEMPT_ID
      else SHIP_SOURCE_ATTEMPT_ID=$SHIP_INTENT_GENERATION
      fi
    fi
  fi
}

# A blocking preflight refused: record this attempt unless it already recorded, then exit with the
# preflight's own status, naming it as the ship_end cause. record_ship_intent is a no-op under
# --dry-gates; a resume already CASes the generation it read, and a fresh attempt CASes its snapshot.
ship_abort_resumable() {
  local rc=$1
  SHIP_END_CAUSE=$2
  if [ "$DEVKIT_SHIP_INTENT_RECORDED" -ne 1 ]; then
    [ -z "$SHIP_INTENT_START_GENERATION" ] ||
      SHIP_INTENT_ARGS+=(--expect-generation "$SHIP_INTENT_START_GENERATION")
    record_ship_intent
  fi
  exit "$rc"
}

# The ship's one terminal row; a rehearsal writes none. Silent and best-effort: it never fails a ship.
ship_end_record() {
  [ "$DRY_GATES" -eq 0 ] && [ -z "${SHIP_END_RECORDED:-}" ] || return 0
  SHIP_END_RECORDED=1
  node "$SHIP_EVENT" end "$1" "$SHIP_END_CAUSE" >/dev/null 2>&1 || true
}
