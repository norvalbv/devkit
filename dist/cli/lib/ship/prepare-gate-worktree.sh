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

# The running CLI's package root. Source runs place this script under cli/lib/ship; published runs
# place it under dist/cli/lib/ship, and packageDir() treats that dist directory as the package root.
gate_package_root() {
  local script_dir package_root
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
  package_root=$(cd "$script_dir/../../.." && pwd) || return 1
  [ -d "$package_root/agents" ] && [ -d "$package_root/skills" ] || return 1
  printf '%s\n' "$package_root"
}

# Refresh only the throwaway ship worktree from the CURRENT running devkit package. The caller's
# synced .claude projection may lag the installed package (sc-1300); trusting it makes a clean ship
# fail closed as "checklist artifact missing" until the shared checkout is manually mutated.
refresh_ship_reviewer_assets() {
  local wt=$1 root=$2 purpose=$3 package_root physical_wt physical_root sub
  physical_wt=$(cd -P "$wt" && pwd) || return 1
  physical_root=$(cd -P "$root" && pwd) || return 1
  [ "$physical_wt" != "$physical_root" ] || {
    echo "devkit ship: refusing to refresh reviewer assets in the caller checkout" >&2
    return 1
  }
  package_root=$(gate_package_root) || {
    echo "devkit ship: running package is missing reviewer agents/skills — reinstall or rebuild devkit" >&2
    return 1
  }

  # .claude itself stays a real worktree-local directory so checklist state files never leak back to
  # the caller. A tracked symlink at the directory boundary is removed as a LEAF before any child is
  # touched, so the refresh cannot traverse into an external/shared target.
  if [ -L "$physical_wt/.claude" ]; then
    rm -f -- "$physical_wt/.claude"
  elif [ -e "$physical_wt/.claude" ] && [ ! -d "$physical_wt/.claude" ]; then
    echo "devkit ship: $physical_wt/.claude is not a directory" >&2
    return 1
  fi
  mkdir -p "$physical_wt/.claude"

  # Capture the exact registered reviewer contract before touching the consumer projection. The
  # runtime helper rejects missing, escaping, non-regular, or concurrently changing package assets,
  # so a stale consumer copy can never impersonate a broken running package. Its destination grammar
  # is intentionally shell-tool-safe; use a fixed /tmp parent rather than inheriting a TMPDIR that
  # may contain spaces (the ship worktree itself remains free to live there).
  local asset_tool script_dir runtime_parent runtime owned name
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
  asset_tool="$script_dir/review/asset-runtime.mts"
  [ -f "$asset_tool" ] || asset_tool="$script_dir/review/asset-runtime.mjs"
  [ -f "$asset_tool" ] || {
    echo "devkit ship: reviewer asset runtime helper is unavailable" >&2
    return 1
  }
  runtime_parent=$(mktemp -d /tmp/devkit-ship-review-assets.XXXXXX) || return 1
  runtime="$runtime_parent/runtime"
  if ! node "$asset_tool" materialize-ship "$package_root" "$runtime" >/dev/null; then
    rm -rf -- "$runtime_parent"
    return 1
  fi

  # Both roots must be real before the first replacement. Following a consumer symlink here could
  # mutate a directory outside the throwaway worktree; accepting a file would produce a partial,
  # misleading projection. Validate the pair first so either failure is all-before-overlay.
  for sub in agents skills; do
    if [ -L "$physical_wt/.claude/$sub" ] ||
      { [ -e "$physical_wt/.claude/$sub" ] && [ ! -d "$physical_wt/.claude/$sub" ]; }; then
      echo "devkit ship: $physical_wt/.claude/$sub must be a real directory" >&2
      rm -rf -- "$runtime_parent"
      return 1
    fi
  done

  for sub in agents skills; do
    mkdir -p "$physical_wt/.claude/$sub"
    owned="$runtime_parent/$sub.owned"
    if ! node "$asset_tool" manifest-owned "$physical_root" "$sub" > "$owned"; then
      rm -rf -- "$runtime_parent"
      return 1
    fi
    while IFS= read -r -d '' name; do
      case $name in
        '' | . | .. | */*)
          echo "devkit ship: unsafe manifest-owned $sub name: $name" >&2
          rm -rf -- "$runtime_parent"
          return 1
          ;;
      esac
    done < "$owned"
  done

  for sub in agents skills; do
    owned="$runtime_parent/$sub.owned"
    if ! node "$asset_tool" project-ship-kind "$physical_wt" "$runtime/$sub" "$owned" "$sub"; then
      rm -rf -- "$runtime_parent"
      return 1
    fi
  done
  rm -rf -- "$runtime_parent"
  echo "  ↳ $purpose: refreshed reviewer agents + skills from running devkit package" >&2
}

# Refresh devkit-MANAGED capability state (.devkit/oxc/*, .devkit/anti-slop/*) in the throwaway ship
# worktree from the CURRENT running devkit package — the same reasoning as its reviewer-asset sibling
# above, one file-set over. The worktree is cut from $BASE, so for `ship --pr` those bytes are the PR
# branch's FORK POINT, while the gates that judge them arrive through the caller's linked node_modules.
# Once a gate-infra change lands on the base, that mismatch makes every re-push to a pre-change branch
# die on "managed Oxlint base manifest digest is stale" regardless of the staged content (sc-2099).
# WORKING TREE ONLY: the helper never touches the index, so ship_assert_staged_unchanged still holds
# byte-exact and the commit (made without `-a`) carries exactly the briefed paths.
refresh_ship_managed_capability() {
  local wt=$1 root=$2 purpose=$3 script_dir tool
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 0
  tool="$script_dir/managed-capability-runtime.mts"
  [ -f "$tool" ] || tool="$script_dir/managed-capability-runtime.mjs"
  [ -f "$tool" ] || {
    echo "  ↳ $purpose: managed capability runtime helper unavailable — skipped" >&2
    return 0
  }
  # Advisory BY CONSTRUCTION, not by oversight: a skip only re-exposes today's behaviour, and the
  # capability gate inside the worktree still runs and still fails closed. Never abort the ship here.
  node "$tool" project "$wt" "$root" || true
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

gate_dependency_preflight_tool() {
  local script_dir tool
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  tool="$script_dir/dependency-preflight.mts"
  [ -f "$tool" ] || tool="$script_dir/dependency-preflight.mjs"
  printf '%s\n' "$tool"
}

gate_dependency_install_remedy() {
  local wt=$1
  if [ -f "$wt/bun.lock" ] || [ -f "$wt/bun.lockb" ]; then
    printf '%s\n' 'bun install --frozen-lockfile'
  elif [ -f "$wt/pnpm-lock.yaml" ]; then
    printf '%s\n' 'pnpm install --frozen-lockfile'
  elif [ -f "$wt/yarn.lock" ]; then
    printf '%s\n' 'yarn install --immutable'
  elif [ -f "$wt/package-lock.json" ] || [ -f "$wt/npm-shrinkwrap.json" ]; then
    printf '%s\n' 'npm ci'
  else
    printf '%s\n' 'install dependencies with this repo'\''s package manager'
  fi
}

# Pick the first available install that satisfies the BASE package.json in the ephemeral worktree.
# "Populated" is only a fast preference: a real but stale install can miss a dependency added by the
# base after that checkout last installed. Try the linked root first, then the main worktree fallback.
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
  echo "devkit ship: no node_modules satisfies the ship base package.json:" >&2
  local rejection path packages
  for rejection in "${rejected[@]}"; do
    path=${rejection%%$'\t'*}
    packages=${rejection#*$'\t'}
    echo "  - $path (missing: $packages)" >&2
  done
  remedy=$(gate_dependency_install_remedy "$wt")
  echo "run \`$remedy\` in the checkout, then retry the same ship command." >&2
  return 2
}

# The pre-commit hook ship will run in the ephemeral worktree. This is the single resolver shared by
# preparation and commit: overlay wins when projected, an explicit core.hooksPath is honoured, an
# unset path falls back to the projected package-mode Husky runner, and Git's default hooks directory
# is the final candidate. Returning a non-executable candidate is intentional — callers fail closed
# with a useful path instead of treating absence as an opt-out.
gate_worktree_pre_commit() {
  local wt=$1 root=${2:-} hooks_path default_hooks_dir
  if [ -n "$root" ] && [ -x "$root/.devkit/hooks/pre-commit" ]; then
    printf '%s\n' "$wt/.devkit/hooks/pre-commit"
    return 0
  fi
  hooks_path=$(git -C "$wt" config --get core.hooksPath 2>/dev/null) || hooks_path=''
  if [ -z "$hooks_path" ]; then
    if [ -e "$wt/.husky/_/pre-commit" ] || [ -L "$wt/.husky/_/pre-commit" ]; then
      printf '%s\n' "$wt/.husky/_/pre-commit"
      return 0
    fi
    default_hooks_dir=$(git -C "$wt" rev-parse --git-path hooks 2>/dev/null) || default_hooks_dir=''
    [ -n "$default_hooks_dir" ] || return 0
    case $default_hooks_dir in
      /*) printf '%s\n' "$default_hooks_dir/pre-commit" ;;
      *) printf '%s\n' "$wt/$default_hooks_dir/pre-commit" ;;
    esac
    return 0
  fi
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

  local link_dirs=(node_modules coverage)
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

  # Project the hook directory git will actually use. Package-mode Husky points at its ignored
  # `.husky/_` runner, while a standalone install deliberately points at the committed `.husky`
  # directory and needs no generated runner. Keep `.husky/_` as the fallback when hooksPath is unset
  # so the existing devkit-install preflight remains fail-closed.
  local hooks_path hook_link_rel
  hooks_path=$(git -C "$wt" config --get core.hooksPath 2>/dev/null) || hooks_path=''
  if [ -z "$hooks_path" ]; then
    hook_link_rel=.husky/_
  elif [[ "$hooks_path" != /* ]]; then
    hook_link_rel=$hooks_path
  else
    hook_link_rel=
  fi
  if [ -n "$hook_link_rel" ]; then
    if [ ! -e "$wt/$hook_link_rel" ] && [ ! -L "$wt/$hook_link_rel" ] &&
      ! gate_link_source "$root" "$main_root" "$hook_link_rel" >/dev/null; then
      echo "missing $hook_link_rel in $root or $main_root — run dependency setup before $purpose (gates must not fail open)" >&2
      return 1
    fi
    # Append after `.devkit`: overlay mode must project the complete directory before its nested
    # hooksPath is considered, rather than materializing only `.devkit/hooks`.
    link_dirs+=("$hook_link_rel")
  fi

  # Announce every link with the source it RESOLVED TO. link-gate-configs.sh, four lines downstream in
  # the same ship, already "print[s] a loud notice so it is never silent"; this was its silent sibling,
  # and that silence is why sc-1243 read as "this repo has no linters installed" instead of "the wrong
  # node_modules got linked".
  local d source dependency_rc
  for d in "${link_dirs[@]}"; do
    if [ "$d" = node_modules ]; then
      if source=$(gate_node_modules_source "$wt" "$root" "$main_root"); then
        :
      else
        dependency_rc=$?
        [ "$dependency_rc" -eq 1 ] && continue
        return 1
      fi
    else
      source=$(gate_link_source "$root" "$main_root" "$d") || continue
    fi
    [ ! -e "$wt/$d" ] && [ ! -L "$wt/$d" ] || continue
    mkdir -p "$wt/$(dirname "$d")"
    ln -s "$source" "$wt/$d"
    echo "  ↳ $purpose: linked $d ← $source" >&2
  done

  # Postcondition, not a second resolution question: a projected hook directory that carries no
  # executable pre-commit shim must never reach `git commit`. The shared resolver includes the
  # hooksPath-unset package-mode fallback, closing the clean-clone fail-open before reviewers run.
  local pre_commit
  pre_commit=$(gate_worktree_pre_commit "$wt" "$root")
  if [ -n "$pre_commit" ] && [ ! -x "$pre_commit" ]; then
    echo "no executable pre-commit hook at $pre_commit — the $purpose worktree would commit with NO gate chain (gates must not fail open)" >&2
    return 1
  fi

  # Reviewer briefs/checklists may be absent, tracked, or ignored projection artifacts. All three
  # states can lag the running package, so refresh every throwaway release-gate worktree instead of
  # trusting the caller copy (or treating its absence as an opt-out). Tag validation shares this
  # preparation helper but does not run the reviewer gate, so keep its minimal worktree unchanged.
  if [ "$purpose" = shipping ]; then
    # `|| return 1` keeps the reviewer refresh FAIL-CLOSED: it used to be the last statement, so its
    # status was this function's, and a bare second call below would silently swallow it.
    refresh_ship_reviewer_assets "$wt" "$root" "$purpose" || return 1
    # `|| true` enforces the advisory contract HERE too, not just inside the callee: a future edit
    # that lets the managed refresh return non-zero must never turn a best-effort projection into a
    # hard gate that aborts the ship under the caller's `set -e`.
    refresh_ship_managed_capability "$wt" "$root" "$purpose" || true
  fi
}

# Preview the governed-line ratchet before creating a gate worktree. Exit 2 means the optional preview is
# unavailable; the authoritative worktree gate still runs. Exit 1 is a proven size violation.
ship_size_preflight() {
  local root=${1:?root} base=${2:?base} size_guard rc
  shift 2
  local script_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  size_guard="$script_dir/../../../gate-engine/ratchets/size-disable.mts"
  [ -f "$size_guard" ] || size_guard="$script_dir/../../../gate-engine/ratchets/size-disable.mjs"
  if [ ! -f "$size_guard" ]; then
    rc=2
  elif (cd "$root" && node "$size_guard" preflight --base "$base" -- "$@"); then
    rc=0
  else
    rc=$?
  fi
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    2) echo "⚠️  ship: guard-size base-aware preflight unavailable — continuing to the authoritative worktree gate" >&2; return 0 ;;
    *) echo "ship: guard-size preflight failed unexpectedly (exit $rc)" >&2; return 1 ;;
  esac
}
