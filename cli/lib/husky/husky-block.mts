/**
 * Assemble the `# devkit-guards` pre-commit block from a component selection, and
 * surgically remove individual pieces (a single guard, the format step, the whole
 * block) without disturbing the consumer's own hook lines outside the markers.
 *
 * The block is COMPOSED from fragments rather than copied from a static template so that
 * `devkit init` can emit exactly the selected guards + the format step, and the removal
 * path can drop one guard while leaving the rest. Each fragment is delimited by per-piece
 * `# devkit:<id>` / `# /devkit:<id>` sentinels so removal is an exact slice, never a
 * brittle regex against shell prose.
 */

import { GUARD_FRAGMENTS } from './ai-guard-fragments.mts';
import {
  DK_DETERMINISTIC_GATE_HELPER,
  DK_GATE_AI_HELPER,
  DK_GATE_BLOCK_HELPERS,
  REVIEW_FAILURE_FINALIZER,
} from './gate-policy/block-helpers.mts';
import { buildPreCommitExit, PRE_COMMIT_PASS_EXIT } from './gate-policy/commit-gate-log.mts';
import { FORMAT_FRAGMENT } from './format-fragment.mts';
import { markEnd, markStart } from './husky.mts';
import {
  DK_COMMIT_INDEX_CAPTURE,
  DK_HOOK_HELPERS,
  DK_REVIEW_BASELINE_HELPER,
  selectedFragment,
} from './review-fragments.mts';
import { sentryShipPrewarmFragment } from './sentry-fragments.mts';
import { shQuote } from '../ship/redact-secrets.mts';

/**
 * A superset of every builder's needs; each reads only its own fields. `biome` keeps owning whether
 * the format step is emitted at all — the opt-out — while the step itself checks for a biome CONFIG.
 */
interface HookSelection {
  biome?: boolean;
  guards?: string[];
  antiSlop?: boolean;
  structureCmd?: string;
  // Extra arbitrary hard gates folded into the deterministic orchestrator via `--extra "label=cmd"`
  // (any non-zero blocks). Empty/undefined for a normal consumer → no `--extra` emitted, so the
  // fragment is byte-identical to before. Self-host seeds `[{label:'lint',cmd:'bun run lint'}]` to
  // preserve devkit's own hard lint commit gate.
  extras?: Array<{ label: string; cmd: string }>;
}

export const PACKAGE_BIN_DIR_FRAGMENT = '__dk_package_bin_dir="$(bun pm bin)"';

// The ONE deterministic line: `guard-deterministic` (gate-engine/deterministic/run.mjs) owns the
// prefix-cache check/record, runs the selected guards (.devkit/config.json components.guards),
// applies the rc trichotomy per gate, and aggregates every failure into one report + one exit
// code — the hook just propagates it. `--structure "<cmd>"` joins the stack-resolved structure
// lint to the same aggregated set through Devkit's `guard-structure staged` runner. The old
// hand-rolled DK_PREFIX_SKIP/DK_DET_FAILS shell protocol is gone.
const deterministicFragment = (
  structureCmd?: string,
  extras: Array<{ label: string; cmd: string }> = [],
) => `# devkit:deterministic
echo "🚧 Deterministic gates (aggregated)..."
__dk_gate_deterministic "$__dk_package_bin_dir/guard-deterministic" --hook "\${DK_HOOK_PATH:-$0}"${structureCmd ? ` --structure "${structureCmd}"` : ''}${extras.map((e) => ` --extra "${e.label}=${e.cmd}"`).join('')}
# /devkit:deterministic`;

// Guard run order: the deterministic orchestrator first (one aggregated report), AI gates last so
// a doomed commit never pays for a judge. Explicit lists — never rely on object-key order.
const DETERMINISTIC_GUARD_IDS = ['size', 'fanout', 'dup', 'clone', 'coverage', 'comments'];
const AI_GUARD_IDS = ['decisions', 'review'] as const;
// qavis-advisory runs after every judge that can demand an edit (sc-3012), own 0/3 exit contract.
// This wrapper stays fail-open when qavis/the bin is absent, matching the fallow precedent.
export const QAVIS_ADVISORY_ID = 'qavis-advisory';
const QAVIS_FRAGMENT = `# devkit:guard-qavis-advisory
qarc=0
__dk_no_git_env "$__dk_package_bin_dir/guard-qavis-advisory" --gate || qarc=$?
[ "$qarc" -eq 3 ] && exit 1
# qarc 0 = continue (SILENT / advisory-only / receipt-cleared / qavis absent); 3 = strict-ship block
# (the remedy — run qavis, or export GUARD_QAVIS_OK=1 — is printed by the bin).
# /devkit:guard-qavis-advisory`;
const standaloneQavisLines = `if command -v guard-qavis-advisory >/dev/null 2>&1; then
    qarc=0; __dk_no_git_env guard-qavis-advisory --gate || qarc=$?
    [ "$qarc" -eq 3 ] && exit 1
fi`;
// Inject user bins before gates when a GUI client's minimal PATH omits bun/bunx.
export const PATH_SETUP = `# GUI git clients launch with a minimal PATH that omits user bin dirs, so \`bun\`/\`bunx\`
# can go missing → the hook fails. Prepend the standard user install locations.
for dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
    [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH`;

