/**
 * Assemble the `# devkit-guards` block from a selection, and surgically remove individual pieces
 * without disturbing the consumer's own hook lines outside the markers.
 *
 * The block is COMPOSED from fragments rather than copied from a static template so that
 * `devkit init` can emit exactly the selected guards + the biome step, and the removal
 * path can drop one guard while leaving the rest. Each fragment is delimited by per-piece
 * `# devkit:<id>` / `# /devkit:<id>` sentinels so removal is an exact slice, never a
 * brittle regex against shell prose.
 */

import { markEnd, markStart } from './husky.mts';
import { PLAN_CRITIQUE_SHADOW_FRAGMENT } from './plan-critique-shadow.mts';

/**
 * The block-builder's view of a component selection: whether the biome format step is wanted,
 * the guard ids to emit, and the resolved structure-lint command (absent when structure is off).
 * A superset of every builder's needs — each function reads only the fields relevant to it (the
 * full {@link import('../components.mts').Selection} plus a `structureCmd` satisfies it).
 */
interface HookSelection {
  biome?: boolean;
  guards?: string[];
  structureCmd?: string;
  // Extra arbitrary hard gates folded into the deterministic orchestrator via `--extra "label=cmd"`
  // (any non-zero blocks). Empty/undefined for a normal consumer → no `--extra` emitted, so the
  // fragment is byte-identical to before. Self-host seeds `[{label:'lint',cmd:'bun run lint'}]` to
  // preserve devkit's own hard `biome check .` commit gate.
  extras?: Array<{ label: string; cmd: string }>;
}

// The ONE deterministic line: `guard-deterministic` (gate-engine/deterministic/run.mjs) owns the
// prefix-cache check/record, runs the selected guards (.devkit/config.json components.guards),
// applies the rc trichotomy per gate, and aggregates every failure into one report + one exit
// code — the hook just propagates it. `--structure "<cmd>"` joins the stack-resolved structure
// lint to the same aggregated set (config-driven stacks: `guard-structure gate`; electron:
// `bunx eslint src`). The old hand-rolled DK_PREFIX_SKIP/DK_DET_FAILS shell protocol is gone.
const deterministicFragment = (
  structureCmd?: string,
  extras: Array<{ label: string; cmd: string }> = [],
) => `# devkit:deterministic
echo "🚧 Deterministic gates (aggregated)..."
bunx guard-deterministic --hook "\${DK_HOOK_PATH:-$0}"${structureCmd ? ` --structure "${structureCmd}"` : ''}${extras.map((e) => ` --extra "${e.label}=${e.cmd}"`).join('')} || exit 1
# /devkit:deterministic`;

// The AI-guard fragments, keyed by guard id (GUARD_IDS in components.mjs). AI gates (decisions,
// review) stay FAIL-FAST and OUTSIDE the deterministic orchestrator — an aggregated wall of AI
// findings confuses the fixing agent, so they surface one at a time — and exit 3 (strict ship
// mode failing closed on a judge outage) gets its own remedy, never rendered as a violation.
const GUARD_FRAGMENTS = {
  decisions: `# devkit:guard-decisions
echo "🧭 Decision-log gate..."
ddrc=0
bunx guard-decisions detect --gate || ddrc=$?
if [ "$ddrc" -eq 1 ]; then
    echo "   Record the decision target, or bypass a non-decision: GUARD_NO_LOG=1 git commit ..."
    exit 1
elif [ "$ddrc" -eq 3 ]; then
    echo "   guard-decisions: judge unavailable — strict ship mode failed closed."
    echo "   Check \\\`claude\\\` CLI auth/quota, then re-run devkit ship (cleared judgements are cached)."
    exit 1
elif [ "$ddrc" -ne 0 ] && [ "$ddrc" -ne 2 ]; then
    echo "   guard-decisions: unexpected exit $ddrc — blocking the commit."
    exit 1
fi
# ddrc 0 = clean / staged / routine / bypassed, ddrc 2 = fail-open → continue; any other code blocks.
# /devkit:guard-decisions`,
  review: `# devkit:guard-review
echo "🔍 Reviewer gate (headless domain judges)..."
rrc=0
bunx guard-review --gate || rrc=$?
if [ "$rrc" -eq 1 ]; then
    echo "   A reviewer FAILED (opus-confirmed). Fix the findings above, then re-run."
    exit 1
elif [ "$rrc" -eq 3 ]; then
    echo "   guard-review: judge unavailable after retry — strict ship mode failed closed."
    echo "   Check \\\`claude\\\` CLI auth/quota, then re-run devkit ship (completed verdicts are cached)."
    exit 1
elif [ "$rrc" -ne 0 ] && [ "$rrc" -ne 2 ]; then
    echo "   guard-review: unexpected exit $rrc — blocking the commit."
    exit 1
fi
# rrc 0 = pass/cached/nothing-to-do, rrc 2 = inconclusive (non-strict fail-open) → continue.
# /devkit:guard-review`,
};

