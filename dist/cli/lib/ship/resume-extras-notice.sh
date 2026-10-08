#!/usr/bin/env bash
# Sourced by ship-branch.sh + reship.sh. A --resume that exits before its record write leaves the
# older, narrower path list on disk, so the next bare --resume would silently judge base copies.

# ship_resume_brief — list the caller's PATHS one per line, marking what this retry briefed beyond
# the record, and arm the notice below until a record write is attempted.
ship_resume_brief() {
  local p q extra
  for p in "${PATHS[@]}"; do
    extra=
    for q in ${RESUME_EXTRA_PATHS[@]+"${RESUME_EXTRA_PATHS[@]}"}; do [ "$q" = "$p" ] && { extra=1; break; }; done
    if [ -n "$extra" ]; then printf '  + %q   (briefed by this retry)\n' "$p" >&2
    else printf '    %q\n' "$p" >&2
    fi
  done
  [ "${#RESUME_EXTRA_PATHS[@]}" -eq 0 ] || { RESUME_EXTRAS_UNRECORDED=1; trap ship_resume_extras_notice EXIT; }
}

# ship_resume_extras_notice — EXIT-trap hook reading the caller's BR and RESUME_EXTRA_PATHS. Silent
# unless the exit is a failure and RESUME_EXTRAS_UNRECORDED is still armed (no record write tried).
ship_resume_extras_notice() {
  local rc=$? p n=0 quoted=
  [ "$rc" -ne 0 ] && [ "${RESUME_EXTRAS_UNRECORDED:-0}" -eq 1 ] || return 0
  RESUME_EXTRAS_UNRECORDED=0
  for p in "${RESUME_EXTRA_PATHS[@]}"; do
    # A refused directory is not worth re-passing: the printed command must be one that can work.
    [ -d "${ROOT:-.}/$p" ] && [ ! -L "${ROOT:-.}/$p" ] && continue
    n=$((n + 1)); quoted="$quoted $(printf '%q' "$p")"
  done
  [ "$n" -gt 0 ] || return 0
  echo "ship: $n path(s) briefed by this retry were NOT recorded — a bare --resume will not carry them:$quoted" >&2
  echo "  re-pass them: devkit ship --resume $(printf '%q' "$BR") --$quoted" >&2
}
