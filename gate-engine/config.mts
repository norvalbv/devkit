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
 * Relative path fields (scanRoots, decisionsDir, fanoutExempt, allowlistPath, indexPath) are
 * returned EXACTLY as configured — relative — and each engine joins them onto the same `cwd` it
 * was handed, presenting clean repo-relative paths while still resolving against the consumer
 * cwd. `resolveFromCwd(cfg, cwd, field)` yields the absolute form for filesystem access.
 */

import { existsSync, readFileSync } from 'node:fs';
import { LIGHT_JUDGE_MODEL } from './judge/judge-isolation.mts';
import { isAbsolute, resolve } from 'node:path';

// ── Shared config types ──────────────────────────────────────────────────────
/** Matcher/clone tier + size thresholds (DEFAULTS.thresholds; a consumer tunes any subset). */
export interface Thresholds {
  nearCode: number;
  driftCode: number;
  driftDesc: number;
  minLoc: number;
  minTokens: number;
}

/**
 * Coverage-gate config. `false` = the consumer explicitly opts out (bypass). An object enforces the
 * threshold KEYS present in it and ignores the rest — `{}` (the default) enforces no percentage floor
 * but still fails hard when coverage data is absent (the anti-fail-open contract). See coverage/run.mts.
 */
export type CoverageConfig =
  | false
  | { statements?: number; functions?: number; lines?: number; branches?: number };

/** Review-agent topology block of a resolved config (the reviewer subagents read this). */
export interface ReviewConfig {
  backendRoots: string[];
  frontendRoots: string[];
  trustBoundaries: string;
  shortcutTracking: boolean;
  accessibility: { skipTouchTargets: boolean };
  agentsDir: string;
  // sc-2107 judge knobs: env (GUARD_* — see resolvers) > guard.config.json > defaults; 0 = off.
  model: string; // cascade first pass for UNPINNED reviewers
  escalationModel: string; // the cascade's FAIL-escalation second pass for UNPINNED reviewers
  correctnessModel: string; // the correctness single-pass pin
  correctnessChunkLoc: number;
}

/**
 * The effective governance-gate config resolved by resolveGuardConfig. Consumers pull this
 * shape (directly or via `ReturnType<typeof resolveGuardConfig>`); it must stay structurally
 * in sync with the object resolveGuardConfig returns.
 */
export interface GuardConfig {
  boundaries: string[];
  scanRoots: string[];
  cloneRoots: string[];
  sourceExtensions: string[];
  structure: { trees: object[]; walls: object[] };
  decisionsDir: string;
  fanoutCap: number;
  maxLines: number;
  maxTestLines: number;
  fanoutExempt: string[];
  allowlistPath: string;
  thresholds: Thresholds;
  indexPath: string | null;
  indexCommand: string | null;
  indexCommandTimeoutMs: number;
  searchTool: string;
  graphTool: string;
  testCommand: string | null;
  coverage: CoverageConfig;
  review: ReviewConfig;
  research: { referenceCheckouts: string[] };
  noLog: boolean;
  noLlm: boolean;
  cwd: string;
}

// Raw shape of a parsed guard.config.json — every field optional, typed as EXPECTED (the JSON
// boundary). Malformed values are tolerated via the arr()/str()/finite guards, never trusted.
interface RawGuardConfigFile {
  boundaries?: string[];
  scanRoots?: string[];
  cloneRoots?: string[];
  sourceExtensions?: string[];
  structure?: { trees?: object[]; walls?: object[] };
  decisionsDir?: string;
  fanoutCap?: number;
  maxLines?: number;
  maxTestLines?: number;
  fanoutExempt?: string[];
  allowlistPath?: string;
  thresholds?: Partial<Thresholds>;
  indexPath?: string | null;
  indexCommand?: string | null;
  indexCommandTimeoutMs?: number;
  searchTool?: string;
  graphTool?: string;
  testCommand?: string | null;
  coverage?: CoverageConfig;
  review?: {
    backendRoots?: string[];
    frontendRoots?: string[];
    trustBoundaries?: string;
    shortcutTracking?: boolean;
    accessibility?: { skipTouchTargets?: boolean };
    agentsDir?: string;
    model?: string;
    escalationModel?: string;
    correctnessModel?: string;
    correctnessChunkLoc?: number;
  };
  research?: { referenceCheckouts?: string[] };
  noLog?: boolean;
  noLlm?: boolean;
}