// Guard run order: the deterministic orchestrator first (one aggregated report), AI gates last so
// a doomed commit never pays for a judge. Explicit lists — never rely on object-key order.
const DETERMINISTIC_GUARD_IDS = ['size', 'fanout', 'dup', 'clone'];
const AI_GUARD_IDS = ['decisions', 'review'] as const;

// The qavis-advisory gate runs LAST — it's advisory, not a blocker, and cheapest to skip past. It is
// NOT an AI_GUARD (different exit contract: 0 = continue, 3 = strict-ship block, never exit 1), so it
// gets its own fragment + its own remedy line rather than the shared "judge unavailable" copy. All
// the "deserves QA?" logic + the pass-receipt live in qavis; this just shells `qavis route` and maps
// its verdict to an exit code (fail-open when qavis/the bin is absent — the fallow precedent).
const QAVIS_ADVISORY_ID = 'qavis-advisory';
const QAVIS_FRAGMENT = `# devkit:guard-qavis-advisory
qarc=0
bunx guard-qavis-advisory --gate || qarc=$?
[ "$qarc" -eq 3 ] && exit 1
# qarc 0 = continue (SILENT / advisory-only / receipt-cleared / qavis absent); 3 = strict-ship block
# (the remedy — run qavis, or export GUARD_QAVIS_OK=1 — is printed by the bin).
# /devkit:guard-qavis-advisory`;
const standaloneQavisLines = `if command -v guard-qavis-advisory >/dev/null 2>&1; then
    qarc=0; guard-qavis-advisory --gate || qarc=$?
    [ "$qarc" -eq 3 ] && exit 1
fi`;

// Terminal marker for the every-commit telemetry run (run-context.mts contract). A ship's
// ship_result is its terminal, but a plain commit's gates have no wrapper process — so the HOOK
// emits `commit_result` when it exits, and the usage dashboard settles the run immediately
// instead of waiting out a 35-minute quiet window (its fallback for hooks without this fragment).
// The tree hash is computed AT EMIT TIME, not when the trap is armed: the biome fragment restages
// formatted files, and the gates correlate under the POST-format `git write-tree`. Fail-open
// everywhere; same opt-outs as the capture itself (any DEVKIT_NO_TELEMETRY value disables; inside
// a ship DEVKIT_SHIP_ID is set and this stays silent — ship_result is that run's terminal).
// Caveat: claims the shell's single EXIT trap — a consumer hook defining its own EXIT trap after
// this block would replace it (none of devkit's fragments do).
const COMMIT_TERMINAL_FRAGMENT = `# devkit:commit-terminal
if [ -z "\${DEVKIT_SHIP_ID:-}" ] && [ -z "\${DEVKIT_NO_TELEMETRY:-}" ]; then
    __dk_t0="$(date +%s)"
    __dk_esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }
    __dk_commit_result() {
        [ -n "\${__dk_done:-}" ] && return 0
        __dk_done=1
        __dk_tree="$(git write-tree 2>/dev/null)" || return 0
        [ -n "$__dk_tree" ] || return 0
        __dk_events="\${DEVKIT_GATE_EVENTS:-$HOME/.devkit/telemetry/gate-events.jsonl}"
        mkdir -p "$(dirname "$__dk_events")" 2>/dev/null || return 0
        printf '{"type":"commit_result","ship_id":"commit-%s","run_mode":"commit","repo":"%s","branch":"%s","exit_code":%d,"duration_s":%d,"ts":"%s"}\\n' \\
            "$__dk_tree" \\
            "$(__dk_esc "$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")")" \\
            "$(__dk_esc "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)")" \\
            "\${1:-0}" "$(( $(date +%s) - __dk_t0 ))" \\
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$__dk_events" 2>/dev/null || true
    }
    trap '__dk_commit_result "$?"' EXIT
fi
# /devkit:commit-terminal`;

