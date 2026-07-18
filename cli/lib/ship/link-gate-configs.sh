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

# .qavis/receipt.json (last entry below) — the untracked, content-addressed cache qavis writes on a
# `qavis qa` pass. The ship-time qavis-advisory gate shells `qavis route --repo $WT`, which reads it to
# clear the block; the receipt is the one gate input never carried into $WT (untracked, not in the
# pathspec), so a genuine pass otherwise blocks the ship. File-level, NOT `.qavis/` — a dir-level link
# would clobber the tracked recipe.json. Content-addressed → a mismatched staged set can't false-clear
# (route re-ADVISEs). ponytail: clears on the changed BLOBS, not the base — on ship $BASE can be newer
# than qavis's QA base; accepted (the change itself was QA'd). Re-QA is the upgrade path if it matters.
GATE_PROJECTION_FIXED_CANDIDATES=(
  guard.config.json
  .fallowrc.jsonc
  .fallowrc.json
  fallow.toml
  .fallow.toml
  .fallow
  fallow-baselines
  .decisions
  eslint/baselines
  eslint.config.devkit.mjs
  biome.devkit.jsonc
  .qavis/receipt.json
)

gate_config_path_emitter() {
  local self_dir emitter
  self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  emitter="$self_dir/gate-config-paths.mts"
  [ -f "$emitter" ] || emitter="$self_dir/gate-config-paths.mjs"
  printf '%s' "$emitter"
}

# emit_gate_projection_candidates <root>
# NUL-delimited because configured filenames may contain newlines. Callers that need fail-closed
# config validation should probe the emitter first: process-substitution does not preserve its status.
emit_gate_projection_candidates() {
  local root=$1 emitter rel
  emitter=$(gate_config_path_emitter)
  node "$emitter" "$root" >/dev/null 2>&1 || return 1
  for rel in "${GATE_PROJECTION_FIXED_CANDIDATES[@]}"; do printf '%s\0' "$rel"; done
  node "$emitter" "$root" --null
}

sqlite_family_state() {
  local database=$1 suffix path
  for suffix in '' -wal -shm -journal; do
    path="$database$suffix"
    if [ -e "$path" ]; then
      printf '%s=%s\n' "$suffix" "$(git hash-object --no-filters "$path")"
    else
      printf '%s=absent\n' "$suffix"
    fi
  done
}

copy_stable_sqlite_family() {
  local source=$1 destination=$2 before after copied suffix
  before=$(sqlite_family_state "$source") || return 1
  mkdir -p "$(dirname "$destination")"
  for suffix in '' -wal -shm -journal; do
    if [ -e "$source$suffix" ]; then
      cp -pL "$source$suffix" "$destination$suffix"
    else
      rm -f "$destination$suffix"
    fi
  done
  after=$(sqlite_family_state "$source") || return 1
  copied=$(sqlite_family_state "$destination") || return 1
  [ "$before" = "$after" ] && [ "$before" = "$copied" ] || {
    echo "devkit review: SQLite gate index changed during capture; retry." >&2
    return 1
  }
}

is_review_projection_purpose() {
  [ "$1" = review ] || [ "$1" = review-baseline ]
}

