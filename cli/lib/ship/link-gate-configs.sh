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
# The paths come from the gate-input registry (gate-engine/deterministic/gate-inputs.mts) through
# gate-config-paths.mts; this file keeps no list of its own.

# gate_projection_is_local_cache <repo-relative-path> <configured-decisionsDir> [local-cache...]
# The registry's local caches (`--local-cache`) are never commit-appropriate, so the linked-input
# notice must not tell anyone to commit one that happens not to be ignored (sc-2274). A configured
# decisionsDir holds source records, so a projected path AT it or CONTAINING it is source-owned and
# wins over the cache names. A decisionsDir that contains the path (`.`) does not: the records sit
# beside `.decisions`, which then holds only the embedding cache.
gate_projection_is_local_cache() {
  local rel=$1 decisions_rel=$2 cache
  shift 2
  if [ -n "$decisions_rel" ]; then
    case "$decisions_rel" in "$rel" | "$rel"/*) return 1 ;; esac
  fi
  for cache in "$@"; do
    [ "$rel" = "$cache" ] && return 0
  done
  return 1
}

# gate_projection_listed <repo-relative-path> [entry...]
gate_projection_listed() {
  local rel=$1 entry
  shift
  for entry in "$@"; do [ "$rel" = "$entry" ] && return 0; done
  return 1
}

# gate_index_has_no_usable_chunks <local-index> <main-index>
# True only when the local index is readable and empty while the main one has usable chunks: a
# schema-only worktree index would otherwise shadow the populated one and the matcher compares nothing.
gate_index_has_no_usable_chunks() {
  local emitter local_n main_n
  emitter=$(gate_config_path_emitter)
  local_n=$(node "$emitter" "$1" --usable-chunks 2>/dev/null) || return 1
  [ "$local_n" = 0 ] || return 1
  main_n=$(node "$emitter" "$2" --usable-chunks 2>/dev/null) || return 1
  case "$main_n" in '' | 0 | *[!0-9]*) return 1 ;; esac
}

gate_config_path_emitter() {
  local self_dir emitter
  self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  emitter="$self_dir/gate-config-paths.mts"
  [ -f "$emitter" ] || emitter="$self_dir/gate-config-paths.mjs"
  printf '%s' "$emitter"
}

# emit_gate_projection_candidates <root>
# NUL-delimited because configured filenames may contain newlines. Fails on an unparseable config.
emit_gate_projection_candidates() {
  node "$(gate_config_path_emitter)" "$1" --null
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
  local wt=$1 root=$2 purpose=${3:-ship} emitter rel line index_rel='' candidate_manifest='' prefix=''
  local main_root='' candidate_root=$root source='' from='' emitted=0 verb=linked
  local projection_manifest=${DEVKIT_REVIEW_PROJECTION_MANIFEST:-} projection_tool=''
  local linked=() linked_sources=() candidates=() root_only=() from_main=()
  case "$purpose" in
    ship | review | review-baseline) ;;
    *)
      echo "devkit: unknown gate-config projection purpose: $purpose" >&2
      return 2
      ;;
  esac
  # Every candidate comes from the gate-input registry. .mts in source, built .mjs in an installed
  # consumer (the reconcile-manifest-write.mts dual-ext idiom).
  emitter=$(gate_config_path_emitter)
  if is_review_projection_purpose "$purpose"; then
    verb=copied
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
  fi
  # A review target may be a package dir inside its checkout: its main-worktree counterpart keeps that
  # subdir. Ship's root is always a top level, so the prefix is empty there.
  prefix=$(git -C "$root" rev-parse --show-prefix 2>/dev/null) || prefix=
  main_root=$(gate_main_worktree "$root")
  [ -z "$prefix" ] || main_root=$main_root/${prefix%/}
  # A linked worktree may lack the untracked guard.config.json that defines indexPath,
  # allowlistPath, and decisionsDir. Resolve that config first so the main-worktree fallback also
  # discovers its config-driven candidates; each candidate still resolves root-first below.
  if source=$(gate_link_source "$root" "$main_root" guard.config.json); then
    candidate_root=$(dirname "$source")
  fi
  candidate_manifest=$(mktemp "${DEVKIT_REVIEW_TEMP_ROOT:-${TMPDIR:-/tmp}}/devkit-gate-candidates.XXXXXX") || return 1
  node "$emitter" "$candidate_root" --null > "$candidate_manifest" 2>/dev/null || emitted=$?
  # share: branch entries resolve from this checkout alone (a linked overlay worktree is projected
  # first): another checkout's copy holds another branch's lint rules and ratchet ceilings.
  [ "$candidate_root" = "$root" ] ||
    node "$emitter" "$root" --each-file --null >> "$candidate_manifest" 2>/dev/null || true
  while IFS= read -r -d '' line; do
    [ -n "$line" ] && candidates+=("$line")
  done < "$candidate_manifest"
  rm -f "$candidate_manifest"
  if is_review_projection_purpose "$purpose" && [ "$emitted" -ne 0 ]; then
    echo "devkit review: could not resolve gate config paths; fix guard.config.json and retry." >&2
    return 1
  fi
  # An unparseable guard.config.json still emits the fixed entries first: they link, and the
  # worktree gate fails loud on the same bad config. No output at all means the registry itself
  # did not load, so every gate would run on defaults.
  [ "$emitted" -eq 0 ] ||
    echo "⚠️  ship: could not resolve config gate paths (guard.config.json unreadable?) — linking known defaults only" >&2
  [ "${#candidates[@]}" -gt 0 ] || {
    echo "✗ $purpose: the gate-input registry emitted nothing ($emitter did not run) — refusing to gate on defaults" >&2
    return 1
  }
  while IFS= read -r -d '' line; do [ -n "$line" ] && root_only+=("$line"); done < <(
    node "$emitter" "$candidate_root" --branch --null 2>/dev/null
  )
  # Review's setup authority already froze these from the target, present or absent.
  if is_review_projection_purpose "$purpose"; then
    while IFS= read -r -d '' line; do [ -n "$line" ] && root_only+=("$line"); done < <(
      node "$projection_tool" setup-owned 2>/dev/null
    )
  fi
  IFS= read -r -d '' index_rel < <(node "$emitter" "$candidate_root" indexPath --null 2>/dev/null) || index_rel=

  for rel in "${candidates[@]}"; do
    # Present in the repo but absent from the committed worktree = the gate would fail open. The
    # -L guard also skips a pre-existing symlink so `ln` never aborts on it. Empty local projection
    # dirs are unusable, so a populated main-worktree copy wins; files keep root-first precedence.
    # A per-file entry can arrive twice: from the config root's list and from this checkout's.
    gate_projection_listed "$rel" ${linked[@]+"${linked[@]}"} && continue
    from=$main_root
    gate_projection_listed "$rel" ${root_only[@]+"${root_only[@]}"} && from=$root
    source=$(gate_link_source "$root" "$from" "$rel" prefer-populated) || continue
    if [ -n "$index_rel" ] && [ "$rel" = "$index_rel" ] && [ "$source" = "$root/$rel" ] &&
      [ "$from" != "$root" ] && gate_index_has_no_usable_chunks "$source" "$from/$rel"; then
      source=$from/$rel
      echo "↳ $purpose: $rel in this checkout has no usable chunks — $verb the main checkout's populated index instead" >&2
    fi
    [ ! -e "$wt/$rel" ] && [ ! -L "$wt/$rel" ] || continue
    linked+=("$rel")
    linked_sources+=("$source")
    if is_review_projection_purpose "$purpose"; then
      if [ "$main_root" != "$root" ] && [ "$source" = "$main_root/$rel" ]; then from_main+=("$rel"); fi
    else
      mkdir -p "$wt/$(dirname "$rel")"
      ln -s "$source" "$wt/$rel"
    fi
  done
  if is_review_projection_purpose "$purpose"; then
    {
      if [ "${#linked[@]}" -gt 0 ]; then
        for rel in "${linked[@]}"; do printf '%s\0' "$rel"; done
      fi
    } | node "$projection_tool" materialize "$root" "$wt" "$projection_manifest" "$index_rel" \
      ${from_main[@]+"${from_main[@]}"} || return 1
  fi

  # Guard the empty array BEFORE expanding it (stock-macOS bash 3.2 aborts on "${arr[@]}" when empty
  # under `set -u`; cf. commit-with-gate-capture.sh).
  [ "${#linked[@]}" -eq 0 ] && return 0
  # Wording only: an unparseable config still emits the fixed local caches, and decisionsDir stays empty.
  local decisions_rel='' local_caches=()
  while IFS= read -r -d '' line; do [ -n "$line" ] && local_caches+=("$line"); done < <(
    node "$emitter" "$candidate_root" --local-cache --null 2>/dev/null
  )
  IFS= read -r -d '' decisions_rel < <(node "$emitter" "$candidate_root" decisionsDir --null 2>/dev/null) || decisions_rel=
  {
    echo "⚠️  ship: ${#linked[@]} gate config(s) present in the repo but absent from the committed tree —"
    if is_review_projection_purpose "$purpose"; then
      echo "   copied into the isolated review worktree so gates match the target (not defaults):"
    else
      echo "   linked into the gate worktree so gates match a normal commit (not defaults):"
    fi
    local linked_index=0 is_cache
    for rel in "${linked[@]}"; do
      is_cache=
      gate_projection_is_local_cache "$rel" "$decisions_rel" ${local_caches[@]+"${local_caches[@]}"} && is_cache=1
      # `check-ignore -q` inside the `if` → its exit-1 "not ignored" is errexit-safe.
      if gate_projection_source_is_ignored "$root" "${linked_sources[$linked_index]}" "$rel"; then
        if [ -n "$is_cache" ]; then
          echo "   - $rel (gitignored cache — normal)"
        else
          echo "   - $rel (ignored by git — local input, linked in)"
        fi
      elif [ -n "$is_cache" ]; then
        echo "   - $rel (local cache — linked in, intentionally not committed)"
      else
        echo "   - $rel (untracked — commit it so gates are consistent for everyone)"
      fi
      linked_index=$((linked_index + 1))
    done
  } >&2
  return 0
}