// The biome format-staged-files step (only when the `biome` component is selected).
const BIOME_FRAGMENT = `# devkit:biome-format
# Format staged files with biome, then re-stage exactly those (scoped — never a blanket
# \`git add -u\`, which would sweep unrelated working-tree changes into the commit). Only
# re-add files with NO unstaged edits, so partially-staged files commit exactly as staged.
STAGED_FMT=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(tsx?|jsx?|css|json|jsonc|mjs)$' || true)
if [ -n "$STAGED_FMT" ]; then
    UNSTAGED_FMT_FILE=$(mktemp)
    git diff --name-only | sort -u >"$UNSTAGED_FMT_FILE"
    FMT_SAFE=$(printf '%s\\n' "$STAGED_FMT" | grep -Fxvf "$UNSTAGED_FMT_FILE" || true)
    rm -f "$UNSTAGED_FMT_FILE"
    if [ -n "$FMT_SAFE" ]; then
        echo "🎨 Formatting staged files..."
        echo "$FMT_SAFE" | xargs bunx biome format --write 2>/dev/null || true
        echo "$FMT_SAFE" | xargs git add -f
    fi
fi
# /devkit:biome-format`;

// The PATH-setup snippet (GUI git clients launch with a minimal PATH that omits user bin dirs, so
// `bun`/`bunx` go missing). devkit's gates need it to have run BEFORE them — it's part of a fresh hook's
// preamble, and is INJECTED just ahead of an inserted block when an existing hook has no PATH setup.
export const PATH_SETUP = `# GUI git clients launch with a minimal PATH that omits user bin dirs, so \`bun\`/\`bunx\`
# can go missing → the hook fails. Prepend the standard user install locations.
for dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
    [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH`;

// True when a hook already establishes PATH (so we never inject a duplicate PATH_SETUP).
const HAS_PATH_SETUP_RE = /\$HOME\/\.bun\/bin|export\s+PATH/;

// Preamble-line shapes (top-level → no per-call regex compile). See findPreambleEnd.
const DONE_RE = /^done\b/;
const EXPORT_PATH_RE = /\bexport\s+PATH\b/;
const PATH_ASSIGN_RE = /^PATH=/;
const HOME_BIN_RE = /\$HOME\/\.(bun|local)/;
const LOOP_OPEN_RE = /^(for|while|until)\b/;
const DO_END_RE = /\bdo$/;
const TRAILING_NEWLINES_RE = /\n+$/;
const LEADING_NEWLINES_RE = /^\n+/;

// The shebang + PATH preamble that precedes the marker block when devkit writes a fresh hook.
const HOOK_PREAMBLE = `#!/bin/sh
# devkit generic pre-commit hook (POSIX sh). Runs the selected gate-engine set on every
# commit. The block between the two \`# devkit-guards\` markers is devkit-owned and is the
# only region init / removal touches — everything outside it is the consumer's own hook.

${PATH_SETUP}
`;

