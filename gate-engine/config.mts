/**
 * Shared governance-gate config loader — the ONE place that knows defaults + env +
 * guard.config.json. Every engine extractor (decisions, co-occurrence matcher/clone,
 * fanout/size ratchets) IMPORTS `resolveGuardConfig` from here; none redefines it.
 *
 * ── W-3 (the load-bearing invariant) ──────────────────────────────────────────────
 * Every path in the returned config resolves relative to the CONSUMER cwd, NEVER
 * `__dirname` (the package dir). This package ships inside the consumer's
 * node_modules; an engine run there must scan the CONSUMER's repo — its src/, its
 * docs/decisions/, its allowlist — not files inside the package. So this module
 * deliberately has NO reference to import.meta.url / __dirname for any user path.
 * The only thing keyed to the package is its own behaviour; all *data* is the
 * consumer's, addressed from `cwd`.
 *
 * ── Resolution order (last wins) ──────────────────────────────────────────────────
 *   1. DEFAULTS below
 *   2. <cwd>/guard.config.json  (if present + valid; a corrupt file throws, never
 *      silently falls back — a typo'd config must be loud, not skip the gate)
 *   3. GUARD_* environment variables (with FRINK_* read as back-compat fallback aliases)
 *
 * ── Path semantics ────────────────────────────────────────────────────────────────
 * Relative path fields (scanRoots, decisionsDir, fanoutExempt, allowlistPath,
 * indexPath) are returned EXACTLY as configured — relative — and each engine joins
 * them onto the same `cwd` it was handed. Keeping them relative (not pre-joined here)
 * means an engine can present clean repo-relative paths in its output while still
 * resolving against the consumer cwd. `resolveFromCwd(cfg, cwd, field)` is the helper
 * engines use to get the absolute form when they need to touch the filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const CONFIG_FILENAME = 'guard.config.json';

// Defaults are deliberately frink-agnostic: an empty/`src`-only repo gets a sane,
// non-frink-specific baseline. Frink's old hardcoded BOUNDARIES / grandfathered
// fanout roots are NOT defaults here — a consumer opts into them via guard.config.json.
export const DEFAULTS = Object.freeze({
  // Cross-trust-boundary prefixes for the decision smell gate (was frink detect.mjs
  // BOUNDARIES const). Empty by default: a generic repo has no trust boundaries to
  // straddle, so the cross-boundary-move smell simply never fires until configured.
  boundaries: [],
  // Where the ratchets / structure scans look for implementation files.
  scanRoots: ['src'],
  // Implementation-file extensions the ratchets count (fan-out + size). Default TS — a JS/MJS
  // codebase (devkit itself, a node CLI) sets `["mjs","js"]` so the gates actually SEE its files.
  // A file is a test when it matches `*.<ext>` AND `.test.`/`.spec.` (excluded from impl counts).
  sourceExtensions: ['ts', 'tsx'],
  // Folder-structure topology (the structure-lint engine). Declared ONCE here; devkit's interpreter
  // generates the eslint rule + drives the baseline walk from this SAME spec (no drift). Empty by
  // default → structure-lint is opt-in / no-op. `trees[]` = { name, root, sourceExtensions?, grammar
  // (or preset), libDomains?, frozenDirs?, ignoredDirs?, entryAllowlist? }; `walls[]` = import walls.
  // See gate-engine/structure/walk.mjs + docs/design/structure/01-generalize-engine.md.
  structure: Object.freeze({ trees: [], walls: [] }),
  // Append-only decision-log directory (the decisions CLI + smell gate target).
  decisionsDir: 'docs/decisions',
  // Max non-test impl files per folder (any depth) before the fanout ratchet trips.
  fanoutCap: 12,
  // Max lines per source file before the size ratchet flags it (raw line count, all lines). 0 = OFF
  // (opt-in). When set, size is enforced by the ratchet directly — no eslint max-lines rule needed,
  // so the structure-only eslint shim governs ANY stack. Existing over-cap files are grandfathered
  // shrink-only in eslint/baselines/size-lines.json. (Per-FUNCTION caps need a parser → not here yet.)
  maxLines: 0,
  // Flat-by-design folders exempt from the fanout cap (was frink's hardcoded
  // grandfathered roots — now opt-in per consumer).
  fanoutExempt: [],
  // Co-occurrence allowlist (intentional-dup approvals) — matcher + clone-detector.
  allowlistPath: '.co-occurrence-allowlist.json',
  // Matcher/clone tier + size thresholds. Sane defaults mirror the calibrated frink
  // knobs; a consumer can tune any subset via guard.config.json `thresholds`.
  thresholds: Object.freeze({
    nearCode: 0.95, // code cosine ≥ this → "near" tier
    driftCode: 0.8, // code cosine ≥ this (with driftDesc + minLoc) → "drifted" tier
    driftDesc: 0.88, // description cosine gate for the drifted tier
    minLoc: 15, // min lines per chunk to qualify as a drifted candidate
    minTokens: 50, // jscpd token-clone floor (clone-detector)
  }),
  // search-code index path for the embedding matcher. null => matcher opt-out:
  // no index configured means the semantic matcher fails open / does nothing
  // (a consumer without search-code still gets the clone-detector + ratchets).
  indexPath: null,
  // Semantic-search + graph tool NAMES the search-tool steering hooks point agents at.
  // Generic defaults — a consumer overrides per-repo via guard.config.json.
  searchTool: 'mcp__codebase__searchCode',
  graphTool: 'graphify',
  // Test command the testing agents run (markdown-prompt agents READ this). null =>
  // agents fall back to the consumer's documented package.json `test` script.
  testCommand: null,
  // Review-agent topology (the 5 reviewer subagents READ these). Frink-agnostic defaults:
  // a generic repo treats `src` as its only backend root, has no configured frontend
  // topology (frontend reviewers exit early), and enforces WCAG touch targets + skips the
  // tracker/Shortcut rule until opted in.
  review: Object.freeze({
    backendRoots: ['src'],
    frontendRoots: [],
    trustBoundaries: '',
    shortcutTracking: false,
    accessibility: Object.freeze({ skipTouchTargets: false }),
    // Where the synced reviewer agent .md briefs live — guard-review wraps these for its
    // headless judges (the SAME files the root agent dispatches interactively).
    agentsDir: '.claude/agents',
  }),
  // GUARD_NO_LOG / GUARD_DECISION_NO_LLM (+ FRINK_* aliases). Bypass + pure-regex.
  noLog: false,
  noLlm: false,
});

// Read a GUARD_* env var, falling back to its FRINK_* alias for back-compat with the
// original frink gates. Returns undefined when neither is set.
function envVar(name) {
  const guard = process.env[`GUARD_${name}`];
  if (guard !== undefined) return guard;
  return process.env[`FRINK_${name}`];
}

// Env values are strings; treat presence of a non-empty, non-"0", non-"false" value
// as truthy (so `GUARD_NO_LOG=1`, `=true`, `=yes` all enable; `=0`/`=false`/empty don't).
function envBool(name) {
  const v = envVar(name);
  if (v === undefined) return undefined;
  const t = String(v).trim().toLowerCase();
  if (t === '' || t === '0' || t === 'false' || t === 'no') return false;
  return true;
}

// A GUARD_*/FRINK_* flag as a plain boolean — false when unset — for direct `if (envFlag(x))` use.
// Distinct from envBool's undefined-when-unset (which lets config resolution fall through to
// file/DEFAULT via ??). Exported so the review/decisions gates share one truthy-env predicate.
export function envFlag(name) {
  return envBool(name) ?? false;
}

