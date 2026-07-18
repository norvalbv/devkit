#!/usr/bin/env bash
# Shared ephemeral-worktree preparation for ship, reship, and review. Links only gate runtime
# dependencies that are absent from a clean checkout; caller-owned snapshot content must be staged
# before this runs so a dependency symlink can never enter the reviewed/committed diff.

materialize_private_review_dependencies() {
  local wt=$1 root=$2 manifest=${DEVKIT_REVIEW_DEPENDENCY_MANIFEST:-} tool
  [ -n "$manifest" ] || {
    echo "devkit review: private dependency manifest path is unavailable" >&2
    return 1
  }
  tool=${DEVKIT_REVIEW_DEPENDENCY_TOOL:-}
  if [ -z "$tool" ]; then
    local script_dir
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    tool="$script_dir/review/dependency-runtime.mts"
    [ -f "$tool" ] || tool="$script_dir/review/dependency-runtime.mjs"
  fi
  [ -f "$tool" ] || {
    echo "devkit review: private dependency runtime helper is unavailable" >&2
    return 1
  }
  node "$tool" materialize "$root" "$wt" "$manifest"
}

# prepare_gate_worktree <worktree> <consumer-root> <purpose> [extra-link-dir...]
prepare_gate_worktree() {
  local wt=$1 root=$2 purpose=$3
  shift 3
  # Review mode materializes private dependency bytes (dependency-runtime.mts) instead of linking the
  # target's node_modules, so node_modules is linked for ship/reship only. `coverage` (the gitignored
  # coverage/coverage-final.json artifact the coverage gate reads) is linked in every mode so the gate
  # can verify it inside the worktree; absent in $root → not linked (the loop below skips missing dirs)
  # → the coverage gate fails hard, exactly as intended.
  local review_runtime=0
  case "$purpose" in
    review | review-baseline) review_runtime=1 ;;
  esac
  local link_dirs=(.husky/_ coverage)
  [ "$review_runtime" -eq 1 ] || link_dirs+=(node_modules)
  [ "$#" -gt 0 ] && link_dirs+=("$@")

  # Overlay mode stores its complete hook chain under ignored .devkit/hooks. It must be linked and
  # selected explicitly by the caller; an absent executable hook is a dark gate, so fail closed.
  if grep -Eq '"overlay"[[:space:]]*:[[:space:]]*true' "$root/.devkit/config.json" 2>/dev/null; then
    [ -x "$root/.devkit/hooks/pre-commit" ] || {
      echo "overlay mode but $root/.devkit/hooks/pre-commit missing/non-executable — run 'devkit init --overlay' (gates must not fail open)" >&2
      return 1
    }
    link_dirs+=(.devkit)
  fi

  # Every devkit install uses Husky's generated runner, including overlay installs (their own hook
  # chains to the repo hook). Missing runner = `git hook run`/commit silently has no real chain.
  if [ ! -e "$root/.husky/_" ]; then
    echo "missing $root/.husky/_ — run dependency setup before $purpose (gates must not fail open)" >&2
    return 1
  fi

  local d
  for d in "${link_dirs[@]}"; do
    [ -e "$root/$d" ] || continue
    [ ! -e "$wt/$d" ] && [ ! -L "$wt/$d" ] || continue
    mkdir -p "$wt/$(dirname "$d")"
    ln -s "$root/$d" "$wt/$d"
  done

  [ "$review_runtime" -eq 0 ] || materialize_private_review_dependencies "$wt" "$root" || return 1

  # Reviewer briefs/checklists may be ignored projection artifacts. Link only their subdirectories:
  # checklist state files written directly under .claude stay isolated in the ephemeral worktree.
  if [ "$review_runtime" -eq 0 ] && { [ -d "$root/.claude/agents" ] || [ -d "$root/.claude/skills" ]; }; then
    mkdir -p "$wt/.claude"
    local sub
    for sub in agents skills; do
      if [ -e "$root/.claude/$sub" ] && [ ! -e "$wt/.claude/$sub" ]; then
        ln -s "$root/.claude/$sub" "$wt/.claude/$sub"
      fi
    done
  fi
}
