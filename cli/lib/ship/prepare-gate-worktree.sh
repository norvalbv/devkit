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
#   coverage  — never reaches gate_link_source: gate_coverage_source resolves it from the consumer root
#               only. An empty/`.tmp`-only local coverage/ must stay linked AS IS so the fail-CLOSED coverage
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
# on `.husky/_` even when the repo is perfectly set up, and silently drops node_modules —
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

# sc-1292: rebase linked coverage keys onto THIS worktree so fallow CRAP joins measured coverage.
# Advisory: any failure keeps the link, and this always returns 0 under the caller's errexit.
gate_rebase_coverage() {
  local wt=$1 source=$2 purpose=$3 script_dir tool root
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  tool="$script_dir/coverage/coverage-rebase.mts"
  [ -f "$tool" ] || tool="$script_dir/coverage/coverage-rebase.mjs"
  [ -f "$tool" ] || return 0
  root=$(node "$tool" "$wt" "$source") || root=''
  if [ -n "$root" ]; then
    echo "  ↳ $purpose: rebased coverage keys from $root onto the worktree (fallow CRAP reads measured coverage)" >&2
  fi
  return 0
}

# The coverage artifact has worktree identity, so it comes from the consumer root ONLY — never the
# gate_link_source main-worktree tail (sc-3491). That tail is right for node_modules, whose bytes do
# not depend on the branch; coverage-final.json is computed FROM the branch, and the main checkout's
# copy is one every parallel worktree would share and any agent could overwrite. Absent here → not
# linked → the fail-CLOSED gate blocks with its own remedy (decision coverage-gate.md Target +
# Rejected (b)). A dangling link is absent too.
#
# A root whose coverage/ an operator symlinked into the main checkout by hand is linked as asked, but
# loudly: the gate is about to judge another tree's numbers. "Into the main checkout" is decided
# physically (`pwd -P`) against BOTH main's lexical coverage/ and wherever main's coverage/ itself
# resolves — main's copy may be a symlink too, and `pwd -P` follows the whole chain out of main. The
# caller may also name the main checkout through an alias (macOS /var → /private/var), which must not
# read as "a linked worktree borrowing main".
#
# <rel> is a normalized path whose first component is `coverage` (gate_normalize_rel).
gate_coverage_source() {
  local root=$1 main_root=$2 rel=${3:-coverage} real_root real_main real_main_cov real_cov
  [ -e "$root/$rel" ] || return 1
  real_root=$(cd -P "$root" 2>/dev/null && pwd) || real_root=$root
  real_main=$(cd -P "$main_root" 2>/dev/null && pwd) || real_main=$main_root
  real_main_cov=$(cd -P "$main_root/coverage" 2>/dev/null && pwd) || real_main_cov=
  if [ "$real_root" != "$real_main" ] && real_cov=$(cd -P "$root/$rel" 2>/dev/null && pwd); then
    case "$real_cov/" in
      "$real_main/coverage/"* | "${real_main_cov:-/nonexistent-main-coverage}/"*)
        echo "  ⚠️  $root/$rel/ is the MAIN checkout's ($real_cov), not this worktree's — the coverage" >&2
        echo "     gate will judge another tree's numbers. Remove the link and run \`devkit coverage-run\` here." >&2
        ;;
    esac
  fi
  printf '%s\n' "$root/$rel"
}

# Lexically normalize a relative link path: drop empty and `.` components, fold `..` (an unmatched one
# is kept). Every `--link` spelling of the coverage dir (`./coverage`, `coverage/`, `x/../coverage`)
# must classify as coverage, or it would slip back onto gate_link_source's main-worktree tail. Only
# `/` separates — no `read`, which stops at a newline — and the result is printed WITHOUT a trailing
# newline so a name ending in one survives the caller's sentinel-guarded capture. Pure string work:
# no filesystem, no caller shell options touched (this file is SOURCED).
gate_normalize_rel() {
  local rest=$1 part more=1 joined='' seg
  local -a out=()
  while [ "$more" -eq 1 ]; do
    case $rest in
      */*) part=${rest%%/*}; rest=${rest#*/} ;;
      *) part=$rest; more=0 ;;
    esac
    case $part in
      '' | .) ;;
      ..)
        if [ "${#out[@]}" -gt 0 ] && [ "${out[${#out[@]}-1]}" != .. ]; then
          out=("${out[@]:0:${#out[@]}-1}")
        else
          out+=(..)   # escapes the root: kept, so `../coverage` never reads as the root's own
        fi
        ;;
      *) out+=("$part") ;;
    esac
  done
  for seg in ${out[@]+"${out[@]}"}; do joined=${joined:+$joined/}$seg; done
  printf '%s' "$joined"
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

