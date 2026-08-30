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

# Devkit config/artifact files the gates read; linked into the throwaway ship/review worktree ($WT)
# because a fresh checkout lacks the untracked/gitignored ones. All bare names (a test pins the exact
# list — no inline comments). The last, .qavis/receipt.json, is the non-obvious one: it's the gitignored
# cache qavis writes on a QA pass, read by the ship qavis-advisory gate to clear its block, and the only
# gate input NOT already carried in by the staged pathspec — so without this link a real QA pass still
# blocks the ship. Linked file-level, not the `.qavis/` dir (which holds the tracked recipe.json).
GATE_PROJECTION_FIXED_CANDIDATES=(
  guard.config.json
  .fallowrc.jsonc
  .fallowrc.json
  fallow.toml
  .fallow.toml
  .fallow
  fallow-baselines
  .decisions
  .devkit/baselines/fanout.json
  .devkit/baselines/size-lines.json
  .devkit/baselines/size.json
  .devkit/baselines/imports.mjs
  .devkit/structure/exempt.mjs
  eslint.config.devkit.mjs
  biome.devkit.jsonc
  .qavis/receipt.json
)

# Candidates that are a content-addressed CACHE, not source. A copy in the base commit is stale by
# construction — the sha it attests cannot cover the set being shipped — so it must lose to the live
# one, or the gate reading it can never be cleared by running the tool (sc-1489).
GATE_PROJECTION_CACHE_CANDIDATES=(
  .qavis/receipt.json
)

# gate_projection_is_stale_cache <worktree> <repo-relative-path>
# A cache candidate the BASE COMMIT put in $WT and that is still there: not a symlink (we placed that),
# not a path change-application already removed (a ship that untracks it), and not one absent from HEAD
# (change-application put those there from the invoking checkout — already the live bytes).
gate_projection_is_stale_cache() {
  local wt=$1 rel=$2 cache
  for cache in "${GATE_PROJECTION_CACHE_CANDIDATES[@]}"; do
    [ "$rel" = "$cache" ] || continue
    [ -L "$wt/$rel" ] && return 1
    [ -f "$wt/$rel" ] || return 1
    git -C "$wt" cat-file -e "HEAD:$rel" 2>/dev/null && return 0
    return 1
  done
  return 1
}

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

is_review_projection_purpose() {
  [ "$1" = review ] || [ "$1" = review-baseline ]
}

