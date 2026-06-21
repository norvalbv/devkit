/**
 * `devkit doctor` — diagnose drift between a consumer repo and what `devkit init` wires.
 *
 * Read-only by default; `--fix` re-runs the idempotent init steps (but NEVER auto-refreezes
 * baselines — it only recreates a MISSING one). Exit: 0 all-ok, 1 drift, 2 not-initialized.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { packageDir, readJson, sha256 } from '../lib/fs-helpers.mjs';
import { markEnd, markStart } from '../lib/husky/husky.mjs';
import { extractGuardBlock } from '../lib/husky/husky-block.mjs';
import { checkHookRegistrations } from '../lib/install/install-hooks.mjs';

// A devkit dep ref counts as "pinned" when it ends in a #v<digit> tag.
const PINNED_TAG = /#v\d/;

// One check result. status ∈ OK | DRIFT | MISSING. `fixable` flags whether --fix can touch it.
function check(name, status, detail, remediation = '', fixable = false) {
  return { name, status, detail, remediation, fixable };
}

function checkConfig(cwd) {
  if (!existsSync(join(cwd, '.devkit', 'config.json'))) {
    return check('.devkit/config.json', 'MISSING', 'not initialized', 'run `devkit init`');
  }
  return check('.devkit/config.json', 'OK', 'present');
}

// Selection-aware: only the SELECTED guards must be present in the block (a deselected
// guard being absent is correct, not drift). Monorepo: the hook lives at the git root and the
// block is package-scoped — resolve both from cwd.
function checkHusky(cwd, selectedGuards) {
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
  // Match both package mode (`bunx guard-X`) and standalone (`__dk_gate guard-X`).
  const missing = selectedGuards.filter((g) => !block.includes(`guard-${g}`));
  if (missing.length) {
    return check(
      '.husky/pre-commit',
      'DRIFT',
      `block missing guard(s): ${missing.join(', ')}`,
      'run `devkit init --force` to refresh the block',
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

// A jsonc-tolerant extends check (strip // line comments before parse).
function readJsonc(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function checkExtends(cwd, file, expected, key = 'extends') {
  const path = join(cwd, file);
  if (!existsSync(path)) {
    return check(file, 'MISSING', 'absent', 'run `devkit init`', true);
  }
  const parsed = readJsonc(path);
  if (!parsed) return check(file, 'DRIFT', 'unparseable', 'fix JSON, then re-run');
  const ext = parsed[key];
  const list = Array.isArray(ext) ? ext : [ext];
  if (!list.includes(expected)) {
    return check(file, 'DRIFT', `${key} is ${JSON.stringify(ext)}`, `should extend "${expected}"`);
  }
  return check(file, 'OK', `extends ${expected}`);
}

async function checkGuardConfig(cwd) {
  const path = join(cwd, 'guard.config.json');
  if (!existsSync(path)) {
    return check('guard.config.json', 'MISSING', 'absent', 'run `devkit init`', true);
  }
  // resolveGuardConfig throws on a corrupt file — that's the validity signal.
  try {
    const mod = await import(pathToFileURL(join(packageDir(), 'gate-engine', 'config.mjs')).href);
    mod.resolveGuardConfig(cwd);
    return check('guard.config.json', 'OK', 'valid (resolveGuardConfig parsed it)');
  } catch (e) {
    return check('guard.config.json', 'DRIFT', e.message, 'fix the config JSON');
  }
}

// Reason: the branches ARE the manifest-drift algorithm — per file, two independent SHA comparisons
// (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a
// missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift
// verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
async function checkSkills(cwd, surface = 'claude') {
  // Skills are repo-wide → manifest + the agent-surface dir live at the git root (cwd for a
  // single-package repo). Verify against the selected surface (.claude or .cursor — same content).
  const { gitRoot } = detectGitRoot(cwd);
  const manifestPath = join(gitRoot, '.devkit', 'skills-manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) {
    return check('skills', 'MISSING', 'no skills-manifest.json', 'run `devkit sync-skills`', true);
  }
  const skillsSrc = join(packageDir(), 'skills');
  const consumerDrift = [];
  const sourceDrift = [];
  for (const [rel, recordedSha] of Object.entries(manifest.files)) {
    const srcPath = join(skillsSrc, rel);
    if (existsSync(srcPath) && sha256(srcPath) !== recordedSha) sourceDrift.push(rel);
    const consumerPath = join(gitRoot, `.${surface}`, 'skills', rel);
    if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha) consumerDrift.push(rel);
  }
  if (sourceDrift.length || consumerDrift.length) {
    const parts = [];
    if (sourceDrift.length) parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
    if (consumerDrift.length) parts.push(`consumer copy drifted (${consumerDrift.length})`);
    return check('skills', 'DRIFT', parts.join('; '), 'run `devkit sync-skills`', true);
  }
  return check('skills', 'OK', `${Object.keys(manifest.files).length} file(s) in sync`);
}

// Agents are repo-wide → manifest + the agent-surface dir live at the git root (same contract as skills).
// Reason: the branches ARE the manifest-drift algorithm (same contract as checkSkills): per file, two independent SHA comparisons (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
async function checkAgents(cwd, surface = 'claude') {
  const { gitRoot } = detectGitRoot(cwd);
  const manifest = readJson(join(gitRoot, '.devkit', 'agents-manifest.json'));
  if (!manifest) {
    return check('agents', 'MISSING', 'no agents-manifest.json', 'run `devkit sync-agents`', true);
  }
  const agentsSrc = join(packageDir(), 'agents');
  const consumerDrift = [];
  const sourceDrift = [];
  for (const [rel, recordedSha] of Object.entries(manifest.files)) {
    const srcPath = join(agentsSrc, rel);
    if (existsSync(srcPath) && sha256(srcPath) !== recordedSha) sourceDrift.push(rel);
    const consumerPath = join(gitRoot, `.${surface}`, 'agents', rel);
    if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha) consumerDrift.push(rel);
  }
  if (sourceDrift.length || consumerDrift.length) {
    const parts = [];
    if (sourceDrift.length) parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
    if (consumerDrift.length) parts.push(`consumer copy drifted (${consumerDrift.length})`);
    return check('agents', 'DRIFT', parts.join('; '), 'run `devkit sync-agents`', true);
  }
  return check('agents', 'OK', `${Object.keys(manifest.files).length} agent file(s) in sync`);
}

// agentHooks: the six synced scripts (under <surface>/hooks) match the manifest, and are present.
function checkAgentHookScripts(cwd, surface = 'claude') {
  const { gitRoot } = detectGitRoot(cwd);
  const manifest = readJson(join(gitRoot, '.devkit', 'agent-hooks-manifest.json'));
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
function checkRegistrations(cwd, hookComponents) {
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
function checkSearchToolBins() {
  const dir = join(packageDir(), 'gate-engine', 'search-tool');
  const missing = ['search-tool-guard.mjs', 'search-tool-counter.mjs'].filter(
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

function checkBaselines(cwd) {
  const fanout = existsSync(join(cwd, 'eslint', 'baselines', 'fanout.json'));
  const size = existsSync(join(cwd, 'eslint', 'baselines', 'size.json'));
  if (fanout && size) return check('baselines', 'OK', 'fanout + size present');
  const missing = [!fanout && 'fanout', !size && 'size'].filter(Boolean);
  return check(
    'baselines',
    'MISSING',
    `${missing.join(' + ')} baseline absent`,
    'run `guard-fanout freeze` / `guard-size freeze`',
    true,
  );
}

function checkPin(cwd) {
  const pkg = readJson(join(cwd, 'package.json'));
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

// Devkit-OWNED template configs whose content is a fixed contract — safe to force-rewrite
// on DRIFT from their template. guard.config.json is deliberately EXCLUDED: a consumer
// tunes it (boundaries, scanRoots), so --fix must never clobber it — it can only be
// recreated when MISSING (by plain, create-if-absent init).
const FORCE_FIXABLE = new Set(['biome.jsonc', 'tsconfig.json']);

// Turn a recorded component selection into the init flag list that reproduces it, so
// `--fix` re-runs init for the RECORDED selection (not the all-on --yes default).
function selectionFlags(sel) {
  const flags = ['--yes'];
  for (const id of ['biome', 'tsconfig', 'skills', 'husky', 'structure']) {
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

// --fix: repair fixable findings. NEVER refreeze (only recreate MISSING baselines), and
// NEVER force-overwrite a consumer-tuned file. A DRIFTED template config is force-rewritten
// from its template DIRECTLY (not via `init --force`, which would also clobber the
// consumer's tuned guard.config.json); MISSING files + husky go through `init` for the
// RECORDED selection (selectionFlags) so --fix never silently re-adds a deselected component.
// Reason: flat repair orchestration: independent sequential `if (this kind drifted) repair it` steps (template-rewrite loop, init re-run, sync-skills, recreate-missing-baseline) with near-zero nesting; high branch COUNT, each a trivial guarded fixup. Splitting scatters the deliberate repair ordering.
// fallow-ignore-next-line complexity
function applyFix(cwd, results, sel, stack) {
  console.log('\n--fix: re-running idempotent steps for the recorded selection...');

  // Force-rewrite only the specific drifted fixed-contract configs, straight from template.
  const tplDir = join(packageDir(), 'templates', stack === 'electron' ? 'electron' : 'generic');
  for (const r of results) {
    if (r.status === 'DRIFT' && FORCE_FIXABLE.has(r.name)) {
      writeFileSync(join(cwd, r.name), readFileSync(join(tplDir, r.name), 'utf8'));
      console.log(`  ✓ restored ${r.name} from template`);
    }
  }

  // MISSING template files / husky drift → init for the recorded selection (idempotent).
  const needsInit = results.some(
    (r) => r.fixable && r.status === 'MISSING' && r.name !== 'baselines' && r.name !== 'skills',
  );
  const huskyDrift = results.some((r) => r.name === '.husky/pre-commit' && r.status !== 'OK');
  if (needsInit || huskyDrift) {
    const args = ['init', '--stack', stack, ...selectionFlags(sel)];
    execFileSync(process.execPath, [join(packageDir(), 'cli', 'index.mjs'), ...args], {
      cwd,
      stdio: 'inherit',
    });
  }
  const skills = results.find((r) => r.name === 'skills');
  if (skills && skills.status !== 'OK') {
    execFileSync(process.execPath, [join(packageDir(), 'cli', 'index.mjs'), 'sync-skills'], {
      cwd,
      stdio: 'inherit',
    });
  }
  const baselines = results.find((r) => r.name === 'baselines');
  if (baselines && baselines.status === 'MISSING') {
    // ONLY recreate a missing baseline — never refreeze an existing one (that would launder debt).
    console.log('  recreating MISSING baseline(s) via freeze (existing baselines left untouched):');
    for (const [name, bin] of [
      ['fanout', join(packageDir(), 'gate-engine', 'ratchets', 'folder-fanout.mjs')],
      ['size', join(packageDir(), 'gate-engine', 'ratchets', 'size-disable.mjs')],
    ]) {
      if (!existsSync(join(cwd, 'eslint', 'baselines', `${name}.json`))) {
        execFileSync(process.execPath, [bin, 'freeze'], { cwd, stdio: 'pipe' });
        console.log(`    ✓ created ${name} baseline`);
      }
    }
  }
}

// The default component selection (pre-`components`-block configs, and the all-on fallback).
const DEFAULT_DOCTOR_SEL = {
  biome: true,
  tsconfig: true,
  skills: true,
  husky: true,
  structure: false,
  guards: ['size', 'fanout', 'dup', 'clone', 'decisions'],
};

// Overlay (local-only) doctor: just the local hook + core.hooksPath (husky re-claims it on
// install). Package/pin/extends checks don't apply. Prints its own report; returns the exit code.
function runOverlayDoctor(cwd) {
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    // unset
  }
  const hookOk = existsSync(join(cwd, '.devkit', 'hooks', 'pre-commit'));
  const pathOk = hooksPath === '.devkit/hooks';
  console.log('devkit doctor — overlay (local-only)\n');
  console.log(`  ${hookOk ? '✓' : '✗'} .devkit/hooks/pre-commit ${hookOk ? 'present' : 'MISSING'}`);
  console.log(
    `  ${pathOk ? '✓' : '⚠'} core.hooksPath = ${hooksPath || '(unset)'}${pathOk ? '' : ' — re-run `devkit init --overlay` (husky may have reclaimed it)'}`,
  );
  return hookOk && pathOk ? 0 : 1;
}

/**
 * Build the doctor result list for a package/standalone install from its recorded config — a pure
 * dispatch over the recorded selection, so it's unit-testable without driving the CLI. Each check
 * reads the repo and returns a `{ name, status, detail, remediation }`.
 *
 * @returns {Promise<{ results: object[], sel: object }>}
 */
