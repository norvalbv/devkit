/**
 * `devkit doctor` — diagnose drift between a consumer repo and what `devkit init` wires.
 *
 * Read-only by default; `--fix` re-runs the idempotent init steps (but NEVER touches baselines —
 * those are cut once at init; an absent one is healthy, enforced from config). Exit: 0 all-ok, 1
 * drift, 2 not-initialized.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RECOMMENDED_GUARD_IDS, type Selection } from '../lib/components.mts';
import { detectGitRoot } from '../lib/detect-git-root.mts';
import { packageDir, readJson, sha256 } from '../lib/fs-helpers.mts';
import { markEnd, markStart } from '../lib/husky/husky.mts';
import { extractGuardBlock } from '../lib/husky/husky-block.mts';
import { checkHookRegistrations } from '../lib/install/install-hooks.mts';
import { HEAL_ALIAS_NAME, isHealAlias, syncOverlayHook } from '../lib/overlay.mts';
import { globalHookInstalled, globalInitPath } from '../lib/overlay-global-hook.mts';
import { structureCmdFor } from './init.mts';
import { cmpSemver } from './update.mts';

// A devkit dep ref counts as "pinned" when it ends in a #v<digit> tag.
const PINNED_TAG = /#v\d/;

// devkit's own modules under packageDir() are .mts in dev (this repo) but compiled .mjs in an
// installed consumer (dist). Derive the extension from THIS module so packageDir()-relative refs to
// devkit's own gate/CLI files resolve in both — these are runtime string paths tsc emit won't rewrite.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';

// One check result. status ∈ OK | DRIFT | MISSING. `fixable` flags whether --fix can touch it.
type CheckStatus = 'OK' | 'DRIFT' | 'MISSING';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation: string;
  fixable: boolean;
}

// A jsonc/json config carrying an `extends` base pointer; the index signature lets checkExtends read
// an arbitrary `key` (defaults to "extends") out of the parsed object.
interface ConfigWithExtends {
  extends?: string | string[];
  [key: string]: unknown;
}

// The devkit-owned `extends` pointer for each emitted config, by install mode (see expectedExtends).
interface ExpectedExtends {
  biome: string;
  tsconfig: string;
}

// A skills / agents / agent-hooks manifest: repo-relative path → recorded sha256.
interface Manifest {
  files: Record<string, string>;
}

// The recorded .devkit/config.json shape doctor reads (only the fields it consults).
interface DevkitConfig {
  overlay?: boolean;
  standalone?: boolean;
  stack?: string;
  components?: Partial<Selection>;
  configOverrides?: string[];
  minDevkit?: string;
  devkitRef?: string;
}

// The gate-engine config module, imported via a runtime path (so it's typed here, not resolved).
interface GateConfigModule {
  resolveGuardConfig(cwd: string): unknown;
}

function check(
  name: string,
  status: CheckStatus,
  detail: string,
  remediation = '',
  fixable = false,
): CheckResult {
  return { name, status, detail, remediation, fixable };
}

function checkConfig(cwd: string): CheckResult {
  if (!existsSync(join(cwd, '.devkit', 'config.json'))) {
    return check('.devkit/config.json', 'MISSING', 'not initialized', 'run `devkit init`');
  }
  return check('.devkit/config.json', 'OK', 'present');
}

// Selection-aware: only the SELECTED guards must be present in the block (a deselected
// guard being absent is correct, not drift). Monorepo: the hook lives at the git root and the
// block is package-scoped — resolve both from cwd.
function checkHusky(cwd: string, selectedGuards: string[]): CheckResult {
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) {
    return check('.husky/pre-commit', 'MISSING', 'no hook', 'run `devkit init`', true);
  }
  const content = readFileSync(hookPath, 'utf8');
  if (!content.includes(markStart(pkgRel)) || !content.includes(markEnd(pkgRel))) {
    return check(
      '.husky/pre-commit',
      'DRIFT',
      pkgRel ? `no devkit-guards block for "${pkgRel}"` : 'no devkit-guards marker block',
      'run `devkit init` (appends the block)',
      true,
    );
  }
  const block = extractGuardBlock(content, pkgRel) ?? '';
  // The deterministic guards (size/fanout/dup/clone) run through the SINGLE `guard-deterministic`
  // orchestrator (which re-reads the selection from .devkit/config.json at commit time); the AI
  // guards (decisions/review) keep their own per-id fragment. So verify one `guard-deterministic`
  // call when any deterministic guard is selected, plus each selected AI guard's sentinel. A block
  // that predates this collapse (per-guard `bunx guard-X` lines, no `guard-deterministic`) fails
  // the first check and is flagged for regeneration.
  const AI = new Set(['decisions', 'review']);
  const missing: string[] = [];
  if (selectedGuards.some((g) => !AI.has(g)) && !block.includes('guard-deterministic')) {
    missing.push('deterministic gates');
  }
  for (const g of selectedGuards) {
    if (AI.has(g) && !block.includes(`guard-${g}`)) missing.push(g);
  }
  if (missing.length) {
    return check(
      '.husky/pre-commit',
      'DRIFT',
      `block missing gate(s): ${missing.join(', ')}`,
      'run `devkit init --force` (or `devkit upgrade`) to regenerate the block',
      true,
    );
  }
  return check(
    '.husky/pre-commit',
    'OK',
    selectedGuards.length
      ? `block calls: ${selectedGuards.join(', ')}`
      : 'block present (no guards selected)',
  );
}

// Structure-lint check (only when `structure` is selected). `structure` is NOT a guard, so
// checkHusky never verifies it. Structure joins the deterministic orchestrator via a `--structure
// "<cmd>"` arg on the `guard-deterministic` line: config-driven stacks run devkit's own
// `guard-structure gate` (no consumer eslint dep); electron keeps its consumer-side `bunx eslint
// src`. Match that exact arg — its absence means structure-lint is not wired.
function checkStructureLint(cwd: string, stack: string): CheckResult {
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) {
    return check('structure-lint', 'MISSING', 'no hook', 'run `devkit init`', true);
  }
  const block = extractGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel) ?? '';
  const expectedCmd = structureCmdFor(stack);
  if (!block.includes(`--structure "${expectedCmd}"`)) {
    return check(
      'structure-lint',
      'DRIFT',
      `no \`--structure "${expectedCmd}"\` on the guard-deterministic line`,
      'run `devkit init --force` to enable it',
      true,
    );
  }
  return check('structure-lint', 'OK', `runs \`${expectedCmd}\``);
}

// Strip // line comments so a jsonc config parses as JSON.
const JSONC_LINE_COMMENT_RE = /^\s*\/\/.*$/gm;
function jsoncText(path: string): string {
  return readFileSync(path, 'utf8').replace(JSONC_LINE_COMMENT_RE, '');
}

// A jsonc-tolerant read (null on absent OR unparseable) — used where a corrupt file just means
// "no usable value" (repairExtends). The drift CHECK parses strictly so it can report WHY.
function readJsonc(path: string): ConfigWithExtends | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(jsoncText(path)) as ConfigWithExtends;
  } catch {
    return null;
  }
}

// The extends pointer each config must carry, by install mode. Standalone extends VENDORED
// relative paths (.devkit/*); package extends the resolved dep. Single source of truth shared by
// the check (collectResults) and the --fix repair, so --fix writes exactly what doctor expects.
// Package-mode biome preset by stack — MUST mirror templates/<stack>/biome.jsonc: react-app and
// component-lib extend biome/react, everything else biome/base. (Standalone is a SEPARATE map,
// standalone.mjs `biomeVariant`; keep the two independent — do NOT add a stack to the standalone
// list below without also vendoring the matching file, or doctor would expect a react.jsonc that
// init writes as base.jsonc → a brand-new standalone false-DRIFT.)
const PKG_REACT_BIOME = new Set(['react-app', 'component-lib']);

function expectedExtends(stack: string, standalone: boolean): ExpectedExtends {
  return {
    biome: standalone
      ? `./.devkit/biome/${['electron', 'react-app', 'next', 'component-lib'].includes(stack) ? 'react' : 'base'}.jsonc`
      : `@norvalbv/devkit/biome/${PKG_REACT_BIOME.has(stack) ? 'react' : 'base'}`,
    tsconfig: standalone
      ? `./.devkit/tsconfig/${stack === 'next' ? 'next' : stack === 'node-service' ? 'node' : 'base'}.json`
      : '@norvalbv/devkit/tsconfig/base',
  };
}

function checkExtends(
  cwd: string,
  file: string,
  expected: string,
  key = 'extends',
  overridden = false,
): CheckResult {
  const path = join(cwd, file);
  if (!existsSync(path)) {
    return check(file, 'MISSING', 'absent', 'run `devkit init`', true);
  }
  let parsed: ConfigWithExtends;
  try {
    parsed = JSON.parse(jsoncText(path)) as ConfigWithExtends;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return check(file, 'DRIFT', `invalid JSON: ${msg}`, 'fix the JSON syntax, then re-run');
  }
  // A consumer can intentionally hand-own an emitted config (e.g. a tuned tsconfig with no devkit
  // `extends`). Recording the file in .devkit/config.json `configOverrides` tells doctor that's
  // deliberate, not drift — but only AFTER validating the JSON, so a hand-edit that breaks the syntax
  // (which would break biome/tsc at build time) still surfaces as DRIFT rather than a false OK.
  if (overridden) {
    return check(file, 'OK', 'intentional override (configOverrides)');
  }
  const ext = parsed[key];
  const list = Array.isArray(ext) ? ext : [ext];
  if (!list.includes(expected)) {
    return check(
      file,
      'DRIFT',
      `${key} is ${JSON.stringify(ext)}`,
      `should extend "${expected}" (if intentional, add "${file}" to .devkit/config.json configOverrides)`,
    );
  }
  return check(file, 'OK', `extends ${expected}`);
}

async function checkGuardConfig(cwd: string): Promise<CheckResult> {
  const path = join(cwd, 'guard.config.json');
  if (!existsSync(path)) {
    return check('guard.config.json', 'MISSING', 'absent', 'run `devkit init`', true);
  }
  // resolveGuardConfig throws on a corrupt file — that's the validity signal.
  try {
    const mod = (await import(
      pathToFileURL(join(packageDir(), 'gate-engine', `config${SELF_EXT}`)).href
    )) as GateConfigModule;
    mod.resolveGuardConfig(cwd);
    return check('guard.config.json', 'OK', 'valid (resolveGuardConfig parsed it)');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return check('guard.config.json', 'DRIFT', msg, 'fix the config JSON');
  }
}

// Reason: the branches ARE the manifest-drift algorithm — per file, two independent SHA comparisons
// (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a
// missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift
// verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
async function checkSkills(cwd: string, surface = 'claude'): Promise<CheckResult> {
  // Skills are repo-wide → manifest + the agent-surface dir live at the git root (cwd for a
  // single-package repo). Verify against the selected surface (.claude or .cursor — same content).
  const { gitRoot } = detectGitRoot(cwd);
  const manifestPath = join(gitRoot, '.devkit', 'skills-manifest.json');
  const manifest = readJson(manifestPath) as Manifest | null;
  if (!manifest) {
    return check('skills', 'MISSING', 'no skills-manifest.json', 'run `devkit sync-skills`', true);
  }
  const skillsSrc = join(packageDir(), 'skills');
  const consumerDrift: string[] = [];
  const sourceDrift: string[] = [];
  for (const [rel, recordedSha] of Object.entries(manifest.files)) {
    const srcPath = join(skillsSrc, rel);
    if (existsSync(srcPath) && sha256(srcPath) !== recordedSha) sourceDrift.push(rel);
    const consumerPath = join(gitRoot, `.${surface}`, 'skills', rel);
    if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha) consumerDrift.push(rel);
  }
  if (sourceDrift.length || consumerDrift.length) {
    const parts: string[] = [];
    if (sourceDrift.length) parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
    if (consumerDrift.length) parts.push(`consumer copy drifted (${consumerDrift.length})`);
    return check('skills', 'DRIFT', parts.join('; '), 'run `devkit sync-skills`', true);
  }
  return check('skills', 'OK', `${Object.keys(manifest.files).length} file(s) in sync`);
}

// Agents are repo-wide → manifest + the agent-surface dir live at the git root (same contract as skills).
// Reason: the branches ARE the manifest-drift algorithm (same contract as checkSkills): per file, two independent SHA comparisons (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
async function checkAgents(cwd: string, surface = 'claude'): Promise<CheckResult> {
  const { gitRoot } = detectGitRoot(cwd);
  const manifest = readJson(join(gitRoot, '.devkit', 'agents-manifest.json')) as Manifest | null;
  if (!manifest) {
    return check('agents', 'MISSING', 'no agents-manifest.json', 'run `devkit sync-agents`', true);
  }
  const agentsSrc = join(packageDir(), 'agents');
  const consumerDrift: string[] = [];
  const sourceDrift: string[] = [];
  for (const [rel, recordedSha] of Object.entries(manifest.files)) {
    const srcPath = join(agentsSrc, rel);
    if (existsSync(srcPath) && sha256(srcPath) !== recordedSha) sourceDrift.push(rel);
    const consumerPath = join(gitRoot, `.${surface}`, 'agents', rel);
    if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha) consumerDrift.push(rel);
  }
  if (sourceDrift.length || consumerDrift.length) {
    const parts: string[] = [];
    if (sourceDrift.length) parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
    if (consumerDrift.length) parts.push(`consumer copy drifted (${consumerDrift.length})`);
    return check('agents', 'DRIFT', parts.join('; '), 'run `devkit sync-agents`', true);
  }
  return check('agents', 'OK', `${Object.keys(manifest.files).length} agent file(s) in sync`);
}

// agentHooks: the six synced scripts (under <surface>/hooks) match the manifest, and are present.
function checkAgentHookScripts(cwd: string, surface = 'claude'): CheckResult {
  const { gitRoot } = detectGitRoot(cwd);
  const manifest = readJson(
    join(gitRoot, '.devkit', 'agent-hooks-manifest.json'),
  ) as Manifest | null;
  if (!manifest) {
    return check(
      'agent-hooks',
      'MISSING',
      'no agent-hooks-manifest.json',
      'run `devkit init`',
      true,
    );
  }
  const drift = Object.keys(manifest.files).filter((rel) => {
    const p = join(gitRoot, `.${surface}`, 'hooks', rel);
    return !existsSync(p) || sha256(p) !== manifest.files[rel];
  });
  if (drift.length) {
    return check(
      'agent-hooks',
      'DRIFT',
      `${drift.length} script(s) drifted/absent`,
      'run `devkit init`',
      true,
    );
  }
  return check('agent-hooks', 'OK', `${Object.keys(manifest.files).length} hook script(s) in sync`);
}

// Hook registrations present in .claude/settings.json for the selected hook-owning components.
function checkRegistrations(cwd: string, hookComponents: string[]): CheckResult {
  const { gitRoot } = detectGitRoot(cwd);
  const { ok, missing } = checkHookRegistrations(gitRoot, hookComponents);
  if (ok) return check('hook registrations', 'OK', `${hookComponents.join(', ')} registered`);
  return check(
    'hook registrations',
    'DRIFT',
    `${missing.length} command(s) not in .claude/settings.json`,
    'run `devkit init` to re-register',
    true,
  );
}

// searchSteering: the guard + counter engine bins are present in the installed package.
function checkSearchToolBins(): CheckResult {
  const dir = join(packageDir(), 'gate-engine', 'search-tool');
  const missing = [`search-tool-guard${SELF_EXT}`, `search-tool-counter${SELF_EXT}`].filter(
    (f) => !existsSync(join(dir, f)),
  );
  if (missing.length) {
    return check(
      'search-steering bins',
      'MISSING',
      `engine bin(s) absent: ${missing.join(', ')}`,
      'reinstall @norvalbv/devkit',
    );
  }
  return check('search-steering bins', 'OK', 'guard + counter present');
}

function checkBaselines(cwd: string): CheckResult {
  const has = (p: string) => existsSync(join(cwd, 'eslint', 'baselines', p));
  const present = (['fanout', 'size'] as const).filter((n) => has(`${n}.json`));
  // A ratchet baseline holds ONLY grandfathered debt and is cut once at init. An absent one means
  // "no debt — cap enforced from guard.config.json", which is healthy, not drift. So this is purely
  // informational: never MISSING, never a --fix target.
  return check(
    'baselines',
    'OK',
    present.length
      ? `grandfathered debt: ${present.join(' + ')}`
      : 'no grandfathered debt (enforced from config)',
  );
}

function checkPin(cwd: string): CheckResult {
  const pkg = readJson(join(cwd, 'package.json')) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  } | null;
  const ref = pkg?.devDependencies?.['@norvalbv/devkit'] ?? pkg?.dependencies?.['@norvalbv/devkit'];
  if (!ref) return check('devkit pin', 'MISSING', 'not a dependency', 'run `devkit init`', true);
  if (PINNED_TAG.test(ref)) return check('devkit pin', 'OK', `pinned ${ref.split('#').pop()}`);
  return check(
    'devkit pin',
    'DRIFT',
    'not pinned to a #v* tag (bare SHA/branch)',
    'pin to #v<version> for reproducible installs',
  );
}

const SEMVER = /^\d+\.\d+\.\d+$/;

// Warn if the RUNNING devkit is OLDER than the version this repo was set up with (stamped in
// .devkit/config.json at init) or below a hand-declared `minDevkit` floor. Read-only, warn-only —
// a contributor on a stale devkit is told to `devkit update`, never blocked. Uses .devkit/config.json
// only (NOT package.json), so overlay/standalone repos introduce nothing into the shared tree.
export function checkVersion(cwd: string): CheckResult {
  const pkg = readJson(join(packageDir(), 'package.json')) as { version?: string } | null;
  const running = pkg?.version;
  if (!running || !SEMVER.test(running)) return check('devkit version', 'OK', 'unknown');
  const cfg = readJson(join(cwd, '.devkit', 'config.json')) as DevkitConfig | null;
  const min = cfg?.minDevkit;
  // The init-time devkit version is the `devkitRef` pin (`vX.Y.Z`). Use it as the drift baseline
  // when it's a clean version tag — devkitRef can also be 'main'/a branch/SHA, which has no baseline.
  const ref = cfg?.devkitRef;
  const stamped = typeof ref === 'string' && ref.startsWith('v') ? ref.slice(1) : undefined;
  if (min && SEMVER.test(min) && cmpSemver(running, min) < 0) {
    return check(
      'devkit version',
      'DRIFT',
      `installed ${running} < required minimum ${min}`,
      'devkit update',
    );
  }
  if (stamped && SEMVER.test(stamped) && cmpSemver(running, stamped) < 0) {
    return check(
      'devkit version',
      'DRIFT',
      `installed ${running} older than this repo's init (${stamped})`,
      'devkit update',
    );
  }
  // Echo whichever floors are declared so a satisfied min/stamp is visibly active, not silent.
  const meta = [stamped && `repo init ${stamped}`, min && `min ${min}`].filter(Boolean).join(', ');
  return check('devkit version', 'OK', `installed ${running}${meta ? ` (${meta})` : ''}`);
}

// Configs whose drifted `extends` pointer --fix can repair IN PLACE (kind → expectedExtends key).
// The top-level config is the CONSUMER's (it carries paths, libs, plugins, overrides); only the
// pointer it extends is devkit-owned. guard.config.json is excluded: --fix never touches its content
// — it's only recreated when MISSING (by plain, create-if-absent init).
const EXTENDS_REPAIRABLE: Record<string, 'biome' | 'tsconfig'> = {
  'biome.jsonc': 'biome',
  'tsconfig.json': 'tsconfig',
};

// Swap a config's `extends` base pointer to `expected`, preserving every other byte (comments and
// repo deltas) by replacing only the pointer token in the raw text. Returns true if rewritten.
// biome's extends is an array, tsconfig's a bare string — both hold a single devkit base pointer.
// No-op when unparseable, already correct, or no devkit pointer is present (left for the report).
function repairExtends(path: string, expected: string): boolean {
  if (!existsSync(path)) return false;
  const ext = readJsonc(path)?.extends;
  const list = Array.isArray(ext) ? ext : ext == null ? [] : [ext];
  if (list.includes(expected)) return false;
  const old = list.find((v) => typeof v === 'string' && v.includes('devkit'));
  if (!old) return false;
  const raw = readFileSync(path, 'utf8');
  const next = raw.replace(JSON.stringify(old), JSON.stringify(expected));
  if (next === raw) return false;
  writeFileSync(path, next);
  return true;
}

// Turn a recorded component selection into the init flag list that reproduces it, so
// `--fix` re-runs init for the RECORDED selection (not the all-on --yes default).
function selectionFlags(sel: Partial<Selection>): string[] {
  const flags = ['--yes'];
  const toggles: (keyof Selection)[] = ['biome', 'tsconfig', 'skills', 'husky', 'structure'];
  for (const id of toggles) {
    if (sel[id] === false) flags.push(`--no-${id}`);
  }
  if (!sel.guards?.length) flags.push('--no-guards');
  else flags.push('--guards', sel.guards.join(','));
  // Preserve the recorded agent-surface choice so --fix never re-adds a deselected surface.
  for (const t of ['claude', 'cursor']) {
    if (sel.agentTargets && !sel.agentTargets.includes(t)) flags.push(`--no-${t}`);
  }
  return flags;
}

// --fix: repair fixable findings. NEVER refreeze (only recreate MISSING baselines), and NEVER
// clobber a consumer-tuned file: a DRIFTED config has only its `extends` pointer repaired in place
// (deltas + comments survive). MISSING files + husky go through `init` for the RECORDED selection
// (selectionFlags) AND the recorded install mode (standalone) — so --fix never silently re-adds a
// deselected component nor writes a package dep into a no-package (standalone) repo.
// Reason: flat repair orchestration: independent sequential `if (this kind drifted) repair it` steps (extends-repair loop, init re-run, sync-skills, recreate-missing-baseline) with near-zero nesting; high branch COUNT, each a trivial guarded fixup. Splitting scatters the deliberate repair ordering.
// fallow-ignore-next-line complexity
function applyFix(
  cwd: string,
  results: CheckResult[],
  sel: Partial<Selection>,
  stack: string,
  standalone: boolean,
): void {
  console.log('\n--fix: re-running idempotent steps for the recorded selection...');

  // Repair only a drifted `extends` pointer, in place, to the mode-correct value — never the
  // consumer's tuned content. A MISSING config is (re)created by init below, not here.
  const want = expectedExtends(stack, standalone);
  for (const r of results) {
    const kind = EXTENDS_REPAIRABLE[r.name];
    if (kind && r.status === 'DRIFT' && repairExtends(join(cwd, r.name), want[kind])) {
      console.log(`  ✓ repaired ${r.name} extends → ${want[kind]}`);
    }
  }

  // MISSING template files / husky drift → init for the recorded selection (idempotent).
  const needsInit = results.some(
    (r) => r.fixable && r.status === 'MISSING' && r.name !== 'baselines' && r.name !== 'skills',
  );
  // The guard block AND its structure-lint `--structure` arg both live in the .husky/pre-commit
  // deterministic line, which init rebuilds from the recorded selection — so a drifted structure-lint
  // result takes the same init repair path (it flags itself fixable, else --fix would no-op it).
  const huskyDrift = results.some(
    (r) => (r.name === '.husky/pre-commit' || r.name === 'structure-lint') && r.status !== 'OK',
  );
  if (needsInit || huskyDrift) {
    const args = ['init', '--stack', stack, ...selectionFlags(sel)];
    // Preserve the recorded install mode: a standalone repo re-inits standalone (no package dep).
    if (standalone) args.push('--standalone');
    execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), ...args], {
      cwd,
      stdio: 'inherit',
    });
  }
  const skills = results.find((r) => r.name === 'skills');
  if (skills && skills.status !== 'OK') {
    execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), 'sync-skills'], {
      cwd,
      stdio: 'inherit',
    });
  }
  // No baseline recreation here: baselines are cut once at init and an absent one is healthy (no
  // grandfathered debt — the cap is enforced from guard.config.json). An explicit re-cut is `guard-*
  // freeze`, never doctor --fix.
}

// The default component selection (pre-`components`-block configs, and the all-on fallback).
const DEFAULT_DOCTOR_SEL: Partial<Selection> = {
  biome: true,
  tsconfig: true,
  skills: true,
  husky: true,
  structure: false,
  guards: [...RECOMMENDED_GUARD_IDS],
};

// Overlay (local-only) doctor: the local hook + core.hooksPath (husky re-claims it on install) gate
// the exit code; the agent-half + fallow are ADVISORY (a re-run heals them, like the alias).
// Package/pin/extends checks don't apply. Prints its own report; returns the exit code.
// Reason: flat overlay health report: git-config reads for core.hooksPath + the self-heal alias, then
// a linear ✓/⚠/· print per signal + advisory agent-half/fallow checks; high branch COUNT, near-zero
// nesting, and the exit code stays gated on hook+path only (everything else is advisory)
// fallow-ignore-next-line complexity
async function runOverlayDoctor(cwd: string, cfg: DevkitConfig, fix: boolean): Promise<number> {
  // hooksPath + the alias are repo-wide (set at the git ROOT) — a monorepo package is a subdir, so
  // read/check at the root, not cwd.
  const { gitRoot } = detectGitRoot(cwd);
  const gitGet = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--get', key], {
        cwd: gitRoot,
        encoding: 'utf8',
      }).trim();
    } catch {
      return ''; // unset
    }
  };
  const hooksPath = gitGet('core.hooksPath');
  const aliasOurs = isHealAlias(gitGet(`alias.${HEAL_ALIAS_NAME}`));
  // Detect — and with --fix, repair — a STALE/MISSING overlay hook. `devkit update` re-pins the CLI
  // but never regenerates the git-ignored .devkit/hooks/pre-commit, so an updated repo can keep an
  // OLD hook shape (e.g. one predating a new ship gate) until re-init. Compare against a freshly-built
  // hook; --fix rewrites it (mirrors how the package/standalone doctor heals by re-running the installer).
  const sync = syncOverlayHook(gitRoot, cwd, cfg, { dryRun: !fix });
  const hookOk = existsSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit')); // post-fix presence
  const pathOk = hooksPath === '.devkit/hooks';
  console.log('devkit doctor — overlay (local-only)\n');
  if (!hookOk)
    console.log(
      '  ✗ .devkit/hooks/pre-commit MISSING — run `devkit doctor --fix` (or `devkit init --overlay`)',
    );
  else if (fix && (sync.missing || sync.drift))
    console.log(
      '  ✓ .devkit/hooks/pre-commit regenerated (was stale/missing — refreshed to the current devkit)',
    );
  else if (sync.drift)
    console.log(
      '  ⚠ .devkit/hooks/pre-commit is STALE (predates the current devkit) — run `devkit doctor --fix` to refresh',
    );
  else console.log('  ✓ .devkit/hooks/pre-commit present');
  console.log(
    `  ${pathOk ? '✓' : '⚠'} core.hooksPath = ${hooksPath || '(unset)'}${pathOk ? '' : ` — heal with \`git ${HEAL_ALIAS_NAME}\` (re-points it) or re-run \`devkit init --overlay\``}`,
  );
  // Advisory only — never affects the exit code (hook + path are the real health signal).
  if (aliasOurs && !hookOk)
    console.log(
      `  ⚠ git ${HEAL_ALIAS_NAME} points at a missing .devkit/hooks — run \`devkit clean\``,
    );
  else if (aliasOurs) console.log(`  ✓ git ${HEAL_ALIAS_NAME} self-heal alias`);
  else
    console.log(
      `  · self-heal off (git ${HEAL_ALIAS_NAME} re-points core.hooksPath; or re-run \`devkit init --overlay\`)`,
    );
  // Opt-in global pre-commit shim — the only thing that gates a PLAIN `git commit` after husky
  // reclaims core.hooksPath. Advisory (never gates the exit code).
  if (globalHookInstalled()) {
    console.log(`  ✓ global pre-commit gate (${globalInitPath()}) — plain \`git commit\` gated`);
    if (aliasOurs)
      console.log(
        `    (git ${HEAL_ALIAS_NAME} is the CLI fast-path; shim + alias don't double-run)`,
      );
    // _/h:6 hole: husky sources init.sh only when a committed .husky/<hook> exists; with NO committed
    // .husky/pre-commit the shim can't fire for pre-commit, so a plain `git commit` stays ungated here.
    const huskyPresent =
      existsSync(join(gitRoot, '.husky', '_')) || existsSync(join(gitRoot, '.husky'));
    if (huskyPresent && !existsSync(join(gitRoot, '.husky', 'pre-commit')))
      console.log(
        `  ⚠ no committed .husky/pre-commit — husky won't source the shim for pre-commit; a plain \`git commit\` stays ungated here (use \`git ${HEAL_ALIAS_NAME}\`)`,
      );
  } else if (!pathOk) {
    console.log(
      `  · plain \`git commit\` is ungated (husky reclaimed core.hooksPath); \`git ${HEAL_ALIAS_NAME}\` heals it, or wire it permanently with \`devkit init --overlay --global-commit-gate\``,
    );
  }
  // Agent-half + fallow checks — ADVISORY (printed, never gate the exit code; a re-run re-syncs them).
  const sel: Partial<Selection> = cfg?.components ?? {};
  const surfaces = sel.agentTargets ?? ['claude', 'cursor'];
  const primary = surfaces.includes('claude') ? 'claude' : surfaces[0];
  const advise = (r: CheckResult) =>
    console.log(`  ${r.status === 'OK' ? '✓' : '·'} ${r.name}: ${r.detail}`);
  if (sel.skills && primary) advise(await checkSkills(cwd, primary));
  if (sel.agents && primary) advise(await checkAgents(cwd, primary));
  if (sel.agentHooks && primary) advise(checkAgentHookScripts(cwd, primary));
  if (sel.agentHooks && surfaces.includes('claude')) {
    const { ok } = checkHookRegistrations(gitRoot, ['agentHooks'], { overlay: true });
    console.log(
      `  ${ok ? '✓' : '·'} hook registrations: ${ok ? 'agentHooks in .claude/settings.local.json' : 'not in settings.local.json (re-run init)'}`,
    );
  }
  if (sel.fallow) {
    const wired =
      hookOk &&
      readFileSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit'), 'utf8').includes(
        'fallow audit',
      );
    console.log(
      `  ${wired ? '✓' : '·'} fallow gate: ${wired ? 'wired in the local hook' : 'not wired'}`,
    );
  }
  // A stale hook is unhealthy (exit 1) so CI/agents notice; --fix having just regenerated it heals this run.
  return hookOk && pathOk && (fix || !sync.drift) ? 0 : 1;
}

/**
 * Build the doctor result list for a package/standalone install from its recorded config — a pure
 * dispatch over the recorded selection, so it's unit-testable without driving the CLI. Each check
 * reads the repo and returns a `{ name, status, detail, remediation }`.
 */
