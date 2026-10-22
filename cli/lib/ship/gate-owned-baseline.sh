#!/usr/bin/env bash
# Sourced by ship-branch.sh. A ratchet baseline the commit gate re-derives needs no hand-merge: the
# base copy is a correct start, and guard-size re-lowers each staged file's entry from the index.

# Equals LINES_BASELINE in gate-engine/ratchets/baseline-paths.mts. size.json is not here: its
# ratchet reads the working tree, not the index snapshot, so it cannot re-derive a staged copy.
SHIP_GATE_OWNED_BASELINE=.devkit/baselines/size-lines.json

# ship_take_gate_owned_baseline <root> <base> <base_ref> --worktree <wt> | --index <file>: 0 once
# the base copy replaces a sole-blocker baseline; mixed, it just leaves `conflicts` (hand-merges).
ship_take_gate_owned_baseline() {
  local root=$1 base=$2 base_ref=$3 mode=$4 target=$5 p found= kept=()
  for p in ${conflicts[@]+"${conflicts[@]}"}; do
    if [ "$p" = "$SHIP_GATE_OWNED_BASELINE" ]; then found=1; else kept+=("$p"); fi
  done
  [ -n "$found" ] || return 1
  if [ "${#kept[@]}" -gt 0 ] || [ "${#vanished[@]}" -gt 0 ]; then
    conflicts=(${kept[@]+"${kept[@]}"})
    return 1
  fi
  if [ "$mode" = --index ]; then
    GIT_INDEX_FILE=$target git -C "$root" reset -q "$base" \
      -- ":(top,literal)$SHIP_GATE_OWNED_BASELINE" 2>/dev/null
    return
  fi
  git -C "$target" checkout "$base" \
    -- ":(top,literal)$SHIP_GATE_OWNED_BASELINE" 2>/dev/null || return 1
  echo "ship: took origin/$base_ref's $SHIP_GATE_OWNED_BASELINE — it is gate-owned; the" \
    "commit gate re-lowers it for each file this ship shrinks" \
    "(re-run any guard-size freeze it carried)." >&2
}