# The linked install is the ENGINE the worktree hook runs. One older than `.devkit/baselines`
# (< 0.53.0) misjudges every grandfathered ratchet entry in a repo that stores baselines there, so
# stop before any commit with the remedy (sc-1934). Exit 2 or a missing helper is a diagnostic that
# could not run: say so and continue — the worktree gate still decides. Errexit-safe: every status
# is mapped inside this function.
gate_baseline_reader_preflight() {
  local wt=$1 root=$2 node_modules=$3 script_dir tool rc
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  tool="$script_dir/preflight/baseline-reader.mts"
  [ -f "$tool" ] || tool="$script_dir/preflight/baseline-reader.mjs"
  [ -f "$tool" ] || return 0
  if node "$tool" "$wt" "$root" "$node_modules"; then
    rc=0
  else
    rc=$?
  fi
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) echo "⚠️  ship: baseline reader preflight unavailable (exit $rc) — continuing to the worktree gate" >&2; return 0 ;;
  esac
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
gate_overlay_mode() {
  grep -Eq '"overlay"[[:space:]]*:[[:space:]]*true' "$1/.devkit/config.json" 2>/dev/null
}

# The hook directory git will actually use, relative to the checkout <dir>; empty when hooksPath is
# absolute (a global hooks dir is never projected). Package-mode Husky points at its ignored `.husky/_`
# runner, while a standalone install deliberately points at the committed `.husky` directory and needs
# no generated runner. `.husky/_` is the fallback when hooksPath is unset so the devkit-install
# preflight stays fail-closed. Pass `inherited` to answer for a worktree not yet created: it gets every
# scope EXCEPT <dir>'s own config.worktree (extensions.worktreeConfig), so that scope is skipped.
gate_hook_link_rel() {
  local hooks_path
  if [ "${2:-}" = inherited ]; then
    hooks_path=$(git -C "$1" config --show-scope --get-all core.hooksPath 2>/dev/null |
      awk -F'\t' '$1 != "worktree" { v = substr($0, length($1) + 2) } END { print v }') || hooks_path=''
  else
    hooks_path=$(git -C "$1" config --get core.hooksPath 2>/dev/null) || hooks_path=''
  fi
  if [ -z "$hooks_path" ]; then
    printf '%s\n' .husky/_
  elif [[ "$hooks_path" != /* ]]; then
    printf '%s\n' "$hooks_path"
  fi
}

# Can a gate worktree for <root> get a hook chain? Read-only, so ship runs it BEFORE it creates a branch
# or worktree (sc-3883): run inside prepare_gate_worktree alone, an uninitialised repo learned of this
# only after `git worktree add -b` — one wasted attempt, plus a branch created and deleted again.
#
# <base> is the commit the worktree will check out: a standalone hook dir committed there counts even
# when the caller's own checkout lacks it. Pass '' once <wt> exists — it then answers for itself.
gate_hook_source_preflight() {
  local root=$1 base=$2 purpose=$3 wt=${4:-}
  # Overlay mode stores its complete hook chain under ignored .devkit/hooks. An absent executable hook
  # is a dark gate, so fail closed.
  if gate_overlay_mode "$root" && [ ! -x "$root/.devkit/hooks/pre-commit" ]; then
    echo "overlay mode but $root/.devkit/hooks/pre-commit missing/non-executable — run 'devkit init --overlay' (gates must not fail open)" >&2
    return 1
  fi
  local rel main_root
  if [ -n "$wt" ]; then rel=$(gate_hook_link_rel "$wt"); else rel=$(gate_hook_link_rel "$root" inherited); fi
  [ -n "$rel" ] || return 0
  if [ -n "$wt" ] && { [ -e "$wt/$rel" ] || [ -L "$wt/$rel" ]; }; then return 0; fi
  main_root=$(gate_main_worktree "$root")
  gate_link_source "$root" "$main_root" "$rel" >/dev/null && return 0
  if [ -n "$base" ] && git -C "$root" cat-file -e "$base:$rel" 2>/dev/null; then return 0; fi
  echo "missing $rel in $root or $main_root — run dependency setup before $purpose (gates must not fail open)" >&2
  # .devkit/config.json, not .devkit/: ship itself writes .devkit/ship-intent-* into any repo.
  if [ ! -f "$root/.devkit/config.json" ] && [ ! -f "$main_root/.devkit/config.json" ]; then
    echo "  this repo has not been initialised with devkit — run \`devkit init\` first, then re-run" >&2
  fi
  return 1
}

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

  # The worktree exists now, so it answers for itself; BASE is not consulted (it is what $wt holds).
  gate_hook_source_preflight "$root" '' "$purpose" "$wt" || return 1
  gate_overlay_mode "$root" && link_dirs+=(.devkit)

  local main_root hook_link_rel
  main_root=$(gate_main_worktree "$root")
  hook_link_rel=$(gate_hook_link_rel "$wt")
  # Append after `.devkit`: overlay mode must project the complete directory before its nested
  # hooksPath is considered, rather than materializing only `.devkit/hooks`.
  [ -z "$hook_link_rel" ] || link_dirs+=("$hook_link_rel")

  # Announce every link with the source it RESOLVED TO. link-gate-configs.sh, four lines downstream in
  # the same ship, already "print[s] a loud notice so it is never silent"; this was its silent sibling,
  # and that silence is why sc-1243 read as "this repo has no linters installed" instead of "the wrong
  # node_modules got linked".
  local d rel source dependency_rc
  for d in "${link_dirs[@]}"; do
    if [ "$d" = node_modules ]; then
      if source=$(gate_node_modules_source "$wt" "$root" "$main_root"); then
        gate_baseline_reader_preflight "$wt" "$root" "$source" || return 1
      else
        dependency_rc=$?
        [ "$dependency_rc" -eq 1 ] && continue
        return 1
      fi
    else
      rel=$(gate_normalize_rel "$d" && printf .) && rel=${rel%.}
      case "$d" in /*) rel= ;; esac
      if [ "$rel" = coverage ] || [[ "$rel" == coverage/* ]]; then
        source=$(gate_coverage_source "$root" "$main_root" "$rel" && printf .) || continue
        d=$rel
      else
        source=$(gate_link_source "$root" "$main_root" "$d" && printf .) || continue
      fi
      # The `.` sentinel keeps `$(…)` from eating a trailing newline that belongs to the path itself.
      source=${source%.}
      source=${source%$'\n'}
    fi
    [ ! -e "$wt/$d" ] && [ ! -L "$wt/$d" ] || continue
    mkdir -p "$wt/$(dirname "$d")"
    ln -s "$source" "$wt/$d"
    echo "  ↳ $purpose: linked $d ← $source" >&2
    if [ "$d" = coverage ]; then gate_rebase_coverage "$wt" "$source" "$purpose"; fi
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

# Report whether the configured judges' provider will answer, BEFORE the deterministic chain is paid
# (sc-2538: a six-day quota lock was discovered only after the whole chain ran green and 16 judge
# spawns failed). ADVISORY ONLY — it never returns non-zero, because guard-review can legitimately
# exit 0 with ZERO judge spawns when every reviewer is a cache hit, so a dark provider does not imply
# a doomed ship (docs/decisions/ship-gates-converge-not-restart.md). Every tolerated code is mapped
# to 0 INSIDE this function: the call site is bare under `set -euo pipefail`, and
# docs/decisions/fail-open-needs-an-errexit-safe-call.md records what happens when it is not.
ship_judge_preflight() {
  local root=${1:?root} tool rc
  local script_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  tool="$script_dir/preflight/judge.mts"
  [ -f "$tool" ] || tool="$script_dir/preflight/judge.mjs"
  # A package built without this tool is not a reason to say anything at all.
  [ -f "$tool" ] || return 0
  if (cd "$root" && node "$tool" "$root"); then
    rc=0
  else
    rc=$?
  fi
  # 0 = reported, 2 = could not run, anything else = a defect in a check that may never block a ship.
  case "$rc" in
    0 | 2) return 0 ;;
    *) echo "⚠️  ship: judge preflight failed unexpectedly (exit $rc) — continuing; the reviewer gate still decides" >&2; return 0 ;;
  esac
}

# Preview the raw-line ratchet before creating a gate worktree. Exit 2 means the optional preview is
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