# gate_projection_source_is_ignored <consumer-root> <resolved-source> <repo-relative-path>
#
# `git check-ignore <repo-relative-path>` refuses to traverse a symlinked directory inside a
# worktree. Gate inputs deliberately use that shape to share ignored caches from the main worktree,
# so resolve the source's parent physically and ask the worktree that owns those bytes instead.
gate_projection_source_is_ignored() {
  local root=$1 source=$2 rel=$3 physical_parent physical_source owner='' candidate owner_rel
  # The caller may be shipping the ignore rule now while the projected bytes come from an older
  # main-worktree view. Ask it first; a symlink traversal can fail fatally, so keep that probe quiet
  # and let the physical-source-owner fallback below handle the path.
  if git -C "$root" check-ignore -q -- "$rel" 2>/dev/null; then return 0; fi
  if ! physical_parent=$(cd -P "$(dirname "$source")" 2>/dev/null && pwd); then
    git -C "$root" check-ignore -q -- "$rel"
    return
  fi
  physical_source="$physical_parent/$(basename "$source")"
  while IFS= read -r candidate; do
    case "$physical_source" in
      "$candidate"/*)
        [ "${#candidate}" -gt "${#owner}" ] && owner=$candidate
        ;;
    esac
  done < <(
    git -C "$root" worktree list --porcelain 2>/dev/null |
      awk '/^worktree /{print substr($0, 10)}'
  )
  if [ -n "$owner" ]; then
    owner_rel=${physical_source#"$owner"/}
    git -C "$owner" check-ignore -q -- "$owner_rel"
  else
    git -C "$root" check-ignore -q -- "$rel"
  fi
}

# link_untracked_gate_configs <worktree> <root> [purpose]
link_untracked_gate_configs() {
  local wt=$1 root=$2 purpose=${3:-ship} emitter resolved rel line index_rel='' candidate_manifest=''
  local main_root='' candidate_root=$root source='' stale_hit=''
  local projection_manifest=${DEVKIT_REVIEW_PROJECTION_MANIFEST:-} projection_tool=''
  local linked=() linked_sources=() candidates=() stale=()
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
  # .devkit/baselines/*.json: the ratchet freezes (fanout/size/size-lines). OVERLAY hides .devkit via
  # .git/info/exclude (overlay.mts) yet init freezes into it, so it is untracked → absent here. Without
  # it the fanout gate does NOT fail open (that needs guard.config.json absent too, and we just linked
  # it) — it enforces against an EMPTY freeze and every grandfathered folder reads as new growth.
  # ship-gates-converge-not-restart (2026-07-07) already records this link as a dependency: the
  # prefix-cache fingerprint folds in the baseline files and needs real state here. Each file is a
  # candidate so a tracked freeze cannot hide an untracked sibling from the gate worktree.
  # Legacy eslint/baselines files are added individually below until every consumer has migrated.
  # Config-driven paths (indexPath / allowlistPath) from the resolver. .mts in source, built .mjs in an
  # installed consumer (the reconcile-manifest-write.mts dual-ext idiom). A resolver failure (unparseable
  # guard.config.json → resolveGuardConfig throws) is non-fatal: warn, keep the hardcoded set, and let
  # the worktree gate fail loud on the same bad config.
  emitter=$(gate_config_path_emitter)
  if is_review_projection_purpose "$purpose"; then
    candidates=("${GATE_PROJECTION_FIXED_CANDIDATES[@]}")
    candidate_manifest=$(mktemp "${DEVKIT_REVIEW_TEMP_ROOT:-${TMPDIR:-/tmp}}/devkit-review-gate-candidates.XXXXXX") || return 1
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
    main_root=$(gate_main_worktree "$root")
    # A linked worktree may lack the untracked guard.config.json that defines indexPath,
    # allowlistPath, and decisionsDir. Resolve that config first so the main-worktree fallback also
    # discovers its config-driven candidates; each candidate still resolves root-first below.
    if source=$(gate_link_source "$root" "$main_root" guard.config.json); then
      candidate_root=$(dirname "$source")
    fi
    if resolved=$(node "$emitter" "$candidate_root" 2>/dev/null); then
      while IFS= read -r line; do [ -n "$line" ] && candidates+=("$line"); done <<< "$resolved"
    else
      echo "⚠️  ship: could not resolve config gate paths (guard.config.json unreadable?) — linking known defaults only" >&2
    fi
  fi
  # Structure debt is one module per configured tree. Enumerate files rather than projecting the
  # directory atomically so a tracked tree cannot hide an untracked sibling in overlay consumers.
  for candidate_source_root in "$root" "${main_root:-$root}"; do
    for baseline in "$candidate_source_root"/.devkit/baselines/structure/*.mjs; do
      [ -e "$baseline" ] || continue
      rel=${baseline#"$candidate_source_root"/}
      candidates+=("$rel")
    done
  done
  # Legacy overlay baselines remain readable until init/upgrade migrates them. Project each local
  # file independently; never pull an atomic directory (or a stale primary-checkout fallback) over
  # canonical .devkit state in the shipping checkout.
  for baseline in "$root"/eslint/baselines/*.json "$root"/eslint/baselines/*.mjs; do
    [ -e "$baseline" ] || continue
    rel=${baseline#"$root"/}
    candidates+=("$rel")
  done
  if is_review_projection_purpose "$purpose"; then
    IFS= read -r -d '' index_rel < <(node "$emitter" "$root" indexPath --null 2>/dev/null) || index_rel=
    [ -n "$projection_manifest" ] || {
      echo "devkit review: private gate projection manifest path is unavailable" >&2
      return 1
    }
    projection_tool=${DEVKIT_REVIEW_PROJECTION_TOOL:-}
    if [ -z "$projection_tool" ]; then
      projection_tool="$(dirname "${BASH_SOURCE[0]}")/review/projection/runtime.mts"
      [ -f "$projection_tool" ] || projection_tool="$(dirname "${BASH_SOURCE[0]}")/review/projection/runtime.mjs"
    fi
    [ -f "$projection_tool" ] || {
      echo "devkit review: private gate projection helper is unavailable" >&2
      return 1
    }

    for rel in "${candidates[@]}"; do
      [ -e "$root/$rel" ] && [ ! -e "$wt/$rel" ] && [ ! -L "$wt/$rel" ] || continue
      linked+=("$rel")
      linked_sources+=("$root/$rel")
    done
    {
      if [ "${#linked[@]}" -gt 0 ]; then
        for rel in "${linked[@]}"; do printf '%s\0' "$rel"; done
      fi
    } | node "$projection_tool" materialize "$root" "$wt" "$projection_manifest" "$index_rel" || return 1
  else
    for rel in "${candidates[@]}"; do
      # Present in the repo but absent from the committed worktree = the gate would fail open. The
      # -L guard also skips a pre-existing symlink so `ln` never aborts on it. Empty local projection
      # dirs are unusable, so a populated main-worktree copy wins; files keep root-first precedence.
      # Recorded BEFORE the source lookup so the diagnostic still prints when the operator's checkout
      # has no live copy to link. A stale cache never enters `linked`: it is present in the committed
      # tree, so that notice's wording and count would both be wrong for it.
      stale_hit=
      if gate_projection_is_stale_cache "$wt" "$rel"; then
        rm -f "$wt/$rel"   # worktree only; the shipped commit is asserted unchanged by this file's test
        stale+=("$rel")
        stale_hit=1
      fi
      source=$(gate_link_source "$root" "$main_root" "$rel" prefer-populated) || continue
      if [ -z "$stale_hit" ]; then
        [ ! -e "$wt/$rel" ] && [ ! -L "$wt/$rel" ] || continue
        linked+=("$rel")
        linked_sources+=("$source")
      fi
      mkdir -p "$wt/$(dirname "$rel")"
      ln -s "$source" "$wt/$rel"
    done
  fi

  if [ "${#stale[@]}" -gt 0 ]; then
    {
      echo "⚠️  ship: ${#stale[@]} gate cache(s) are COMMITTED, so the base checkout carried a stale copy"
      echo "   into the gate worktree — the live one was used instead. These are content-addressed: a"
      echo "   committed copy can never match the set being shipped. Untrack them and LAND it on the"
      echo "   base, or every ship repeats this. Use \`git rm\`, NOT \`--cached\` — a file left on disk"
      echo "   stages no deletion. Ship BOTH paths, ideally on their own so no QA gate is in the way:"
      for rel in "${stale[@]}"; do
        echo "   - git rm $rel && printf '%s\\n' '$rel' >> .gitignore"
      done
    } >&2
  fi

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
    local linked_index=0
    for rel in "${linked[@]}"; do
      # `check-ignore -q` inside the `if` → its exit-1 "not ignored" is errexit-safe.
      if gate_projection_source_is_ignored "$root" "${linked_sources[$linked_index]}" "$rel"; then
        echo "   - $rel (gitignored cache — normal)"
      else
        echo "   - $rel (untracked — commit it so gates are consistent for everyone)"
      fi
      linked_index=$((linked_index + 1))
    done
  } >&2
  return 0
}
