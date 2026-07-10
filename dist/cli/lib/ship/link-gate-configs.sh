#!/usr/bin/env bash
# Sourced by ship-branch.sh + reship.sh. Symlink gate-input files that live in the repo but are ABSENT
# from the ephemeral commit worktree, so the worktree's gates match a plain commit instead of silently
# falling to defaults.
#
# Why: the ship worktree is a clean checkout at $BASE (only TRACKED files). An untracked config
# (guard.config.json / .fallowrc.jsonc a consumer never committed) or a gitignored cache/index
# (.search-code, .fallow, .decisions) therefore never reaches it — so the co-occurrence matcher "opts
# out (fail-open)", frontend reviewers skip (empty frontendRoots), the allowlist reads empty. Nothing
# fails, nothing warns: the ship LOOKS fully gated while running a weaker chain than a plain commit.
# We link each such input in (exactly what --link does by hand) and print a loud notice so it is never
# silent. Run AFTER change-application: anything already tracked, --linked, or shipped as a path is
# present in $WT and skipped — no double-link, no `ln` clobber of a real file under `set -e`.
#
# The config-DRIVEN locations (indexPath, allowlistPath) come from gate-config-paths.mts, not a
# hardcode — decision synced-assets-layout-agnostic mandates resolving roots from guard.config.json.
# The rest are devkit's own fixed artifact names.

# link_untracked_gate_configs <worktree> <root>
link_untracked_gate_configs() {
  local wt=$1 root=$2 self_dir emitter resolved rel line
  local linked=()
  # devkit's own fixed gate artifacts (guard.config.json is CONFIG_FILENAME — never configurable).
  local candidates=(guard.config.json .fallowrc.jsonc .fallowrc.json .fallow fallow-baselines .decisions)

  # Config-driven paths (indexPath / allowlistPath) from the resolver. .mts in source, built .mjs in an
  # installed consumer (the reconcile-manifest-write.mts dual-ext idiom). A resolver failure (unparseable
  # guard.config.json → resolveGuardConfig throws) is non-fatal: warn, keep the hardcoded set, and let
  # the worktree gate fail loud on the same bad config.
  self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  emitter="$self_dir/gate-config-paths.mts"; [ -f "$emitter" ] || emitter="$self_dir/gate-config-paths.mjs"
  if resolved=$(node "$emitter" "$root" 2>/dev/null); then
    while IFS= read -r line; do [ -n "$line" ] && candidates+=("$line"); done <<< "$resolved"
  else
    echo "⚠️  ship: could not resolve config gate paths (guard.config.json unreadable?) — linking known defaults only" >&2
  fi

  for rel in "${candidates[@]}"; do
    # Present in the repo but absent from the committed worktree = the gate would fail open. The -L guard
    # also skips a pre-existing symlink (a --linked dep, or a broken link) so `ln` never aborts on it.
    [ -e "$root/$rel" ] && [ ! -e "$wt/$rel" ] && [ ! -L "$wt/$rel" ] || continue
    mkdir -p "$wt/$(dirname "$rel")"
    ln -s "$root/$rel" "$wt/$rel"
    linked+=("$rel")
  done

  # Guard the empty array BEFORE expanding it (stock-macOS bash 3.2 aborts on "${arr[@]}" when empty
  # under `set -u`; cf. commit-with-gate-capture.sh).
  [ "${#linked[@]}" -eq 0 ] && return 0
  {
    echo "⚠️  ship: ${#linked[@]} gate config(s) present in the repo but absent from the committed tree —"
    echo "   linked into the gate worktree so gates match a normal commit (not defaults):"
    for rel in "${linked[@]}"; do
      # `check-ignore -q` inside the `if` → its exit-1 "not ignored" is errexit-safe.
      if git -C "$root" check-ignore -q "$rel"; then
        echo "   - $rel (gitignored cache — normal)"
      else
        echo "   - $rel (untracked — commit it so gates are consistent for everyone)"
      fi
    done
  } >&2
  return 0
}