// Emit the deterministic orchestrator only when it has something to run: a selected
// deterministic guard (the bin re-reads the selection from .devkit/config.json at commit time)
// or a structure command joined via --structure.
function wantsDeterministic(selection: HookSelection): boolean {
  return (
    DETERMINISTIC_GUARD_IDS.some((id) => selection.guards?.includes(id)) ||
    Boolean(selection.structureCmd)
  );
}

/**
 * Build the `# devkit-guards` marker block (inclusive of markers) from a selection.
 * Order: biome format → guard-deterministic (prefix check → selected guards + structure →
 * aggregated report → prefix record, all inside the bin) → AI guards (fail-fast).
 * biome runs BEFORE the orchestrator on purpose: the cache key hashes the post-format index.
 *
 * `pkgRel` (monorepo): when set, the markers are package-scoped and the gates run inside a
 * `( cd "<pkgRel>" … ) || exit 1` subshell so the hook (at the git root) governs that package.
 * biome's staged-file format is REPO-WIDE → emitted only at the root (pkgRel ''), never inside
 * a package subshell (where `git add` paths would resolve wrong).
 *
 * `selection.structureCmd` is the stack-resolved structure-lint command (`guard-structure gate` /
 * `bunx eslint src`), absent when structure is off. `pkgRel` is the package path relative to the
 * git root ('' = root install).
 */
export function buildGuardBlock(selection: HookSelection, pkgRel = ''): string {
  // First so a first-gate block still records the run's terminal (the trap covers every exit path).
  const pieces = [COMMIT_TERMINAL_FRAGMENT, PLAN_CRITIQUE_SHADOW_FRAGMENT];
  if (!pkgRel && selection.biome) pieces.push(BIOME_FRAGMENT);
  if (wantsDeterministic(selection))
    pieces.push(deterministicFragment(selection.structureCmd, selection.extras));
  for (const id of AI_GUARD_IDS) {
    if (selection.guards?.includes(id)) pieces.push(GUARD_FRAGMENTS[id]);
  }
  if (selection.guards?.includes(QAVIS_ADVISORY_ID)) pieces.push(QAVIS_FRAGMENT);
  const body = pieces.join('\n\n');
  const start = markStart(pkgRel);
  const end = markEnd(pkgRel);
  if (!pkgRel) return `${start}\n${body}\n${end}`;
  // Run the package's gates from its own dir. An inner `exit 1` exits the SUBSHELL; the
  // `) || exit 1` then propagates that failure to the hook (a bare subshell would swallow it).
  return `${start}\nDK_HOOK_PATH="$(cd "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)/$(basename -- "$0")"\n( cd "${pkgRel}" || exit 1\n\n${body}\n) || exit 1\n${end}`;
}

/** A full fresh hook (preamble + assembled block + trailing exit 0) for a repo with no hook. */
export function buildFullHook(selection: HookSelection, pkgRel = ''): string {
  return `${HOOK_PREAMBLE}\n${buildGuardBlock(selection, pkgRel)}\n\nexit 0\n`;
}

// Standalone (no-package) AI-gate args, in run order. The bin is global (devkit installed with
// `bun add -g`); the block fail-opens per gate so a repo whose committer doesn't have devkit is
// never blocked — exactly fallow's `command -v fallow || exit 0`.
const STANDALONE_GATES = {
  decisions: ['guard-decisions', 'detect', '--gate'],
  review: ['guard-review', '--gate'],
};

// The standalone/overlay deterministic lines: ONE global-bin orchestrator call, command -v-guarded
// (a machine without devkit is never blocked). The bin owns the prefix cache, guard selection,
// structure lint (--structure) and the aggregated report — its exit contract is 0/1 only, so a
// failure exits the hook directly.
const standaloneDeterministicLines = (
  structureCmd?: string,
) => `if command -v guard-deterministic >/dev/null 2>&1; then
    guard-deterministic --hook "\${DK_HOOK_PATH:-$0}"${structureCmd ? ` --structure "${structureCmd}"` : ''} || exit 1
fi`;