export const CONFIG_FILENAME = 'guard.config.json';

// Frink-agnostic defaults: old hardcoded BOUNDARIES / fanout roots are opt-in via guard.config.json.
export const DEFAULTS = Object.freeze({
  // Cross-trust-boundary prefixes for the decision smell gate. Empty by default: a generic repo
  // has no boundaries to straddle, so the cross-boundary-move smell never fires until configured.
  boundaries: [],
  // Where the ratchets / structure scans look for implementation files.
  scanRoots: ['src'],
  // Where the CLONE gate (jscpd) looks. Empty => inherit scanRoots. Split from scanRoots because
  // verbatim-clone scope is often deliberately narrower than semantic-dup scope: a repo can want
  // the matcher over every backend root while the clone gate only polices its UI + main process.
  cloneRoots: [],
  // Source extensions the ratchets count. Default TS — a JS/MJS codebase sets `["mjs","js"]` so
  // the gates SEE its files. Tests are excluded from fan-out but have their own size ceiling.
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
  // shrink-only in .devkit/baselines/size-lines.json. (Per-FUNCTION caps need a parser → not here yet.)
  maxLines: 0,
  // Separate loose test-file ceiling. 0 = OFF; init/upgrade enables it alongside maxLines.
  maxTestLines: 0,
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
  // Optional indexer refresh run before the matcher scans, so the gate judges the code being
  // committed rather than the last indexed state. null = never run one. It is ONLY run when an
  // index already EXISTS in the PRIMARY checkout — never to cold-build one (a from-scratch index
  // is minutes-to-hours and would read as a hung commit) and never through a worktree's linked
  // index (the indexer keys chunks repo-relative, so it would overwrite the primary's rows with
  // the worktree's code). See matcher.mts refreshIndex.
  indexCommand: null,
  // Hard wall-clock ceiling on indexCommand. Bounding ATTEMPTS is not enough — one attempt can
  // itself run for hours when the describe cache misses (a model/prompt-version change).
  indexCommandTimeoutMs: 60_000,
  // Semantic-search + graph tool NAMES the search-tool steering hooks point agents at.
  // Generic defaults — a consumer overrides per-repo via guard.config.json.
  searchTool: 'mcp__codebase__searchCode',
  graphTool: 'graphify',
  // Test command the testing agents run (markdown-prompt agents READ this). null =>
  // agents fall back to the consumer's documented package.json `test` script.
  testCommand: null,
  // Coverage-gate config: `{}` = active-strict (no % floor, but absent coverage data FAILS HARD —
  // a selected gate never silently passes unverified); `false` = explicit opt-out;
  // `{ statements, ... }` enforces the keys present. See coverage/run.mts.
  coverage: Object.freeze({}) as CoverageConfig,
  // Review-agent topology (the reviewer subagents READ these). Generic defaults: `src` as the only
  // backend root, NO frontend topology (empty array = selectReviewers never picks that domain; the
  // gate warns on stderr if such a commit stages frontend files). Enforces WCAG touch targets +
  // skips the tracker/Shortcut rule until opted in.
  review: Object.freeze({
    backendRoots: ['src'],
    frontendRoots: [],
    trustBoundaries: '',
    shortcutTracking: false,
    accessibility: Object.freeze({ skipTouchTargets: false }),
    // Where the synced reviewer agent .md briefs live — guard-review wraps these for its
    // headless judges (the SAME files the root agent dispatches interactively).
    agentsDir: '.claude/agents',
    // Codex family (sc-2054 parity): unpinned cascade terra@high → sol (sc-2190), correctness sol@400 (benched).
    model: LIGHT_JUDGE_MODEL,
    escalationModel: 'gpt-5.6-sol',
    correctnessModel: 'gpt-5.6-sol',
    correctnessChunkLoc: 400,
  }),
  noLog: false, // GUARD_NO_LOG / GUARD_DECISION_NO_LLM (+ FRINK_* aliases)
  noLlm: false,
});

/** A millisecond duration, or undefined for anything that is not a usable positive number. */
function positiveMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function envVar(name: string): string | undefined {
  const guard = process.env[`GUARD_${name}`];
  if (guard !== undefined) return guard;
  return process.env[`FRINK_${name}`];
}

