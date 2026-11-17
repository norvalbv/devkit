#!/usr/bin/env bash
# Picks the node_modules install a gate worktree links or builds. Sourced by prepare-gate-worktree.sh.

# Pick the first install that satisfies the BASE package.json in the ephemeral worktree.
# "Populated" is only a fast preference: a real but stale install can miss a dependency added by the
# base after that checkout last installed. Try the linked root first, then the main worktree fallback,
# then a frozen install of the base's own lockfile in the worktree.
gate_node_modules_source() {
  local wt=$1 root=$2 main_root=$3 tool candidate missing rc remedy
  local candidates=("$root/node_modules")
  local rejected=()
  [ "$main_root" = "$root" ] || candidates+=("$main_root/node_modules")
  tool=$(gate_dependency_preflight_tool)
  [ -f "$tool" ] || {
    echo "devkit ship: dependency preflight helper is unavailable" >&2
    return 1
  }

  # Preserve the existing populated-first preference, then its existence fallback. The second pass
  # matters for dependency-free repos whose node_modules contains only tool caches.
  local pass
  for pass in populated exists; do
    for candidate in "${candidates[@]}"; do
      if [ "$pass" = populated ]; then
        gate_dir_is_populated "$candidate" || continue
      else
        [ -e "$candidate" ] || continue
      fi
      if missing=$(node "$tool" "$wt/package.json" "$candidate"); then
        printf '%s\n' "$candidate"
        return 0
      else
        rc=$?
      fi
      [ "$rc" -eq 1 ] || return "$rc"
      missing=${missing//$'\n'/, }
      rejected+=("$candidate"$'\t'"$missing")
    done
    [ "${#rejected[@]}" -eq 0 ] || break
  done

  # No install existed before this change either: preserve the old "nothing to link" result so
  # non-JS repos and hermetic ship fixtures continue without a new precondition.
  [ "${#rejected[@]}" -gt 0 ] || return 1
  remedy=$(node "$tool" --remedy "$wt")
  local attempted=0
  local -a cmd
  case $remedy in
    'install dependencies'*) ;;
    *)
      # A checkout that predates the base cannot install what only the base declares, so install the
      # base's own lockfile here. HUSKY=0 keeps a root `prepare: husky` off the shared hook config.
      echo "  ↳ no existing install satisfies the ship base — running \`$remedy\` in the gate worktree" >&2
      read -ra cmd <<<"$remedy"
      if (cd "$wt" && HUSKY=0 "${cmd[@]}") >&2 &&
        node "$tool" "$wt/package.json" "$wt/node_modules" >/dev/null; then
        printf '%s\n' "$wt/node_modules"
        return 0
      fi
      attempted=1
      ;;
  esac
  echo "devkit ship: no node_modules satisfies the ship base package.json:" >&2
  local rejection path packages
  for rejection in "${rejected[@]}"; do
    path=${rejection%%$'\t'*}
    packages=${rejection#*$'\t'}
    echo "  - $path (missing: $packages)" >&2
  done
  if [ "$attempted" -eq 1 ]; then
    echo "\`$remedy\` in the gate worktree did not supply them (output above) — fix that, then retry the same ship command." >&2
  else
    echo "run \`$remedy\` in the checkout, then retry the same ship command." >&2
  fi
  return 2
}