// AI-gate helper: FAIL-FAST (never aggregated — findings surface one at a time), with exit 3
// (strict ship mode failing closed on a judge outage) given its own remedy so it is never
// rendered as a code violation.
const DK_GATE_AI_HELPER =
  '__dk_gate_ai() { command -v "$1" >/dev/null 2>&1 || return 0; rc=0; "$@" || rc=$?; if [ "$rc" -eq 3 ]; then echo "   $1: judge unavailable — strict ship mode failed closed. Check claude auth/quota, then re-run devkit ship."; exit 1; elif [ "$rc" -eq 1 ] || { [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; }; then exit 1; fi; }';

/**
 * Build the standalone (no-package) `# devkit-guards` block — global `guard-*` bins, fail-open,
 * NO `bunx`/node_modules. biome-format is omitted (needs project-local tooling); structure-lint
 * joins the orchestrator via `--structure` when `selection.structureCmd` (config-driven stacks —
 * devkit's own eslint/plugin do the work, so no consumer dep). pkgRel cd-wraps for a monorepo.
 */
export function buildStandaloneBlock(selection: HookSelection, pkgRel = ''): string {
  const pieces = [
    '# devkit standalone gates — global CLI, fail-open (skipped if devkit is not installed).',
    COMMIT_TERMINAL_FRAGMENT,
    PLAN_CRITIQUE_SHADOW_FRAGMENT,
    DK_GATE_AI_HELPER,
  ];
  if (wantsDeterministic(selection)) {
    pieces.push(standaloneDeterministicLines(selection.structureCmd));
  }
  for (const id of AI_GUARD_IDS) {
    if (selection.guards?.includes(id))
      pieces.push(`__dk_gate_ai ${STANDALONE_GATES[id].join(' ')}`);
  }
  if (selection.guards?.includes(QAVIS_ADVISORY_ID)) pieces.push(standaloneQavisLines);
  const body = pieces.join('\n');
  const start = markStart(pkgRel);
  const end = markEnd(pkgRel);
  if (!pkgRel) return `${start}\n${body}\n${end}`;
  return `${start}\nDK_HOOK_PATH="$(cd "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)/$(basename -- "$0")"\n( cd "${pkgRel}" || exit 1\n${body}\n) || exit 1\n${end}`;
}

/** A full fresh STANDALONE hook (preamble + standalone block + exit 0). */
export function buildStandaloneHook(selection: HookSelection, pkgRel = ''): string {
  return `${HOOK_PREAMBLE}\n${buildStandaloneBlock(selection, pkgRel)}\n\nexit 0\n`;
}

// The eslint/biome overlay steps — run the LOCAL devkit configs (which extend the repo's) over
// STAGED files only (so new changes are checked without flooding on the team's existing code,
// which can't be grandfathered invisibly). Each step is fail-open: only fires if the local
// config + the repo's own binary are present.
// `--relative` makes `git diff` emit paths relative to the CURRENT dir, so this works whether
// the hook runs at the repo root or cd'd into a monorepo package (eslint/biome + their configs
// are then resolved package-locally).
const OVERLAY_LINT_STEPS = `# devkit lint overlay — STAGED files only, against configs that EXTEND the repo's (git-ignored).
DK_TS=$(git diff --cached --name-only --relative --diff-filter=ACM | grep -E '\\.(tsx?|jsx?)$' || true)
if [ -n "$DK_TS" ] && [ -f eslint.config.devkit.mjs ] && [ -x node_modules/.bin/eslint ]; then
    echo "🧱 devkit eslint overlay (staged)..."
    echo "$DK_TS" | xargs node_modules/.bin/eslint -c eslint.config.devkit.mjs || exit 1
fi
DK_FMT=$(git diff --cached --name-only --relative --diff-filter=ACM | grep -E '\\.(tsx?|jsx?|css|jsonc?)$' || true)
if [ -n "$DK_FMT" ] && [ -f biome.devkit.jsonc ] && [ -x node_modules/.bin/biome ]; then
    echo "🎨 devkit biome overlay (staged)..."
    echo "$DK_FMT" | xargs node_modules/.bin/biome check --config-path biome.devkit.jsonc || exit 1
fi`;