// Truthy env: non-empty, non-"0", non-"false" enables. Exported for hard-by-default gates that
// must distinguish unset (→ default) from an explicit `=0` soften (envFlag folds those).
export function envBool(name: string): boolean | undefined {
  const v = envVar(name);
  if (v === undefined) return undefined;
  const t = String(v).trim().toLowerCase();
  if (t === '' || t === '0' || t === 'false' || t === 'no') return false;
  return true;
}

// A GUARD_*/FRINK_* flag as a plain boolean — false when unset — vs envBool's undefined-when-unset
// (which lets config resolution fall through via ??). One shared truthy-env predicate.
export function envFlag(name: string): boolean {
  return envBool(name) ?? false;
}

/**
 * Is the coverage gate bypassed for THIS run? Lives here — beside envFlag, not in coverage/run.mts —
 * because guard-deterministic must ask the same question to salt its prefix-cache scope, and a
 * second copy of the predicate is exactly what the dup/clone gates exist to stop.
 *
 * Two spellings, deliberately. `GUARD_COVERAGE_OK` is canonical: the GUARD_QAVIS_OK analogue ("ship
 * this change without the verification"), and the ONLY one any remedy line prints. `GUARD_NO_COVERAGE`
 * is an accepted alias because it is the name agents actually guess — blocked ship attempts in the
 * field grepped devkit's dist for `GUARD_NO_COVERAGE|SKIP_COVERAGE|NO_COVERAGE|COVERAGE_SKIP` and
 * found nothing, then routed around the tool entirely. A bypass nobody can guess the name of is the
 * same dead end as no bypass at all.
 *
 * NOT a way to disable the gate for a repo — that is `"coverage": false` in guard.config.json. This
 * is a per-invocation operator assertion, and guard-deterministic salts the prefix cache so it can
 * never authorise a later un-bypassed run against the same tree.
 */
export function coverageBypassed(): boolean {
  return envFlag('COVERAGE_OK') || envFlag('NO_COVERAGE');
}

/**
 * Is structure lint bypassed for THIS run? The orchestrator owns this predicate rather than
 * guard-structure because Electron consumers supply their own arbitrary eslint command through
 * `--structure`; putting the bypass inside guard-structure would leave those consumers wedged.
 *
 * `GUARD_STRUCTURE_OK` is the canonical operator assertion. `GUARD_NO_STRUCTURE` is the accepted
 * guessable alias, matching coverageBypassed. guard-deterministic banners + telemeters the skip and
 * salts its prefix-cache scope so this one-run assertion cannot authorise a later normal run.
 */
export function structureBypassed(): boolean {
  return envFlag('STRUCTURE_OK') || envFlag('NO_STRUCTURE');
}

/**
 * Does THIS run refuse to accept a deterministic gate's fail-open? Lives beside coverageBypassed for
 * the same reason: guard-deterministic asks it twice — once to decide the verdict, once to salt the
 * prefix-cache scope — and a second copy of the predicate is what the dup/clone gates exist to stop.
 *
 * The sibling of GUARD_AI_STRICT, not an instance of it. AI strict answers "an AI gate could not
 * reach its model", and exits 3 so an outage is never rendered as a finding. This answers "a
 * DETERMINISTIC gate opted out" — a local, reproducible condition (no index, no jscpd binary) with
 * no outage to distinguish, so it exits 1 through the ordinary failure path.
 *
 * Off by default, and deliberately not exported by `devkit ship`: fail-open is the shipped posture
 * (docs/decisions/zero-consumer-tool-deps.md), and flipping it for every consumer whose index or
 * jscpd is absent would turn a documented opt-out into a broken commit. This is the opt-in lever for
 * a repo that HAS wired those tools and wants a skipped gate to be fatal.
 *
 * A function, never a hoisted const: prefixCacheScope is called more than once per process and the
 * tests toggle the env between calls.
 */
export function deterministicStrict(): boolean {
  return envFlag('DETERMINISTIC_STRICT');
}

// Load + validate <cwd>/guard.config.json. Missing => {} (defaults stand). Present but
// unparseable / not an object => throw: a typo'd config must fail loudly, never weaken a gate.
function loadConfigFile(cwd: string): RawGuardConfigFile {
  const file = resolve(cwd, CONFIG_FILENAME);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: unknown) {
    throw new Error(
      `${CONFIG_FILENAME} at ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} at ${file} must be a JSON object.`);
  }
  // Parse boundary: assert the validated object to the raw-config shape (fields typed as
  // expected; the resolver below re-guards every one before trusting it).
  return parsed as RawGuardConfigFile;
}