# link_untracked_gate_configs <worktree> <root> [purpose]
link_untracked_gate_configs() {
  local wt=$1 root=$2 purpose=${3:-ship} emitter resolved rel line index_rel='' candidate_manifest=''
  local linked=() candidates=()
  case "$purpose" in
    ship | review | review-baseline) ;;
    *)
      echo "devkit: unknown gate-config projection purpose: $purpose" >&2
      return 2
      ;;
  esac
  # devkit's own fixed gate artifacts (guard.config.json is CONFIG_FILENAME — never configurable).
  # Overlay lint configs are local/gitignored by design; projecting them keeps ship/review parity
  # with a normal overlay commit, while callers stage their snapshot before this helper runs.
  # eslint/baselines: the ratchet freezes (fanout/size/size-lines). OVERLAY hides the whole dir via
  # .git/info/exclude (overlay.mts) yet init freezes into it, so it is untracked → absent here. Without
  # it the fanout gate does NOT fail open (that needs guard.config.json absent too, and we just linked
  # it) — it enforces against an EMPTY freeze and every grandfathered folder reads as new growth.
  # ship-gates-converge-not-restart (2026-07-07) already records this link as a dependency: the
  # prefix-cache fingerprint folds in "whole eslint/baselines contents" and needs real state here.
  # ponytail: dir-granular, matching overlay's exclude. A PARTIALLY tracked baselines dir (some frozen
  # files committed, others excluded) is skipped whole by the -e guard below — same ceiling as
  # fallow-baselines/.decisions; per-file merge is the upgrade path if it ever bites.
  # Config-driven paths (indexPath / allowlistPath) from the resolver. .mts in source, built .mjs in an
  # installed consumer (the reconcile-manifest-write.mts dual-ext idiom). A resolver failure (unparseable
  # guard.config.json → resolveGuardConfig throws) is non-fatal: warn, keep the hardcoded set, and let
  # the worktree gate fail loud on the same bad config.
  emitter=$(gate_config_path_emitter)
  if is_review_projection_purpose "$purpose"; then
    candidates=("${GATE_PROJECTION_FIXED_CANDIDATES[@]}")
    candidate_manifest=$(mktemp /tmp/devkit-review-gate-candidates.XXXXXX) || return 1
    if node "$emitter" "$root" --null > "$candidate_manifest" 2>/dev/null; then
      while IFS= read -r -d '' line; do
        [ -n "$line" ] && candidates+=("$line")
      done < "$candidate_manifest"
      rm -f "$candidate_manifest"
      candidate_manifest=
    else
      rm -f "$candidate_manifest"
      echo "devkit review: could not resolve gate config paths; fix guard.config.json and retry." >&2
      return 1
    fi
  else
    candidates=("${GATE_PROJECTION_FIXED_CANDIDATES[@]}")
    if resolved=$(node "$emitter" "$root" 2>/dev/null); then
      while IFS= read -r line; do [ -n "$line" ] && candidates+=("$line"); done <<< "$resolved"
    else
      echo "⚠️  ship: could not resolve config gate paths (guard.config.json unreadable?) — linking known defaults only" >&2
    fi
  fi
  if is_review_projection_purpose "$purpose"; then
    IFS= read -r -d '' index_rel < <(node "$emitter" "$root" indexPath --null 2>/dev/null) || index_rel=
  fi

  for rel in "${candidates[@]}"; do
    # Present in the repo but absent from the committed worktree = the gate would fail open. The -L guard
    # also skips a pre-existing symlink (a --linked dep, or a broken link) so `ln` never aborts on it.
    [ -e "$root/$rel" ] && [ ! -e "$wt/$rel" ] && [ ! -L "$wt/$rel" ] || continue
    mkdir -p "$wt/$(dirname "$rel")"
    if is_review_projection_purpose "$purpose"; then
      # Ratchet gates may legitimately update ignored baseline/cache state. A review promises the
      # target checkout stays unchanged, so its projections must be private rather than write-through
      # symlinks. -L follows materializer symlinks; -p preserves file modes.
      if [ -n "$index_rel" ] && [ "$rel" = "$index_rel" ]; then
        copy_stable_sqlite_family "$root/$rel" "$wt/$rel" || return 1
      else
        cp -RpL "$root/$rel" "$wt/$rel"
      fi
    else
      ln -s "$root/$rel" "$wt/$rel"
    fi
    linked+=("$rel")
  done

  # Guard the empty array BEFORE expanding it (stock-macOS bash 3.2 aborts on "${arr[@]}" when empty
  # under `set -u`; cf. commit-with-gate-capture.sh).
  [ "${#linked[@]}" -eq 0 ] && return 0
  {
    echo "⚠️  ship: ${#linked[@]} gate config(s) present in the repo but absent from the committed tree —"
    if is_review_projection_purpose "$purpose"; then
      echo "   copied into the isolated review worktree so gates match the target (not defaults):"
    else
      echo "   linked into the gate worktree so gates match a normal commit (not defaults):"
    fi
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