// The optional fallow gate (overlay). fail-open — only runs if fallow is on PATH; overlay's
// core.hooksPath takeover SHADOWS .git/hooks, so fallow's own installed hook would never fire, and
// chaining the gate inline here is the only way the audit runs. `fallow audit` exits non-zero on
// NEW issues (pre-existing debt is grandfathered by the saved fallow-baselines/).
const FALLOW_OVERLAY_GATE = `# devkit fallow gate (overlay) — fail-open; skipped if fallow isn't installed.
# DEVKIT_SHIP_BASE_SHA (set by devkit ship) narrows the audit to the exact ship base rather than
# fallow's own main-autodetect — see self-host.mts's FALLOW_FRAGMENT for the full rationale (DK-5).
FALLOW_BASE_ARGS=""
[ -n "\${DEVKIT_SHIP_BASE_SHA:-}" ] && FALLOW_BASE_ARGS="--base $DEVKIT_SHIP_BASE_SHA"
command -v fallow >/dev/null 2>&1 && { fallow audit $FALLOW_BASE_ARGS || exit 1; }`;

/**
 * Build the OVERLAY hook — a complete, self-contained file devkit fully owns (written to a
 * git-ignored local hooks dir at the GIT ROOT; `core.hooksPath` points at it). It runs devkit's
 * gates + lint overlay (cd'd into the package for a monorepo), then `exec`s the repo's OWN
 * committed hook unchanged (so its exit propagates).
 *
 * `chainTarget` is the repo's existing hook to chain to (git-root-relative). `pkgRel` is the
 * package dir (monorepo) to cd into before the gates ('' = repo root). `opts.fallow` appends the
 * fail-open fallow gate (overlay wires it inline because core.hooksPath shadows fallow's own
 * .git/hooks hook).
 */
export function buildOverlayHook(
  selection: HookSelection,
  chainTarget = '.husky/pre-commit',
  pkgRel = '',
  { fallow = false }: { fallow?: boolean } = {},
): string {
  const gates = [COMMIT_TERMINAL_FRAGMENT, PLAN_CRITIQUE_SHADOW_FRAGMENT, DK_GATE_AI_HELPER];
  if (wantsDeterministic(selection)) gates.push(standaloneDeterministicLines());
  for (const id of AI_GUARD_IDS) {
    if (selection.guards?.includes(id))
      gates.push(`__dk_gate_ai ${STANDALONE_GATES[id].join(' ')}`);
  }
  if (selection.guards?.includes(QAVIS_ADVISORY_ID)) gates.push(standaloneQavisLines);
  const inner = `${gates.join('\n')}\n\n${OVERLAY_LINT_STEPS}${fallow ? `\n\n${FALLOW_OVERLAY_GATE}` : ''}`;
  const scoped = pkgRel
    ? `DK_HOOK_PATH="$(cd "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)/$(basename -- "$0")"\n( cd ${JSON.stringify(pkgRel)} || exit 1\n${inner}\n) || exit 1`
    : inner;
  return `${HOOK_PREAMBLE}
# devkit OVERLAY (LOCAL, git-ignored). Runs devkit's gates + lint overlay on this commit, then
# the repo's OWN committed hook UNCHANGED. Invisible to the team — nothing here is committed.
# Sentinel: proves the chain actually started, so \`devkit ship\` can tell a real run from a silent
# no-op and never report "gates ran" when they didn't. Only during ship (DEVKIT_SHIP=1) — a normal
# \`git ci\` stays quiet. Emitted before the gates so even a first-gate block still records it.
[ -n "\${DEVKIT_SHIP:-}" ] && echo 'devkit-gates: chain start' >&2
${scoped}

# Invoked by the global init.sh shim (husky reclaimed core.hooksPath on a plain \`git commit\`):
# run gates ONLY and stop — husky's _/h runs the repo's committed hook itself, so chaining here
# would run it twice. Reached only after the gates above PASSED (a failure already exited 1).
[ -n "\${DEVKIT_VIA_HUSKY_INIT:-}" ] && exit 0

# devkit gates passed — emit the commit-run terminal NOW: \`exec\` replaces this process, so the
# EXIT trap would never fire on the pass path. commit_result records the DEVKIT chain's outcome
# (the chained repo hook may still block the commit on its own gates).
command -v __dk_commit_result >/dev/null 2>&1 && { trap - EXIT; __dk_commit_result 0; }

# Chain to the repo's own pre-commit (exec → its exit code becomes the hook's).
[ -f ${JSON.stringify(chainTarget)} ] && exec sh ${JSON.stringify(chainTarget)} "$@"
exit 0
`;
}