const HOOK_PATH_PRELUDE =
  'DK_HOOK_PATH="$(cd "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)/$(basename -- "$0")"';

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
// deterministic guard / anti-slop component (the bin re-reads the selection from
// .devkit/config.json at commit time), or a structure command joined via --structure.
function wantsDeterministic(selection: HookSelection): boolean {
  if (selection.antiSlop || selection.structureCmd) return true;
  return DETERMINISTIC_GUARD_IDS.some((id) => selection.guards?.includes(id));
}

/**
 * Order: format (first — the prefix-cache key hashes the post-format index) →
 * guard-deterministic → AI guards. `pkgRel` scopes a monorepo block to a failing subshell.
 */
export function buildGuardBlock(selection: HookSelection, pkgRel = ''): string {
  const handoff = selection.guards?.some((id) => id === 'review' || id === 'sentry') ?? false;
  const deterministic = wantsDeterministic(selection);
  const pieces = [
    buildPreCommitExit(handoff),
    ...DK_HOOK_HELPERS,
    PACKAGE_BIN_DIR_FRAGMENT,
    DK_REVIEW_BASELINE_HELPER,
    DK_GATE_BLOCK_HELPERS,
  ];
  // First so a first-gate block still records the run's terminal (the trap covers every exit path).
  if (!pkgRel && selection.biome) pieces.push(FORMAT_FRAGMENT);
  if (deterministic)
    pieces.push(
      DK_DETERMINISTIC_GATE_HELPER,
      deterministicFragment(selection.structureCmd, selection.extras),
    );
  for (const id of AI_GUARD_IDS) {
    if (selection.guards?.includes(id)) pieces.push(selectedFragment(id, GUARD_FRAGMENTS[id]));
  }
  if (selection.guards?.includes('sentry'))
    pieces.push(selectedFragment('sentry', sentryShipPrewarmFragment(false)));
  if (selection.guards?.includes(QAVIS_ADVISORY_ID))
    pieces.push(selectedFragment(QAVIS_ADVISORY_ID, QAVIS_FRAGMENT));
  pieces.push(REVIEW_FAILURE_FINALIZER);
  return wrapGuardBlock(pieces.join('\n\n'), pkgRel, HOOK_PATH_PRELUDE, '\n\n');
}

/** Marker-wrap a block body, capturing the commit index before a monorepo package `cd`. */
export function wrapGuardBlock(body: string, pkgRel: string, prelude: string, gap: string): string {
  const start = markStart(pkgRel);
  const end = markEnd(pkgRel);
  if (!pkgRel) return `${start}\n${DK_COMMIT_INDEX_CAPTURE}${gap}${body}\n${end}`;
  // Run the package's gates from its own dir. An inner `exit 1` exits the SUBSHELL; the
  // `) || exit 1` then propagates that failure to the hook (a bare subshell would swallow it).
  return `${start}\n${DK_COMMIT_INDEX_CAPTURE}\n${prelude}\n( cd "${pkgRel}" || exit 1${gap}${body}\n) || exit 1\n${end}`;
}

/** A full fresh hook (preamble + assembled block + trailing exit 0) for a repo with no hook. */
export function buildFullHook(selection: HookSelection, pkgRel = ''): string {
  return `${HOOK_PREAMBLE}\n${buildGuardBlock(selection, pkgRel)}\n\nexit 0\n`;
}

// Standalone (no-package) gate args, in run order, each led by its block lane. The bin is global
// (`bun add -g`) and fail-opens per gate, exactly fallow's `command -v fallow || exit 0`.
const STANDALONE_GATES = {
  decisions: ['ai', 'guard-decisions', 'detect', '--gate'],
  review: ['ai', 'guard-review', '--gate'],
};

// Standalone/overlay use the global orchestrator if installed and share the package-mode policy:
// commit/ship fails fast; review remembers the failure until its finalizer.
const standaloneDeterministicLines = (
  structureCmd?: string,
) => `if command -v guard-deterministic >/dev/null 2>&1; then
    __dk_gate_deterministic guard-deterministic --hook "\${DK_HOOK_PATH:-$0}"${structureCmd ? ` --structure "${structureCmd}"` : ''}
fi`;

/**
 * Build standalone gates from global fail-open bins. Biome needs local tooling and is omitted;
 * structure joins via `--structure`, and `pkgRel` scopes monorepos.
 */