// Reason: flat dispatch: one `if (selected) push(check())` per component; the branch COUNT is high but each is trivial and nesting is zero. Splitting obscures the check list.
// fallow-ignore-next-line complexity
async function collectResults(
  cwd: string,
  cfg: DevkitConfig,
  configResult: CheckResult,
): Promise<{ results: CheckResult[]; sel: Partial<Selection> }> {
  // Selection-aware: only check the components actually installed (fresh init always records it).
  const sel = cfg.components ?? DEFAULT_DOCTOR_SEL;
  // Standalone (no-package): biome/tsconfig extend VENDORED relative paths, and there is no devkit
  // pin to check (the whole point — no package dep).
  const standalone = Boolean(cfg.standalone);
  const stack = cfg.stack ?? 'generic';
  const expected = expectedExtends(stack, standalone);
  // Emitted configs the consumer has intentionally hand-owned — doctor treats their extends as OK.
  const overrides = new Set(cfg.configOverrides ?? []);

  const results = [configResult];
  if (sel.husky) results.push(checkHusky(cwd, sel.guards ?? []));
  if (sel.biome)
    results.push(
      checkExtends(cwd, 'biome.jsonc', expected.biome, 'extends', overrides.has('biome.jsonc')),
    );
  if (sel.tsconfig)
    results.push(
      checkExtends(
        cwd,
        'tsconfig.json',
        expected.tsconfig,
        'extends',
        overrides.has('tsconfig.json'),
      ),
    );
  if (sel.guards?.length || sel.structure) results.push(await checkGuardConfig(cwd));
  // structure-lint is a separate hook line (not a guard) — verify it when structure is recorded.
  if (sel.structure && sel.husky) results.push(checkStructureLint(cwd, stack));
  // Verify the synced agent files against a SELECTED surface (prefer .claude; else the first
  // chosen one). Both surfaces get identical content, so checking one is sufficient.
  const surfaces = sel.agentTargets ?? ['claude', 'cursor'];
  const primarySurface = surfaces.includes('claude') ? 'claude' : surfaces[0];
  if (sel.skills && primarySurface) results.push(await checkSkills(cwd, primarySurface));
  if (sel.agents && primarySurface) results.push(await checkAgents(cwd, primarySurface));
  if (sel.agentHooks && primarySurface) results.push(checkAgentHookScripts(cwd, primarySurface));
  if (sel.searchSteering) results.push(checkSearchToolBins());
  // Hook-owning components register into the surfaces' settings. checkHookRegistrations reads the
  // Claude-shaped settings.json, so only verify when .claude is a selected surface.
  const hookComponents = [
    sel.searchSteering && 'searchSteering',
    sel.agentHooks && 'agentHooks',
  ].filter((x): x is 'searchSteering' | 'agentHooks' => Boolean(x));
  if (hookComponents.length && surfaces.includes('claude'))
    results.push(checkRegistrations(cwd, hookComponents));
  if (sel.guards?.includes('fanout') || sel.guards?.includes('size'))
    results.push(checkBaselines(cwd));
  if (!standalone) results.push(checkPin(cwd));
  results.push(checkVersion(cwd));
  return { results, sel };
}

