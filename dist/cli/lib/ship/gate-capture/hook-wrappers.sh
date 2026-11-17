#!/usr/bin/env bash
# Private hook-wrapper projection for commit-with-gate-capture.sh. Sourced by it.

# Projects ship-owned wrappers of the real hook chain into a private dir and exports the proof
# marker. Runs by dynamic scope in commit_with_gate_capture: it sets that function's rc,
# hook_setup_failed/hook_setup_error, ship_hook_dir and ship_hook_rel, and reads wt, real_hooks_dir,
# ship_hook_marker.
_ship_project_hook_wrappers() {
  local source_hook source_name
  if [ "$hook_setup_failed" -eq 0 ]; then
    ship_hook_dir=$(mktemp -d "$wt/.devkit-ship-hooks.XXXXXX") || {
      hook_setup_error="ship: could not create the private hook wrapper — gates must not fail open"
      hook_setup_failed=1
      rc=1
    }
  fi
  if [ "$hook_setup_failed" -eq 0 ]; then
    ship_hook_rel=${ship_hook_dir#"$wt/"}
    for source_hook in "$real_hooks_dir"/*; do
      [ -x "$source_hook" ] || continue
      source_name=${source_hook##*/}
      if ! (umask 077; cat > "$ship_hook_dir/$source_name" <<'SHIP_HOOK_WRAPPER'
#!/bin/sh
hook_name=${0##*/}
if [ "$hook_name" = pre-commit ]; then
  printf '%s\n' "$DEVKIT_SHIP_HOOK_MARKER" >&2
fi
exec "$DEVKIT_SHIP_REAL_HOOKS_DIR/$hook_name" "$@"
SHIP_HOOK_WRAPPER
        chmod 700 "$ship_hook_dir/$source_name"); then
        hook_setup_error="ship: could not project the real hook chain into the private wrapper — gates must not fail open"
        hook_setup_failed=1
        rc=1
        break
      fi
    done
  fi
  if [ "$hook_setup_failed" -eq 0 ] && [ ! -x "$ship_hook_dir/pre-commit" ]; then
    hook_setup_error="ship: private hook projection omitted pre-commit — gates must not fail open"
    hook_setup_failed=1
    rc=1
  fi
  if [ "$hook_setup_failed" -eq 0 ]; then
    export DEVKIT_SHIP_HOOK_MARKER="$ship_hook_marker"
    export DEVKIT_SHIP_REAL_HOOKS_DIR="$real_hooks_dir"
  fi
}