export function buildStandaloneBlock(selection: HookSelection, pkgRel = ''): string {
  const handoff = selection.guards?.some((id) => id === 'review' || id === 'sentry') ?? false;
  const deterministic = wantsDeterministic(selection);
  const pieces = [
    '# devkit standalone gates — global CLI, fail-open (skipped if devkit is not installed).',
    buildPreCommitExit(handoff),
    ...DK_HOOK_HELPERS,
    DK_GATE_BLOCK_HELPERS,
    DK_GATE_AI_HELPER,
  ];
  if (deterministic)
    pieces.push(DK_DETERMINISTIC_GATE_HELPER, standaloneDeterministicLines(selection.structureCmd));
  for (const id of AI_GUARD_IDS) {
    if (selection.guards?.includes(id))
      pieces.push(
        `if __dk_gate_selected ${id}; then __dk_gate_ai ${STANDALONE_GATES[id].join(' ')}; fi`,
      );
  }
  if (selection.guards?.includes('sentry'))
    pieces.push(selectedFragment('sentry', sentryShipPrewarmFragment(true)));
  if (selection.guards?.includes(QAVIS_ADVISORY_ID))
    pieces.push(selectedFragment(QAVIS_ADVISORY_ID, standaloneQavisLines));
  pieces.push(REVIEW_FAILURE_FINALIZER);
  return wrapGuardBlock(pieces.join('\n'), pkgRel, HOOK_PATH_PRELUDE, '\n');
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
const OVERLAY_ESLINT_STAGED = `DK_TS=$(git diff --cached --name-only --relative --diff-filter=ACM | grep -E '\\.(tsx?|jsx?)$' || true)
if [ -n "$DK_TS" ] && [ -f eslint.config.devkit.mjs ] && [ -x node_modules/.bin/eslint ]; then
    echo "🧱 devkit eslint overlay (staged)..."
    echo "$DK_TS" | xargs node_modules/.bin/eslint -c eslint.config.devkit.mjs || exit 1
fi`;
const OVERLAY_BIOME = `DK_FMT=$(git diff --cached --name-only --relative --diff-filter=ACM | grep -E '\\.(tsx?|jsx?|css|jsonc?)$' || true)
if [ -n "$DK_FMT" ] && [ -f biome.devkit.jsonc ] && [ -x node_modules/.bin/biome ]; then
    echo "🎨 devkit biome overlay (staged)..."
    echo "$DK_FMT" | xargs node_modules/.bin/biome check --config-path biome.devkit.jsonc || exit 1
fi`;

// Overlay shadows fallow's installed hook, so its optional audit must run inline here. Scope the
// audit to the index: ship refreshes reviewer assets in its worktree AFTER staging, and a base-wide
// audit would otherwise attribute those unstaged runtime files to the caller's commit (sc-1549).
// Normal commits fail-open if fallow isn't installed.
const FALLOW_OVERLAY_STAGED = `if command -v fallow >/dev/null 2>&1; then
    DK_FALLOW_DIFF="$(mktemp)" || exit 1
    if ! git diff --cached --binary --full-index --find-renames --relative >"$DK_FALLOW_DIFF"; then
        rm -f "$DK_FALLOW_DIFF"
        exit 1
    fi
    # __dk_no_git_env: fallow's snapshot machinery has clobbered a ship worktree before. The
    # staged diff is already captured with the committing index's git environment intact.
    DK_FALLOW_RC=0
    __dk_no_git_env fallow audit --diff-stdin <"$DK_FALLOW_DIFF" || DK_FALLOW_RC=$?
    rm -f "$DK_FALLOW_DIFF"
    [ "$DK_FALLOW_RC" -eq 0 ] || exit 1
fi`;

// Hoisted (perf: no per-call regex compile).
const LINE_START_RE = /^(?=.)/gm;
const indent = (body: string) => body.replace(LINE_START_RE, '    ');

// Commit, ship and dry-gates: the cheap BLOCKING staged checks run before the AI guards, so a lint
// or dead-code finding never waits behind the reviewer chain (sc-3020).
const overlayStagedGates = (
  fallow: boolean,
) => `# devkit lint overlay — STAGED files only, against configs that EXTEND the repo's (git-ignored).
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ]; then
${indent(OVERLAY_ESLINT_STAGED)}
${indent(OVERLAY_BIOME)}${fallow ? `\n    # devkit fallow gate (overlay)\n${indent(FALLOW_OVERLAY_STAGED)}` : ''}
fi`;

// Review is diagnostic: its merge-base baselines exit on a finding, so they stay AFTER the guards
// and a lint finding never hides the reviewer's report.
const overlayReviewBaseline = (
  fallow: boolean,
) => `# devkit lint overlay — review mode, merge-base baselines.
if [ "\${DEVKIT_RUN_MODE:-}" = "review" ]; then
    __dk_review_baseline_gate eslint || exit 1
${indent(OVERLAY_BIOME)}${fallow ? '\n    __dk_review_baseline_gate fallow || exit 1' : ''}
fi`;

/**
 * Build the OVERLAY hook — a complete, self-contained file devkit fully owns (written to a
 * git-ignored local hooks dir at the GIT ROOT; `core.hooksPath` points at it). It runs devkit's
 * gates + lint overlay (cd'd into the package for a monorepo), then `exec`s the repo's OWN
 * committed hook unchanged (so its exit propagates).
 *
 * `chainTarget` is the existing hook, `pkgRel` scopes monorepos, `opts.fallow` adds the inline audit
 * the overlay hooksPath would otherwise shadow, and `opts.prelude` runs before any gate.
 */
export function buildOverlayHook(
  selection: HookSelection,
  chainTarget = '.husky/pre-commit',
  pkgRel = '',
  { fallow = false, prelude = '' }: { fallow?: boolean; prelude?: string } = {},
): string {
  const handoff = selection.guards?.some((id) => id === 'review' || id === 'sentry') ?? false;
  const deterministic = wantsDeterministic(selection);
  const gates = [
    buildPreCommitExit(handoff),
    ...DK_HOOK_HELPERS,
    DK_GATE_BLOCK_HELPERS,
    DK_GATE_AI_HELPER,
    DK_REVIEW_BASELINE_HELPER,
  ];
  if (deterministic) gates.push(DK_DETERMINISTIC_GATE_HELPER, standaloneDeterministicLines());
  gates.push(overlayStagedGates(fallow));
  for (const id of AI_GUARD_IDS) {
    if (selection.guards?.includes(id))
      gates.push(
        `if __dk_gate_selected ${id}; then __dk_gate_ai ${STANDALONE_GATES[id].join(' ')}; fi`,
      );
  }
  // No sentry prewarm: overlay's commit-msg judge (sc-1794) runs sentry after the advisory instead.
  if (selection.guards?.includes(QAVIS_ADVISORY_ID))
    gates.push(selectedFragment(QAVIS_ADVISORY_ID, standaloneQavisLines));
  const inner = `${gates.join('\n')}\n\n${overlayReviewBaseline(fallow)}\n\n${REVIEW_FAILURE_FINALIZER}`;
  const scoped = pkgRel
    ? `${DK_COMMIT_INDEX_CAPTURE}\n${HOOK_PATH_PRELUDE}\n( cd ${JSON.stringify(pkgRel)} || exit 1\n${inner}\n) || exit 1`
    : `${DK_COMMIT_INDEX_CAPTURE}\n${inner}`;
  return `${HOOK_PREAMBLE}
# devkit OVERLAY (LOCAL, git-ignored). Runs devkit's gates + lint overlay on this commit, then
# the repo's OWN committed hook UNCHANGED. Invisible to the team — nothing here is committed.
# Sentinel: proves the chain actually started, so \`devkit ship\` can tell a real run from a silent
# no-op and never report "gates ran" when they didn't. Only during ship (DEVKIT_SHIP=1) — a normal
# \`git ci\` stays quiet. Emitted before the gates so even a first-gate block still records it.
[ -n "\${DEVKIT_SHIP:-}" ] && echo 'devkit-gates: chain start' >&2
${prelude ? `${prelude}\n` : ''}${scoped}

# Invoked by the global init.sh shim (husky reclaimed core.hooksPath on a plain \`git commit\`):
# run gates ONLY and stop — husky's _/h runs the repo's committed hook itself, so chaining here
# would run it twice. Reached only after the gates above PASSED (a failure already exited 1).
[ -n "\${DEVKIT_VIA_HUSKY_INIT:-}" ] && exit 0

# devkit gates passed — run the exit work NOW (\`exec\` drops the EXIT trap): commit_result records
# the DEVKIT chain's outcome, and the gate log closes before the repo's own hook runs.
${PRE_COMMIT_PASS_EXIT}

# Chain to the repo's own pre-commit (exec → its exit code becomes the hook's).
[ -f ${chainWord(chainTarget)} ] && exec sh ${chainWord(chainTarget)} "$@"
exit 0
`;
}

/** Linked-worktree chain word for the repo's own hook: `.git` is a FILE there, so a `.git/hooks/*`
 * target resolves through the common dir. Anything else stays single-quoted (never executes). */
export function chainWord(target: string): string {
  const hook = /^(?:\.\/)?\.git\/hooks\/+([^/]+)$/.exec(target)?.[1];
  return hook
    ? `"$(git rev-parse --path-format=absolute --git-common-dir)/hooks/"${shQuote(hook)}`
    : shQuote(target);
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
[ -f ${chainWord(chainScript)} ] && exec sh ${chainWord(chainScript)} "$@"
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
