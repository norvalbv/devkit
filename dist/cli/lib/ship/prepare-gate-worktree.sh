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

# Does this candidate hold anything a gate could actually USE? A linked worktree that has merely RUN
# vitest owns a node_modules containing only caches (`.vite`, `.vite-temp`) — no packages, no `.bin`.
# It EXISTS, so an existence-only preference picked it over the main checkout's complete one and every
# bare-binary package.json script in the ephemeral worktree died with 127 (sc-1243).
#
# A non-directory (a plain file, or a DANGLING symlink) answers no, so the existence tail below keeps
# deciding those exactly as it does today.
#
# `find` rather than a `for f in "$p"/*` glob on purpose: this file is SOURCED, so it must not mutate
# the caller's shell options — and therefore inherits them. A glob scan silently inverts under an
# inherited `dotglob`/`GLOBIGNORE` (cache-only reads as populated) or `set -f` (a real install reads
# as empty). One fork per dir is nothing next to the `git worktree add` this follows.
gate_dir_is_populated() {
  local path=$1 first
  [ -d "$path" ] || return 1
  [ -e "$path/.bin" ] && return 0   # an installed node_modules, even if every package is dot-named
  first=$(find "$path" -mindepth 1 -maxdepth 1 ! -name '.*' -print -quit 2>/dev/null) || first=''
  [ -n "$first" ]
}

# Which dirs get the populated-preference by default. Callers resolving cache/config projections may
# opt other directories in explicitly; plain files still use the existence preference below.
#
# Deliberately NOT everything gate_link_source resolves:
#
#   coverage  — an empty/`.tmp`-only local coverage/ must stay linked AS IS so the fail-CLOSED coverage
#               gate finds no coverage-final.json and blocks. Borrowing the main worktree's artifact
#               would pass the gate on coverage computed from another branch's source — decision
#               coverage-gate.md Rejected (b), "silently ships unverified coverage, the exact defect".
#   --link    — documented as "link THIS dir" (ship-branch.sh usage), an explicit instruction rather
#               than a pair of candidates to choose between.
#   .devkit   — overlay's own tree, already validated at its source by the executable-hook check below.
gate_prefers_populated() {
  case $1 in
    node_modules | .husky/_) return 0 ;;
    *) return 1 ;;
  esac
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
# Resolving `$root` first keeps a worktree that HAS its own copy (or a deliberate override) winning —
# but for the dirs above, "has its own copy" now means a USABLE one, not merely a present one.
#
# Pass `prefer-populated` as the optional fourth argument for any other directory where an empty local
# copy is unusable. The existence tail is kept rather than replaced: when NEITHER candidate is
# populated the resolution is byte-for-byte what it always was, so this can introduce no new failure
# mode. That also means the predicate is never load-bearing for a fail-closed guarantee — see the hook
# postcondition below.
gate_link_source() {
  local root=$1 main_root=$2 rel=$3 populated_preference=${4:-}
  if [ "$populated_preference" = prefer-populated ] || gate_prefers_populated "$rel"; then
    if gate_dir_is_populated "$root/$rel"; then printf '%s\n' "$root/$rel"; return 0; fi
    if gate_dir_is_populated "$main_root/$rel"; then printf '%s\n' "$main_root/$rel"; return 0; fi
  fi
  [ -e "$root/$rel" ] && { printf '%s\n' "$root/$rel"; return 0; }
  [ -e "$main_root/$rel" ] && { printf '%s\n' "$main_root/$rel"; return 0; }
  return 1
}

# The hook git will ACTUALLY run in the ephemeral worktree, or '' when nothing is configured.
# Resolved, never hardcoded: husky points core.hooksPath at `.husky/_`, an overlay install points it
# at `.devkit/hooks` (overlay.mts), and it may be unset entirely.
gate_worktree_pre_commit() {
  local wt=$1 hooks_path
  hooks_path=$(git -C "$wt" config --get core.hooksPath 2>/dev/null) || hooks_path=''
  [ -n "$hooks_path" ] || return 0
  case $hooks_path in
    /*) printf '%s\n' "$hooks_path/pre-commit" ;;
    *) printf '%s\n' "$wt/$hooks_path/pre-commit" ;;
  esac
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

  # Announce every link with the source it RESOLVED TO. link-gate-configs.sh, four lines downstream in
  # the same ship, already "print[s] a loud notice so it is never silent"; this was its silent sibling,
  # and that silence is why sc-1243 read as "this repo has no linters installed" instead of "the wrong
  # node_modules got linked".
  local d source
  for d in "${link_dirs[@]}"; do
    source=$(gate_link_source "$root" "$main_root" "$d") || continue
    [ ! -e "$wt/$d" ] && [ ! -L "$wt/$d" ] || continue
    mkdir -p "$wt/$(dirname "$d")"
    ln -s "$source" "$wt/$d"
    echo "  ↳ $purpose: linked $d ← $source" >&2
  done

  # Postcondition, not a resolution question: a `.husky/_` that is populated but carries no pre-commit
  # shim passes every test above, and the ship then commits and opens a PR with ZERO gates — the exact
  # fail-open the .husky/_ preflight exists to prevent. Skipped when no hooksPath is configured, which
  # leaves that case exactly as it was.
  local pre_commit
  pre_commit=$(gate_worktree_pre_commit "$wt")
  if [ -n "$pre_commit" ] && [ ! -x "$pre_commit" ]; then
    echo "no executable pre-commit hook at $pre_commit — the $purpose worktree would commit with NO gate chain (gates must not fail open)" >&2
    return 1
  fi

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