/**
 * Build a PASS-THROUGH wrapper for a non-pre-commit hook. Overriding `core.hooksPath` makes git
 * run ONLY our hooks dir, so EVERY hook the repo already had (pre-push, commit-msg, …) needs a
 * wrapper here or it silently stops. This just runs the repo's own hook unchanged.
 *
 * `chainScript` is the repo's existing hook script (git-root-relative).
 */
export function buildPassthroughHook(chainScript: string): string {
  return `${HOOK_PREAMBLE}
# devkit overlay pass-through — git now runs this dir, so we forward to the repo's own hook
# unchanged (devkit adds nothing to it).
[ -f ${JSON.stringify(chainScript)} ] && exec sh ${JSON.stringify(chainScript)} "$@"
exit 0
`;
}

/** Slice the (package-scoped) marker block (inclusive) out of a hook; null if absent. */
// Reason: parallel marker-block string builders; the shape rhymes but each emits a distinct hook fragment
// fallow-ignore-next-line code-duplication
export function extractGuardBlock(hookContent: string, pkgRel = ''): string | null {
  const s = markStart(pkgRel);
  const e = markEnd(pkgRel);
  const start = hookContent.indexOf(s);
  const end = hookContent.indexOf(e);
  if (start === -1 || end === -1) return null;
  return hookContent.slice(start, end + e.length);
}

/**
 * Remove a single per-id fragment (`# devkit:<id>` … `# /devkit:<id>`) from a hook,
 * trimming the blank line that joined it. Returns { content, removed }.
 *
 * `id` is one of GUARD_FRAGMENTS keys or 'biome-format'.
 */
export function removeFragment(
  hookContent: string,
  id: string,
): { content: string; removed: boolean } {
  const open = `# devkit:${id}`;
  const close = `# /devkit:${id}`;
  const start = hookContent.indexOf(open);
  const end = hookContent.indexOf(close);
  if (start === -1 || end === -1) return { content: hookContent, removed: false };
  const afterClose = end + close.length;
  // Eat one leading blank-line separator if present (the `\n\n` join), else one trailing.
  let from = start;
  let to = afterClose;
  if (hookContent.slice(start - 2, start) === '\n\n') from = start - 1;
  else if (hookContent.slice(afterClose, afterClose + 2) === '\n\n') to = afterClose + 1;
  return { content: hookContent.slice(0, from) + hookContent.slice(to), removed: true };
}

/** Is a given guard id currently present (by sentinel) in the hook? */
export function hasFragment(hookContent: string, id: string): boolean {
  return hookContent.includes(`# devkit:${id}`);
}

/**
 * Char offset of the END of a hook's leading PREAMBLE — the maximal top run of: the shebang (line 0),
 * blank lines, comment lines, and PATH-setup lines (the `for … do … done` loop, `export PATH`,
 * `$HOME/.bun|.local/bin` lines), stopping at the first SUBSTANTIVE command. The guard block is spliced
 * here (not appended at EOF) so it runs on EVERY commit — a consumer hook below may conditionally
 * early-exit (e.g. a reviewer gate that `exit 0`s when all reviews pass), which would make an appended
 * block unreachable. Whole-file-is-preamble → EOF; no shebang / first line is a command → 0 (very top).
 *
 * Returns the insertion offset.
 */