const arr = <T,>(v: unknown, fallback: T[]): T[] => (Array.isArray(v) ? v : fallback);
// Malformed review knobs fall to DEFAULTS (a non-string model must never reach judge argv; a
// non-numeric cap must never silently disable chunking): representation guards, typed not trusted.
const str = (v: string | undefined, d: string): string =>
  v != null && `${v}` === v && v.trim() !== '' ? v.trim() : d;
const nonNegInt = (v: number | undefined, d: number): number =>
  v !== undefined && Number.isInteger(v) && v >= 0 ? v : d;

/**
 * Resolve the effective governance-gate config for a consumer repo.
 *
 * @param cwd The CONSUMER repo root (default process.cwd()). All path fields are
 *   interpreted relative to THIS, never the package dir (W-3).
 * @returns the resolved {@link GuardConfig}.
 */
// Reason: flat config-precedence resolver: each field independently applies the same env ?? file ?? DEFAULT ladder (plus Number.isFinite/Boolean guards); the branch COUNT is high but every branch is a trivial fallback, and the ?? chains ARE the precedence policy — extracting them scatters one resolution table.
// fallow-ignore-next-line complexity
export function resolveGuardConfig(cwd = process.cwd()): GuardConfig {
  const file = loadConfigFile(cwd);
  const fr = file.review ?? {};
  const dr = DEFAULTS.review;

  const noLogEnv = envBool('NO_LOG');
  const noLlmEnv = envBool('DECISION_NO_LLM');
  const indexEnv = envVar('INDEX_PATH');
  const indexCommandEnv = envVar('INDEX_COMMAND');
  const indexTimeoutEnv = Number(envVar('INDEX_COMMAND_TIMEOUT_MS'));
  const allowlistEnv = envVar('ALLOWLIST_PATH');
  const decisionsEnv = envVar('DECISIONS_DIR');
  const searchToolEnv = envVar('SEARCH_TOOL');
  const graphToolEnv = envVar('GRAPH_TOOL');
  const testCommandEnv = envVar('TEST_COMMAND');

  return {
    boundaries: arr(file.boundaries, DEFAULTS.boundaries),
    scanRoots: arr(file.scanRoots, DEFAULTS.scanRoots),
    // cloneRoots falls back to scanRoots, not to DEFAULTS.cloneRoots (`[]`) — an unset key must
    // mean "same scope as the matcher", never "scan nothing" (which would silently kill the gate).
    cloneRoots: arr(file.cloneRoots, arr(file.scanRoots, DEFAULTS.scanRoots)),
    sourceExtensions: arr(file.sourceExtensions, DEFAULTS.sourceExtensions),
    // Structure topology: { trees, walls }. Present-but-partial config still gets array defaults.
    structure: file.structure
      ? { trees: arr(file.structure.trees, []), walls: arr(file.structure.walls, []) }
      : DEFAULTS.structure,
    decisionsDir: decisionsEnv ?? file.decisionsDir ?? DEFAULTS.decisionsDir,
    fanoutCap:
      typeof file.fanoutCap === 'number' && Number.isFinite(file.fanoutCap)
        ? file.fanoutCap
        : DEFAULTS.fanoutCap,
    maxLines:
      typeof file.maxLines === 'number' && Number.isFinite(file.maxLines)
        ? file.maxLines
        : DEFAULTS.maxLines,
    maxTestLines:
      typeof file.maxTestLines === 'number' && Number.isFinite(file.maxTestLines)
        ? file.maxTestLines
        : DEFAULTS.maxTestLines,
    fanoutExempt: arr(file.fanoutExempt, DEFAULTS.fanoutExempt),
    allowlistPath: allowlistEnv ?? file.allowlistPath ?? DEFAULTS.allowlistPath,
    // Shallow-merge thresholds so a consumer can override one knob without restating all.
    thresholds: { ...DEFAULTS.thresholds, ...(file.thresholds ?? {}) },
    // indexPath: env > file > null (null = matcher opt-out / fail-open).
    indexPath: indexEnv ?? file.indexPath ?? DEFAULTS.indexPath,
    // indexCommand: env > file > null (null = never refresh the index before scanning).
    indexCommand: indexCommandEnv ?? file.indexCommand ?? DEFAULTS.indexCommand,
    // env > file > default, like every other key — CI needs to shorten/extend the refresh
    // deadline without editing a committed guard.config.json. Must be POSITIVE: node reads a 0
    // timeout as "no timeout", so accepting 0 (which is what `Number('')` yields for an
    // empty env var) would silently remove the wall-clock bound this exists to enforce.
    indexCommandTimeoutMs:
      positiveMs(indexTimeoutEnv) ??
      positiveMs(file.indexCommandTimeoutMs) ??
      DEFAULTS.indexCommandTimeoutMs,
    // Search-tool steering NAMES: env > file > generic default.
    searchTool: searchToolEnv ?? file.searchTool ?? DEFAULTS.searchTool,
    graphTool: graphToolEnv ?? file.graphTool ?? DEFAULTS.graphTool,
    // Testing-agent command: env > file > null (agents fall back to package.json test).
    testCommand: testCommandEnv ?? file.testCommand ?? DEFAULTS.testCommand,
    // Coverage: explicit `false` = opt-out; any plain object = thresholds; anything else (absent,
    // array, non-object) falls back to the active-strict `{}` default. A malformed value never
    // silently disables the gate — only a literal `false` does.
    coverage:
      file.coverage === false
        ? false
        : file.coverage && typeof file.coverage === 'object' && !Array.isArray(file.coverage)
          ? file.coverage
          : DEFAULTS.coverage,
    // Review-agent topology, shallow-merged so a consumer can set one key without restating the block.
    review: {
      ...DEFAULTS.review,
      ...fr,
      model: str(fr.model, dr.model),
      escalationModel: str(fr.escalationModel, dr.escalationModel),
      correctnessModel: str(fr.correctnessModel, dr.correctnessModel),
      correctnessChunkLoc: nonNegInt(fr.correctnessChunkLoc, dr.correctnessChunkLoc),
      accessibility: { ...dr.accessibility, ...(fr.accessibility ?? {}) },
    },
    // Reference-checkout globs for the prior-art agent's local research leg. Declared-only:
    // an empty resolution means the leg attests `unavailable`, never a silent scan of
    // undeclared sibling checkouts. Globs resolve against cwd (W-3: the config's directory).
    research: { referenceCheckouts: arr(file.research?.referenceCheckouts, []) },
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
 * @param cfg A config from resolveGuardConfig.
 * @param field The string|null path field to absolutize: decisionsDir, allowlistPath, or indexPath.
 * @param value Explicit relative value override (e.g. for an array field like a scanRoots entry).
 */
export function resolveFromCwd(
  cfg: GuardConfig,
  field: 'allowlistPath' | 'decisionsDir' | 'indexPath',
  value?: string | null,
): string | null {
  // Config path fields are string|null by contract (DEFAULTS + a validated guard.config.json).
  const raw = value ?? cfg[field];
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
 * `isBarrel(name)` for an `index` barrel. Fan-out and disable debt use non-test implementation
 * files; the raw-line ratchet also uses `isTest` to apply its separate test ceiling.
 *
 * @param extensions bare extensions, no dot (e.g. `['ts','tsx']`)
 */
export function sourceMatchers(extensions: string[]) {
  const exts = extensions.map((e) => `.${e.startsWith('.') ? e.slice(1) : e}`);
  const isSource = (name: string) => exts.some((x) => name.endsWith(x));
  return {
    isSource,
    isTest: (name: string) => TEST_INFIX.test(name) && isSource(name),
    isBarrel: (name: string) => exts.some((x) => name === `index${x}`),
  };
}

/**
 * A structure tree's effective source extensions: its own `sourceExtensions` override, else the
 * repo-wide `cfg.sourceExtensions`. So a tree can speak `.tsx` in a `.mjs` repo (or vice-versa).
 * @param cfg a resolved config
 * @param tree a structure.trees[] entry
 */
export function resolveTreeExtensions(
  cfg: { sourceExtensions: string[] },
  tree: { sourceExtensions?: string[] } | null | undefined,
): string[] {
  return arr(tree?.sourceExtensions, cfg.sourceExtensions);
}