// Reason: flat CLI orchestration: sequential not-initialized short-circuit, overlay short-circuit, collectResults, print loop, then fix-if-drift; near-zero nesting, each branch a single guarded step. High branch COUNT, each trivial; splitting fragments the command's top-level flow.
// fallow-ignore-next-line complexity
export const meta = {
  name: 'doctor',
  summary: 'Diagnose drift for the installed component set (read-only).',
  help: `devkit doctor — diagnose drift for the installed component set (read-only).

Usage:
  devkit doctor [--fix]

  --fix    Re-run init for the recorded selection (recreates MISSING pieces; never re-freezes a
           baseline). In an overlay repo, regenerates a stale/missing local gate hook (e.g. after
           \`devkit update\` shipped a new hook shape). Exit 0 all-ok, 1 drift, 2 not-initialized.

Also warns if the RUNNING devkit is older than this repo's init stamp or a hand-declared
"minDevkit":"x.y.z" floor in .devkit/config.json.`,
};

export default async function run(args: string[], cwd: string): Promise<number> {
  const fix = args.includes('--fix');

  // Not-initialized short-circuit (exit 2).
  const configResult = checkConfig(cwd);
  if (configResult.status === 'MISSING') {
    console.log('devkit doctor\n');
    console.log(`  ✗ ${configResult.name}: ${configResult.detail} — ${configResult.remediation}`);
    console.log(
      '  (was this an overlay repo? `devkit clean` removes any leftover local git config — core.hooksPath / the git ci alias.)',
    );
    return 2;
  }

  const cfg = (readJson(join(cwd, '.devkit', 'config.json')) ?? {}) as DevkitConfig;
  if (cfg.overlay) return runOverlayDoctor(cwd, cfg, fix);

  const { results, sel } = await collectResults(cwd, cfg, configResult);

  console.log('devkit doctor\n');
  const glyph = { OK: '✓', DRIFT: '⚠', MISSING: '✗' };
  for (const r of results) {
    let line = `  ${glyph[r.status]} ${r.name}: ${r.status} — ${r.detail}`;
    if (r.status !== 'OK' && r.remediation) line += `\n      → ${r.remediation}`;
    console.log(line);
  }

  const drifted = results.some((r) => r.status !== 'OK');
  if (fix && drifted) {
    applyFix(cwd, results, sel, cfg.stack ?? 'generic', Boolean(cfg.standalone));
    console.log('\n--fix applied. Re-run `devkit doctor` to confirm.');
  }

  if (!drifted) {
    console.log('\nAll checks OK.');
    return 0;
  }
  return 1;
}

export { collectResults };