export function findPreambleEnd(hookContent: string): number {
  const lines = hookContent.split('\n');
  let consumed = 0;
  let inLoop = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inLoop > 0) {
      consumed = i + 1;
      if (DONE_RE.test(t)) inLoop--;
      continue;
    }
    // Loop-open FIRST — the PATH for-loop's own line contains `$HOME/.bun` (a preamble shape), so it
    // must be recognised as a loop opener (to track its body via `done`), not a one-off preamble line.
    if (LOOP_OPEN_RE.test(t) && DO_END_RE.test(t)) {
      inLoop++;
      consumed = i + 1;
      continue;
    }
    const isShebang = i === 0 && t.startsWith('#!');
    const isPreambleLine =
      isShebang ||
      t === '' ||
      t.startsWith('#') ||
      EXPORT_PATH_RE.test(t) ||
      PATH_ASSIGN_RE.test(t) ||
      HOME_BIN_RE.test(t);
    if (isPreambleLine) {
      consumed = i + 1;
      continue;
    }
    break; // first substantive command
  }
  if (consumed === 0) return 0;
  if (consumed >= lines.length) return hookContent.length;
  return lines.slice(0, consumed).join('\n').length + 1; // +1 = the newline after the last preamble line
}

/**
 * Insert (or relocate) the package-scoped marker block in a hook so it runs on EVERY commit. ALWAYS
 * removes any existing block first, then re-inserts it right AFTER the preamble (findPreambleEnd) — this
 * RELOCATES a block that a prior devkit version stuck after a terminal `exit` (unreachable). PATH_SETUP
 * is injected just before the block iff the hook establishes no PATH of its own. Idempotent: a
 * correctly-placed block round-trips to the same bytes (so re-running init is a no-op). The consumer's
 * lines outside the block are untouched.
 */
// Reason: parallel marker-block string builders; the shape rhymes but each emits a distinct hook fragment
// fallow-ignore-next-line code-duplication
export function replaceGuardBlock(hookContent: string, newBlock: string, pkgRel = ''): string {
  const { content } = removeGuardBlock(hookContent, pkgRel);
  const idx = findPreambleEnd(content);
  const block = HAS_PATH_SETUP_RE.test(content) ? newBlock : `${PATH_SETUP}\n\n${newBlock}`;
  const before = content.slice(0, idx).replace(TRAILING_NEWLINES_RE, '');
  const after = content.slice(idx).replace(LEADING_NEWLINES_RE, '');
  const joined = [before, block, after].filter((p) => p !== '').join('\n\n');
  return `${joined.replace(TRAILING_NEWLINES_RE, '')}\n`;
}

/**
 * Remove the (package-scoped) devkit-guards block (markers inclusive) from a hook, collapsing
 * the blank lines that surrounded it. Returns { content, removed }.
 */
// Reason: parallel marker-block string builders; the shape rhymes but each emits a distinct hook fragment
// fallow-ignore-next-line code-duplication
export function removeGuardBlock(
  hookContent: string,
  pkgRel = '',
): { content: string; removed: boolean } {
  const s = markStart(pkgRel);
  const e = markEnd(pkgRel);
  const start = hookContent.indexOf(s);
  const end = hookContent.indexOf(e);
  if (start === -1 || end === -1) return { content: hookContent, removed: false };
  const afterEnd = end + e.length;
  let from = start;
  let to = afterEnd;
  if (hookContent.slice(start - 2, start) === '\n\n') from = start - 1;
  if (hookContent.slice(to, to + 1) === '\n') to += 1;
  return { content: hookContent.slice(0, from) + hookContent.slice(to), removed: true };
}
