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
import { markEnd, markStart } from '../lib/husky.mjs';
import { extractGuardBlock } from '../lib/husky-block.mjs';

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

async function checkSkills(cwd) {
  // Skills are repo-wide → manifest + .claude live at the git root (cwd for a single-package repo).
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
    const consumerPath = join(gitRoot, '.claude', 'skills', rel);
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
  return flags;
}

// --fix: repair fixable findings. NEVER refreeze (only recreate MISSING baselines), and
// NEVER force-overwrite a consumer-tuned file. A DRIFTED template config is force-rewritten
// from its template DIRECTLY (not via `init --force`, which would also clobber the
// consumer's tuned guard.config.json); MISSING files + husky go through `init` for the
// RECORDED selection (selectionFlags) so --fix never silently re-adds a deselected component.
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

export default async function run(args, cwd) {
  const fix = args.includes('--fix');

  // Not-initialized short-circuit (exit 2).
  const configResult = checkConfig(cwd);
  if (configResult.status === 'MISSING') {
    console.log('devkit doctor\n');
    console.log(`  ✗ ${configResult.name}: ${configResult.detail} — ${configResult.remediation}`);
    return 2;
  }

  // Selection-aware: only check the components that were actually installed. A config with
  // no `components` block defaults to all-on (a fresh init always records it).
  const cfg = readJson(join(cwd, '.devkit', 'config.json')) ?? {};
  const sel = cfg.components ?? {
    biome: true,
    tsconfig: true,
    skills: true,
    husky: true,
    structure: false,
    guards: ['size', 'fanout', 'dup', 'clone', 'decisions'],
  };

  // Standalone (no-package): biome/tsconfig extend VENDORED relative paths, and there is no
  // devkit pin to check (the whole point — no package dep).
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
  if (sel.skills) results.push(await checkSkills(cwd));
  if (sel.guards?.includes('fanout') || sel.guards?.includes('size'))
    results.push(checkBaselines(cwd));
  if (!standalone) results.push(checkPin(cwd));

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