// Reason: flat dispatch: one `if (selected) push(check())` per component; the branch COUNT is high but each is trivial and nesting is zero. Splitting obscures the check list.
// fallow-ignore-next-line complexity
async function collectResults(cwd, cfg, configResult) {
  // Selection-aware: only check the components actually installed (fresh init always records it).
  const sel = cfg.components ?? DEFAULT_DOCTOR_SEL;
  // Standalone (no-package): biome/tsconfig extend VENDORED relative paths, and there is no devkit
  // pin to check (the whole point — no package dep).
  const standalone = Boolean(cfg.standalone);
  const stack = cfg.stack ?? 'generic';
  const biomeExpected = standalone
    ? `./.devkit/biome/${['electron', 'react-app', 'next'].includes(stack) ? 'react' : 'base'}.jsonc`
    : '@norvalbv/devkit/biome/base';
  const tsconfigExpected = standalone
    ? `./.devkit/tsconfig/${stack === 'next' ? 'next' : stack === 'node-service' ? 'node' : 'base'}.json`
    : '@norvalbv/devkit/tsconfig/base';

  const results = [configResult];
  if (sel.husky) results.push(checkHusky(cwd, sel.guards ?? []));
  if (sel.biome) results.push(checkExtends(cwd, 'biome.jsonc', biomeExpected));
  if (sel.tsconfig) results.push(checkExtends(cwd, 'tsconfig.json', tsconfigExpected));
  if (sel.guards?.length || sel.structure) results.push(await checkGuardConfig(cwd));
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
  ].filter(Boolean);
  if (hookComponents.length && surfaces.includes('claude'))
    results.push(checkRegistrations(cwd, hookComponents));
  if (sel.guards?.includes('fanout') || sel.guards?.includes('size'))
    results.push(checkBaselines(cwd));
  if (!standalone) results.push(checkPin(cwd));
  return { results, sel };
}

// Reason: flat CLI orchestration: sequential not-initialized short-circuit, overlay short-circuit, collectResults, print loop, then fix-if-drift; near-zero nesting, each branch a single guarded step. High branch COUNT, each trivial; splitting fragments the command's top-level flow.
// fallow-ignore-next-line complexity
export default async function run(args, cwd) {
  const fix = args.includes('--fix');

  // Not-initialized short-circuit (exit 2).
  const configResult = checkConfig(cwd);
  if (configResult.status === 'MISSING') {
    console.log('devkit doctor\n');
    console.log(`  ✗ ${configResult.name}: ${configResult.detail} — ${configResult.remediation}`);
    return 2;
  }

  const cfg = readJson(join(cwd, '.devkit', 'config.json')) ?? {};
  if (cfg.overlay) return runOverlayDoctor(cwd);

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
    applyFix(cwd, results, sel, cfg.stack ?? 'generic');
    console.log('\n--fix applied. Re-run `devkit doctor` to confirm.');
  }

  if (!drifted) {
    console.log('\nAll checks OK.');
    return 0;
  }
  return 1;
}

export { collectResults };