// Load + validate <cwd>/guard.config.json. Missing => {} (defaults stand). Present but
// unparseable / not an object => throw: a typo'd config must fail loudly, never silently
// degrade to defaults and quietly weaken a gate.
function loadConfigFile(cwd) {
  const file = resolve(cwd, CONFIG_FILENAME);
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILENAME} at ${file} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} at ${file} must be a JSON object.`);
  }
  return parsed;
}

const arr = (v, fallback) => (Array.isArray(v) ? v : fallback);

/**
 * Resolve the effective governance-gate config for a consumer repo.
 *
 * @param {string} [cwd=process.cwd()] The CONSUMER repo root. All path fields are
 *   interpreted relative to THIS, never the package dir (W-3).
 * @returns {{
 *   boundaries: string[],
 *   scanRoots: string[],
 *   sourceExtensions: string[],
 *   structure: {trees: object[], walls: object[]},
 *   decisionsDir: string,
 *   fanoutCap: number,
 *   maxLines: number,
 *   fanoutExempt: string[],
 *   allowlistPath: string,
 *   thresholds: object,
 *   indexPath: string|null,
 *   searchTool: string,
 *   graphTool: string,
 *   testCommand: string|null,
 *   review: {backendRoots:string[], frontendRoots:string[], trustBoundaries:string, shortcutTracking:boolean, accessibility:{skipTouchTargets:boolean}, agentsDir:string},
 *   noLog: boolean,
 *   noLlm: boolean,
 *   cwd: string,
 * }}
 */
// Reason: flat config-precedence resolver: each field independently applies the same env ?? file ?? DEFAULT ladder (plus Number.isFinite/Boolean guards); the branch COUNT is high but every branch is a trivial fallback, and the ?? chains ARE the precedence policy — extracting them scatters one resolution table.
// fallow-ignore-next-line complexity
export function resolveGuardConfig(cwd = process.cwd()) {
  const file = loadConfigFile(cwd);

  const noLogEnv = envBool('NO_LOG');
  const noLlmEnv = envBool('DECISION_NO_LLM');
  const indexEnv = envVar('INDEX_PATH');
  const allowlistEnv = envVar('ALLOWLIST_PATH');
  const decisionsEnv = envVar('DECISIONS_DIR');
  const searchToolEnv = envVar('SEARCH_TOOL');
  const graphToolEnv = envVar('GRAPH_TOOL');
  const testCommandEnv = envVar('TEST_COMMAND');

  return {
    boundaries: arr(file.boundaries, DEFAULTS.boundaries),
    scanRoots: arr(file.scanRoots, DEFAULTS.scanRoots),
    sourceExtensions: arr(file.sourceExtensions, DEFAULTS.sourceExtensions),
    // Structure topology: { trees, walls }. Present-but-partial config still gets array defaults.
    structure: file.structure
      ? { trees: arr(file.structure.trees, []), walls: arr(file.structure.walls, []) }
      : DEFAULTS.structure,
    decisionsDir: decisionsEnv ?? file.decisionsDir ?? DEFAULTS.decisionsDir,
    fanoutCap: Number.isFinite(file.fanoutCap) ? file.fanoutCap : DEFAULTS.fanoutCap,
    maxLines: Number.isFinite(file.maxLines) ? file.maxLines : DEFAULTS.maxLines,
    fanoutExempt: arr(file.fanoutExempt, DEFAULTS.fanoutExempt),
    allowlistPath: allowlistEnv ?? file.allowlistPath ?? DEFAULTS.allowlistPath,
    // Shallow-merge thresholds so a consumer can override one knob without restating all.
    thresholds: { ...DEFAULTS.thresholds, ...(file.thresholds ?? {}) },
    // indexPath: env > file > null (null = matcher opt-out / fail-open).
    indexPath: indexEnv ?? file.indexPath ?? DEFAULTS.indexPath,
    // Search-tool steering NAMES: env > file > generic default.
    searchTool: searchToolEnv ?? file.searchTool ?? DEFAULTS.searchTool,
    graphTool: graphToolEnv ?? file.graphTool ?? DEFAULTS.graphTool,
    // Testing-agent command: env > file > null (agents fall back to package.json test).
    testCommand: testCommandEnv ?? file.testCommand ?? DEFAULTS.testCommand,
    // Review-agent topology. Shallow-merge so a consumer can set one key (and nested
    // accessibility) without restating the whole block.
    review: {
      ...DEFAULTS.review,
      ...(file.review ?? {}),
      accessibility: {
        ...DEFAULTS.review.accessibility,
        ...(file.review?.accessibility ?? {}),
      },
    },
    noLog: noLogEnv ?? Boolean(file.noLog ?? DEFAULTS.noLog),
    noLlm: noLlmEnv ?? Boolean(file.noLlm ?? DEFAULTS.noLlm),
    // Echo the resolution base so engines never have to re-derive it (and never reach
    // for __dirname): they resolve every path field against THIS cwd.
    cwd,
  };
}

/**
 * Absolutize a relative path field from a resolved config against the SAME consumer cwd
 * it was resolved with (W-3). Engines call this when they need the on-disk path. An
 * already-absolute configured value is returned unchanged; a null field (e.g. indexPath
 * when the matcher is opted out) stays null so callers can detect the opt-out.
 *
 * @param {{cwd:string}} cfg A config from resolveGuardConfig.
 * @param {string} field One of: decisionsDir, allowlistPath, indexPath, or a scanRoot/
 *   fanoutExempt entry passed via `value`.
 * @param {string} [value] Explicit relative value (for array fields like scanRoots).
 */
export function resolveFromCwd(
  cfg: { cwd: string; [field: string]: unknown },
  field: string,
  value?: string | null,
): string | null {
  // Config path fields are strings|null by contract (DEFAULTS + a validated guard.config.json).
  const raw = (value ?? cfg[field]) as string | null;
  if (raw == null) return null;
  return isAbsolute(raw) ? raw : resolve(cfg.cwd, raw);
}

// The test-file infix (`.test.` / `.spec.`) — constant, so it lives at module scope; the
// extension set is what varies, and that's a plain suffix check (no dynamic RegExp needed).
const TEST_INFIX = /\.(test|spec)\./;

/**
 * Build the impl-file matchers for a `sourceExtensions` list (e.g. `['ts','tsx']` or `['mjs','js']`),
 * so the ratchets are language-agnostic instead of hardcoding `.ts`/`.tsx`. Each returns a predicate:
 * `isSource(name)` true for an impl file; `isTest(name)` for its test variant (`.test.`/`.spec.`);
 * `isBarrel(name)` for an `index` barrel. The ratchets count files where `isSource && !isTest`
 * (fan-out also excludes `isBarrel`).
 *
 * @param {string[]} extensions bare extensions, no dot (e.g. `['ts','tsx']`)
 * @returns {{ isSource: (name:string)=>boolean, isTest: (name:string)=>boolean, isBarrel: (name:string)=>boolean }}
 */
export function sourceMatchers(extensions) {
  const exts = extensions.map((e) => `.${e.startsWith('.') ? e.slice(1) : e}`);
  const isSource = (name) => exts.some((x) => name.endsWith(x));
  return {
    isSource,
    isTest: (name) => TEST_INFIX.test(name) && isSource(name),
    isBarrel: (name) => exts.some((x) => name === `index${x}`),
  };
}

/**
 * A structure tree's effective source extensions: its own `sourceExtensions` override, else the
 * repo-wide `cfg.sourceExtensions`. So a tree can speak `.tsx` in a `.mjs` repo (or vice-versa).
 * @param {{sourceExtensions:string[]}} cfg a resolved config
 * @param {{sourceExtensions?:string[]}} tree a structure.trees[] entry
 * @returns {string[]}
 */
export function resolveTreeExtensions(cfg, tree) {
  return arr(tree?.sourceExtensions, cfg.sourceExtensions);
}
