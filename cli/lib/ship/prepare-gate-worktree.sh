#!/usr/bin/env bash
# Shared ephemeral-worktree preparation for ship, reship, and review. Links only gate runtime
# dependencies that are absent from a clean checkout; caller-owned snapshot content must be staged
# before this runs so a dependency symlink can never enter the reviewed/committed diff.

materialize_private_review_dependencies() {
  local wt=$1 root=$2 purpose=${3:-review} manifest=${DEVKIT_REVIEW_DEPENDENCY_MANIFEST:-} tool
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
  if [ "$purpose" = review-baseline ]; then
    node "$tool" materialize "$root" "$wt" "$manifest" baseline
  else
    node "$tool" materialize "$root" "$wt" "$manifest"
  fi
}

# The repo's MAIN worktree — `git worktree list` reports it first, by definition.
gate_main_worktree() {
  local root=$1 main
  main=$(git -C "$root" worktree list --porcelain 2>/dev/null |
    awk '/^worktree /{print substr($0, 10); exit}')
  printf '%s\n' "${main:-$root}"
}

# Where a gate dependency actually lives: this checkout first, then the main worktree.
#
# WHY the fallback: every dir we link is GITIGNORED, so `git worktree add` never brings it across —
# and the consumer root can itself be a linked worktree. That is not an edge case, it is devkit's
# stated premise (ship-branch.sh: "parallel agents share one working tree"), and it is what any tool
# that spawns per-task worktrees produces. Without this, shipping from such a worktree fails closed
# on `.husky/_` even when the repo is perfectly set up, and silently drops node_modules/coverage —
# turning a correct repo into "run dependency setup", which is not the user's bug to fix.
#
# Resolving `$root` first keeps a worktree that HAS its own copy (or a deliberate override) winning.
gate_link_source() {
  local root=$1 main_root=$2 rel=$3
  [ -e "$root/$rel" ] && { printf '%s\n' "$root/$rel"; return 0; }
  [ -e "$main_root/$rel" ] && { printf '%s\n' "$main_root/$rel"; return 0; }
  return 1
}

# prepare_gate_worktree <worktree> <consumer-root> <purpose> [extra-link-dir...]
prepare_gate_worktree() {
  local wt=$1 root=$2 purpose=$3
  shift 3
  # Review mode materializes private dependency bytes (dependency-runtime.mts) and returns early — its
  # frozen setup/asset runtimes own hooks/briefs, so no target-owned setup path is linked through this
  # helper. Ship/reship instead links node_modules plus `coverage` (the gitignored
  # coverage/coverage-final.json artifact the coverage gate reads) so the gate can verify it inside the
  # worktree; absent in $root → not linked (the loop below skips missing dirs) → the coverage gate
  # fails hard, exactly as intended.
  local review_runtime=0
  case "$purpose" in
    review | review-baseline) review_runtime=1 ;;
  esac
  if [ "$review_runtime" -eq 1 ]; then
    materialize_private_review_dependencies "$wt" "$root" "$purpose"
    return $?
  fi

  local link_dirs=(.husky/_ node_modules coverage)
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

  local main_root
  main_root=$(gate_main_worktree "$root")

  # Every devkit install uses Husky's generated runner, including overlay installs (their own hook
  # chains to the repo hook). Missing runner = `git hook run`/commit silently has no real chain.
  if ! gate_link_source "$root" "$main_root" .husky/_ >/dev/null; then
    echo "missing .husky/_ in $root or $main_root — run dependency setup before $purpose (gates must not fail open)" >&2
    return 1
  fi

  local d source
  for d in "${link_dirs[@]}"; do
    source=$(gate_link_source "$root" "$main_root" "$d") || continue
    [ ! -e "$wt/$d" ] && [ ! -L "$wt/$d" ] || continue
    mkdir -p "$wt/$(dirname "$d")"
    ln -s "$source" "$wt/$d"
  done

  # Reviewer briefs/checklists may be ignored projection artifacts. Link only their subdirectories:
  # checklist state files written directly under .claude stay isolated in the ephemeral worktree.
  if [ -d "$root/.claude/agents" ] || [ -d "$root/.claude/skills" ]; then
    mkdir -p "$wt/.claude"
    local sub
    for sub in agents skills; do
      if [ -e "$root/.claude/$sub" ] && [ ! -e "$wt/.claude/$sub" ]; then
        ln -s "$root/.claude/$sub" "$wt/.claude/$sub"
      fi
    done
  fi
}
