/**
 * `devkit init` — scaffold a consumer repo onto devkit's shared configs + gate-engine,
 * with an interactive SETUP WIZARD (clack) for component selection AND removal.
 *
 * Three resolution paths converge on one `selection` (see components.mjs):
 *   1. interactive  — TTY + no --yes → runWizard() asks per component + per guard.
 *   2. --yes        — all recommended defaults (EXACT pre-wizard behaviour), minus any --no-*.
 *   3. non-TTY      — same as --yes (never hangs waiting for stdin), minus any --no-*.
 *
 * Apply logic per component: selected+absent → install; selected+present → idempotent;
 * deselected+present → REMOVE (wizard confirms per component default-NO;
 * --remove-deselected removes without prompting). Removal is SAFE: it never deletes a file
 * devkit didn't create.
 *
 * The chosen set is recorded in .devkit/config.json.components so `doctor` is selection-aware.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, isCancel, outro } from '@clack/prompts';
import { COMPONENTS, defaultSelection, GUARD_IDS } from '../lib/components.mjs';
import { detectStack } from '../lib/detect-stack.mjs';
import { packageDir, readJson, writeIfAbsent } from '../lib/fs-helpers.mjs';
import { generateImportWallBaseline } from '../lib/generate-import-wall-baseline.mjs';
import { generateStructureBaselines } from '../lib/generate-structure-baseline.mjs';
import {
  buildFullHook,
  buildGuardBlock,
  hasFragment,
  removeFragment,
  removeGuardBlock,
  replaceGuardBlock,
} from '../lib/husky-block.mjs';
import {
  ensureFallowGitignore,
  installFallow,
  saveFallowBaselines,
  wireFallowGate,
} from '../lib/install-fallow.mjs';
import { runWizard } from '../lib/wizard.mjs';
import { syncSkills } from './sync-skills.mjs';

const INIT_VERSION = 2;

// Stacks with a structure-lint preset (eslint.config.mjs + eslint/domains.mjs + baselines).
// next/node-service are deliberately OUT until a template ships for them — listing one here
// would make init read a non-existent templates/<stack> dir.
const STRUCTURE_STACKS = new Set(['electron', 'react-app']);

// The structure files each stack emits, [src-relative-to-template, dest-relative-to-cwd].
// The full install set adds biome/tsconfig/guard.config on top (installStructureFiles).
const STRUCTURE_TEMPLATE_FILES = {
  electron: [
    ['eslint.config.mjs', 'eslint.config.mjs'],
    ['eslint/domains.mjs', 'eslint/domains.mjs'],
    ['eslint/baselines/exempt.mjs', 'eslint/baselines/exempt.mjs'],
  ],
  'react-app': [
    ['eslint.config.mjs', 'eslint.config.mjs'],
    ['eslint/domains.mjs', 'eslint/domains.mjs'],
    ['eslint/baselines/exempt.mjs', 'eslint/baselines/exempt.mjs'],
  ],
};

// devDeps/scripts owned by each component — used by both install (add) and remove (delete).
const BIOME_DEV_DEPS = ['@biomejs/biome'];
const BIOME_SCRIPTS = ['lint', 'format'];

// The commented structure-lint placeholder line a structure stack flips live (and removal
// re-comments). Hoisted to module scope (perf: avoid recompiling per call).
const COMMENTED_LINT_RE = /\n# bunx eslint src.*\n/;

// Matches the scanRoots array value in guard.config.json for an in-place --scan-root patch
// (preserves the //-comment guidance keys a JSON round-trip would drop). Hoisted (perf).
const SCANROOTS_RE = /("scanRoots"\s*:\s*)\[[^\]]*\]/;

function parseFlags(args) {
  const flags = {
    yes: false,
    dryRun: false,
    force: false,
    stack: null,
    removeDeselected: false,
    fallow: false,
    no: new Set(),
    guards: null,
    scanRoots: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--remove-deselected') flags.removeDeselected = true;
    else if (a === '--fallow') flags.fallow = true;
    else if (a === '--stack') flags.stack = args[++i];
    else if (a === '--guards') flags.guards = (args[++i] ?? '').split(',').map((g) => g.trim());
    // --scan-root <comma-list>: override guard.config.json scanRoots up front, so the freezes
    // + the react-app structureRoot grandfather a non-standard tree (e.g. services/webapp/src).
    else if (a === '--scan-root' || a === '--scan-roots')
      flags.scanRoots = (args[++i] ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    else if (a.startsWith('--no-')) flags.no.add(a.slice('--no-'.length));
  }
  return flags;
}

// Build a selection from flags (the --yes / non-TTY path): all recommended, minus --no-*,
// guards narrowed by --guards / --no-guards.
function selectionFromFlags(flags) {
  const sel = defaultSelection();
  for (const id of ['biome', 'tsconfig', 'skills', 'husky', 'structure']) {
    if (flags.no.has(id)) sel[id] = false;
  }
  if (flags.no.has('guards')) sel.guards = [];
  else if (flags.guards) sel.guards = flags.guards.filter((g) => GUARD_IDS.includes(g));
  // fallow is OPT-IN (heavier third-party tool): off unless --fallow, and --no-fallow keeps off.
  sel.fallow = flags.fallow && !flags.no.has('fallow');
  return sel;
}

// Which components are currently wired? Read the recorded set first (authoritative), then
// fall back to on-disk detection for a pre-wizard repo with no `components` block.
function detectInstalled(cwd) {
  const cfg = readJson(join(cwd, '.devkit', 'config.json'));
  const installed = new Set();
  const recorded = cfg?.components;
  if (recorded) {
    for (const id of ['biome', 'tsconfig', 'skills', 'husky', 'structure']) {
      if (recorded[id]) installed.add(id);
    }
    if (recorded.guards?.length) installed.add('guards');
    return installed;
  }
  if (existsSync(join(cwd, 'biome.jsonc'))) installed.add('biome');
  if (existsSync(join(cwd, 'tsconfig.json'))) installed.add('tsconfig');
  if (existsSync(join(cwd, '.devkit', 'skills-manifest.json'))) installed.add('skills');
  if (existsSync(join(cwd, '.husky', 'pre-commit'))) installed.add('husky');
  if (existsSync(join(cwd, 'eslint.config.mjs'))) installed.add('structure');
  const hook = existsSync(join(cwd, '.husky', 'pre-commit'))
    ? readFileSync(join(cwd, '.husky', 'pre-commit'), 'utf8')
    : '';
  if (GUARD_IDS.some((g) => hasFragment(hook, `guard-${g}`))) installed.add('guards');
  return installed;
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function logWrite(action, label) {
  const map = { created: '✓ created', forced: '✓ overwrote', exists: '• already wired' };
  console.log(`  ${map[action] ?? action} ${label}`);
}

// ── install steps ──────────────────────────────────────────────────────────

function installConfigs(cwd, sel, force, dryRun) {
  const tplDir = join(packageDir(), 'templates', 'generic');
  const items = [];
  if (sel.biome) items.push(['biome.jsonc', 'biome.jsonc']);
  if (sel.tsconfig) items.push(['tsconfig.json', 'tsconfig.json']);
  // guard.config.json is needed whenever ANY gate runs (guards or structure).
  if (sel.guards?.length || sel.structure) items.push(['guard.config.json', 'guard.config.json']);
  for (const [src, dest] of items) {
    const target = join(cwd, dest);
    if (dryRun) {
      console.log(
        `  [dry-run] ${existsSync(target) && !force ? 'skip (exists)' : 'write'} ${dest}`,
      );
    } else {
      logWrite(writeIfAbsent(target, readText(join(tplDir, src)), { force }), dest);
    }
  }
}

function installStructureFiles(cwd, stack, force, dryRun) {
  const tplDir = join(packageDir(), 'templates', stack);
  // Structure-stack biome.jsonc / tsconfig.json supersede the generic ones (stack rules).
  const items = [
    ...STRUCTURE_TEMPLATE_FILES[stack],
    ['biome.jsonc', 'biome.jsonc'],
    ['tsconfig.json', 'tsconfig.json'],
    ['guard.config.json', 'guard.config.json'],
  ];
  for (const [src, dest] of items) {
    const target = join(cwd, dest);
    if (dryRun) {
      console.log(
        `  [dry-run] ${existsSync(target) && !force ? 'skip (exists)' : 'write'} ${dest}`,
      );
    } else {
      logWrite(writeIfAbsent(target, readText(join(tplDir, src)), { force }), dest);
    }
  }
}

// Override guard.config.json scanRoots from --scan-root, BEFORE the freezes run so they (and
// the react-app structureRoot, which derives from scanRoots[0]) grandfather the right tree —
// e.g. a non-`src` root like services/webapp/src. Patches the scanRoots array in place via
// regex to PRESERVE the template's //-comment guidance keys; falls back to a JSON round-trip if
// the key is absent. No-op when guard.config.json wasn't written (no guards/structure selected).
function applyScanRoots(cwd, scanRoots, dryRun) {
  if (!scanRoots?.length) return;
  const value = JSON.stringify(scanRoots);
  if (dryRun) {
    console.log(`  [dry-run] set guard.config.json scanRoots = ${value}`);
    return;
  }
  const path = join(cwd, 'guard.config.json');
  if (!existsSync(path)) return;
  const raw = readText(path);
  let next = raw.replace(SCANROOTS_RE, `$1${value}`);
  if (next === raw) {
    const cfg = readJson(path) ?? {};
    cfg.scanRoots = scanRoots;
    next = `${JSON.stringify(cfg, null, 2)}\n`;
  }
  writeFileSync(path, next);
  console.log(`  ✓ guard.config.json scanRoots = ${value}`);
}

function patchPackageJson(cwd, devkitRef, sel, isStructure, dryRun) {
  const pkgPath = join(cwd, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) {
    console.log('  ! no package.json — skipping devDeps/scripts wiring');
    return;
  }
  const devDeps = {
    '@norvalbv/devkit': `git+ssh://git@github.com/norvalbv/devkit.git#${devkitRef}`,
    ...(sel.biome ? { '@biomejs/biome': '^2.5.0' } : {}),
    ...(sel.husky ? { husky: '^9.1.7' } : {}),
    ...(sel.guards?.includes('clone') ? { jscpd: '^4.2.4' } : {}),
    ...(isStructure
      ? {
          eslint: '^9.0.0',
          'eslint-plugin-project-structure': '^3.0.0',
          '@typescript-eslint/parser': '^8.0.0',
        }
      : {}),
  };
  const scripts = {
    ...(sel.biome ? { lint: 'biome check .', format: 'biome check --write .' } : {}),
    ...(sel.husky ? { prepare: 'husky' } : {}),
    ...(sel.guards?.includes('fanout') || sel.guards?.includes('size')
      ? { 'guard:freeze': 'guard-fanout freeze && guard-size freeze' }
      : {}),
    ...(isStructure ? { 'lint:structure': 'eslint src' } : {}),
  };

  pkg.devDependencies = pkg.devDependencies ?? {};
  pkg.scripts = pkg.scripts ?? {};
  const added = [];
  for (const [k, v] of Object.entries(devDeps)) {
    if (!pkg.devDependencies[k]) {
      pkg.devDependencies[k] = v;
      added.push(`devDep ${k}`);
    }
  }
  for (const [k, v] of Object.entries(scripts)) {
    if (!pkg.scripts[k]) {
      pkg.scripts[k] = v;
      added.push(`script ${k}`);
    }
  }
  if (added.length === 0) {
    console.log('  • package.json already wired (devDeps + scripts)');
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] patch package.json: ${added.join(', ')}`);
    return;
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  ✓ package.json: ${added.join(', ')}`);
}

// Wire .husky/pre-commit from the selection: fresh repo → full hook; existing hook →
// replace/insert the devkit-guards block assembled from the selection.
function installHusky(cwd, sel, dryRun) {
  const hookPath = join(cwd, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) {
    if (dryRun) {
      console.log('  [dry-run] write .husky/pre-commit (assembled from selection) + husky init');
      return;
    }
    mkdirSync(join(cwd, '.husky'), { recursive: true });
    writeFileSync(hookPath, buildFullHook(sel));
    chmodSync(hookPath, 0o755);
    console.log('  ✓ created .husky/pre-commit (selected gates)');
    return;
  }
  const current = readText(hookPath);
  const block = buildGuardBlock(sel);
  const merged = replaceGuardBlock(current, block);
  if (merged === current) {
    console.log('  • .husky/pre-commit already wired (devkit-guards block current)');
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] refresh devkit-guards block in existing .husky/pre-commit');
    return;
  }
  writeFileSync(hookPath, merged);
  console.log('  ✓ refreshed devkit-guards block in .husky/pre-commit');
}

function runFreezes(cwd, dryRun) {
  if (dryRun) {
    console.log('  [dry-run] skip guard-fanout freeze + guard-size freeze');
    return;
  }
  const bins = [
    ['guard-fanout', join(packageDir(), 'gate-engine', 'ratchets', 'folder-fanout.mjs')],
    ['guard-size', join(packageDir(), 'gate-engine', 'ratchets', 'size-disable.mjs')],
  ];
  for (const [name, bin] of bins) {
    try {
      execFileSync(process.execPath, [bin, 'freeze'], { cwd, stdio: 'pipe' });
      console.log(`  ✓ ${name} freeze (baseline grandfathered)`);
    } catch (e) {
      console.log(`  ! ${name} freeze failed: ${firstLine(e)}`);
    }
  }
}

async function runStructureBaselines(cwd, stack, dryRun) {
  if (dryRun) {
    console.log('  [dry-run] skip structure + import-wall baseline generators');
    return;
  }
  // The generators grandfather electron's process trees (the generator's own DEFAULT_ROOTS).
  // react-app needs no generated structure baseline: its preset is grandfathered via permissive
  // rules + EMPTY baselines (the eslint.config loadBaseline() returns [] when absent), and its
  // structureRoot is derived live from guard.config.json scanRoots — so for a src-rooted app
  // these calls are no-ops by design (the electron tree names never match).
  const opts = { log: (m) => console.log(m) };
  try {
    await generateStructureBaselines(cwd, opts);
  } catch (e) {
    console.log(`  ! structure baseline generator failed: ${firstLine(e)}`);
  }
  try {
    generateImportWallBaseline(cwd, opts);
  } catch (e) {
    console.log(`  ! import-wall baseline generator skipped: ${firstLine(e)}`);
    console.log(`    (install deps — bun install — then re-run \`devkit init --stack ${stack}\`)`);
  }
}

function firstLine(e) {
  return (e.stderr || e.message || '').toString().trim().split('\n')[0];
}

// A @clack confirm that's safe in any context: only prompts on a TTY-interactive run,
// otherwise returns the non-interactive default. isCancel (Ctrl-C / Esc) → the default too.
async function subConfirm(message, { interactive, fallback }) {
  if (!interactive) return fallback;
  const v = await confirm({ message, initialValue: fallback });
  return isCancel(v) ? fallback : v;
}

// Does the repo carry fallow debt? `fallow audit` exits non-zero when it finds NEW issues
// against (absent) baselines — i.e. there's something to grandfather. Fail-open: any throw
// (missing binary, etc.) is treated as "no debt" so we never save empty baselines.
function fallowHasDebt(cwd) {
  try {
    execFileSync('fallow', ['audit'], { cwd, stdio: 'pipe' });
    return false; // exit 0 → clean → nothing to baseline
  } catch (e) {
    return e.status != null; // non-zero exit → debt; ENOENT (status null) → treat as none
  }
}

// Apply the OPTIONAL fallow component. Every step is fail-open (install-fallow never throws);
// order: install → gitignore (always) → optional `fallow init` (sub-confirm, default NO —
// fallow is zero-config) → wire fallow's own git hook → save baselines ONLY if the gate wired
// AND the repo has debt to grandfather. dryRun prints + writes nothing throughout.
async function applyFallow(cwd, dryRun, interactive) {
  const r = installFallow({ cwd, dryRun });
  console.log(`  ${r.ok ? '✓' : '!'} ${r.message}`);
  ensureFallowGitignore({ cwd, dryRun });
  console.log(`  ${dryRun ? '[dry-run] ensure' : '✓ ensured'} .fallow/ in .gitignore`);

  const doInit = await subConfirm('Run `fallow init`? (optional — fallow is zero-config)', {
    interactive,
    fallback: false,
  });
  if (doInit) {
    if (dryRun) console.log('  [dry-run] fallow init');
    else {
      try {
        execFileSync('fallow', ['init'], { cwd, stdio: 'inherit' });
        console.log('  ✓ fallow init');
      } catch (e) {
        console.log(`  ! fallow init skipped: ${firstLine(e)}`);
      }
    }
  }

  const gate = wireFallowGate({ cwd, dryRun, target: 'git' });
  console.log(`  ${gate.ok ? '✓ wired' : '! could not wire'} fallow git hook`);
  if (gate.ok && (dryRun || fallowHasDebt(cwd))) {
    const saved = saveFallowBaselines({ cwd, dryRun });
    console.log(`  ${saved.ok ? '✓ saved' : '! some'} fallow baselines (grandfather debt)`);
  }
}

// Flip the commented structure-lint placeholder to the live `bunx eslint <roots>` call.
function enableStructureLint(cwd, dryRun) {
  const hookPath = join(cwd, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return;
  const content = readFileSync(hookPath, 'utf8');
  if (content.includes('\nbunx eslint src')) {
    console.log('  • structure-lint already enabled in .husky/pre-commit');
    return;
  }
  if (!COMMENTED_LINT_RE.test(content)) {
    console.log('  ! could not find the commented structure-lint placeholder to enable');
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] uncomment `bunx eslint src` in .husky/pre-commit');
    return;
  }
  writeFileSync(hookPath, content.replace(COMMENTED_LINT_RE, '\nbunx eslint src\n'));
  console.log('  ✓ enabled structure-lint (`bunx eslint src`) in .husky/pre-commit');
}

// ── removal steps (SAFE: never delete a file devkit didn't create) ───────────

function removeFromPkg(cwd, devDeps, scripts, dryRun) {
  const pkgPath = join(cwd, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) return [];
  const removed = [];
  for (const k of devDeps) {
    if (pkg.devDependencies?.[k]) {
      removed.push(`devDep ${k}`);
      if (!dryRun) delete pkg.devDependencies[k];
    }
  }
  for (const k of scripts) {
    if (pkg.scripts?.[k]) {
      removed.push(`script ${k}`);
      if (!dryRun) delete pkg.scripts[k];
    }
  }
  if (removed.length && !dryRun) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return removed;
}

function removeBiome(cwd, dryRun) {
  const file = join(cwd, 'biome.jsonc');
  if (existsSync(file)) {
    console.log(`  ${dryRun ? '[dry-run] delete' : '✓ deleted'} biome.jsonc`);
    if (!dryRun) rmSync(file);
  }
  const pkgRemoved = removeFromPkg(cwd, BIOME_DEV_DEPS, BIOME_SCRIPTS, dryRun);
  if (pkgRemoved.length)
    console.log(`  ${dryRun ? '[dry-run]' : '✓'} package.json: -${pkgRemoved.join(', -')}`);
  // Drop the biome-format step from the husky block.
  removeHuskyPiece(cwd, 'biome-format', dryRun);
}

// Remove ONLY the devkit `extends` from tsconfig — never delete a tsconfig with user content.
function removeTsconfig(cwd, dryRun) {
  const file = join(cwd, 'tsconfig.json');
  if (!existsSync(file)) return;
  const raw = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log('  ! tsconfig.json unparseable — left untouched');
    return;
  }
  const ext = parsed.extends;
  const isDevkit = (e) => typeof e === 'string' && e.startsWith('@norvalbv/devkit/tsconfig');
  const onlyExtends = Object.keys(parsed).length === 1 && 'extends' in parsed;
  if (!ext || (Array.isArray(ext) ? !ext.some(isDevkit) : !isDevkit(ext))) {
    console.log('  • tsconfig.json has no devkit extends — left untouched');
    return;
  }
  if (Array.isArray(ext)) parsed.extends = ext.filter((e) => !isDevkit(e));
  else delete parsed.extends;
  if (dryRun) {
    console.log('  [dry-run] strip devkit extends from tsconfig.json');
    return;
  }
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(
    `  ✓ stripped devkit extends from tsconfig.json${onlyExtends ? ' (file now has no extends — review/remove if empty)' : ''}`,
  );
}

// Remove devkit-synced skills (per the manifest) from .claude + .cursor + drop the manifest.
function removeSkills(cwd, dryRun) {
  const manifestPath = join(cwd, '.devkit', 'skills-manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) {
    console.log('  • no skills-manifest.json — nothing to remove');
    return;
  }
  const targets = ['.claude/skills', '.cursor/skills'];
  let n = 0;
  for (const rel of Object.keys(manifest.files)) {
    for (const t of targets) {
      const p = join(cwd, t, rel);
      if (existsSync(p)) {
        n++;
        if (!dryRun) rmSync(p);
      }
    }
  }
  if (!dryRun) rmSync(manifestPath, { force: true });
  console.log(
    `  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${n} synced skill file(s) + manifest`,
  );
}

// Remove the entire devkit-guards block from the hook (leaving the rest of the consumer hook).
function removeHusky(cwd, dryRun) {
  const hookPath = join(cwd, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return;
  const { content, removed } = removeGuardBlock(readFileSync(hookPath, 'utf8'));
  if (!removed) {
    console.log('  • no devkit-guards block in .husky/pre-commit');
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] remove devkit-guards block from .husky/pre-commit');
    return;
  }
  writeFileSync(hookPath, content);
  console.log('  ✓ removed devkit-guards block from .husky/pre-commit');
}

// Remove a single fragment (one guard, or the biome-format step) from the hook block.
function removeHuskyPiece(cwd, id, dryRun) {
  const hookPath = join(cwd, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return false;
  const { content, removed } = removeFragment(readFileSync(hookPath, 'utf8'), id);
  if (!removed) return false;
  if (dryRun) {
    console.log(`  [dry-run] remove ${id} from .husky/pre-commit`);
    return true;
  }
  writeFileSync(hookPath, content);
  console.log(`  ✓ removed ${id} from .husky/pre-commit`);
  return true;
}

// Remove ONLY devkit-created structure files (guarded by config marker), re-comment the line.
function removeStructure(cwd, prevConfig, dryRun) {
  if (!prevConfig?.components?.structure) {
    console.log('  ! structure not recorded as devkit-created — leaving eslint files untouched');
    return;
  }
  // Same structure file set across stacks today; key off the recorded stack to stay generic.
  const files = STRUCTURE_TEMPLATE_FILES[prevConfig.stack] ?? STRUCTURE_TEMPLATE_FILES.electron;
  for (const [, dest] of files) {
    const p = join(cwd, dest);
    if (existsSync(p)) {
      console.log(`  ${dryRun ? '[dry-run] delete' : '✓ deleted'} ${dest}`);
      if (!dryRun) rmSync(p);
    }
  }
  const baselines = join(cwd, 'eslint', 'baselines', 'imports.mjs');
  if (existsSync(baselines)) {
    console.log(`  ${dryRun ? '[dry-run] delete' : '✓ deleted'} eslint/baselines/imports.mjs`);
    if (!dryRun) rmSync(baselines);
  }
  const pkgRemoved = removeFromPkg(
    cwd,
    ['eslint', 'eslint-plugin-project-structure', '@typescript-eslint/parser'],
    ['lint:structure'],
    dryRun,
  );
  if (pkgRemoved.length) {
    console.log(`  ${dryRun ? '[dry-run]' : '✓'} package.json: -${pkgRemoved.join(', -')}`);
  }
  // Re-comment the live structure-lint line in the hook.
  const hookPath = join(cwd, '.husky', 'pre-commit');
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, 'utf8');
    const live = '\nbunx eslint src\n';
    if (content.includes(live)) {
      if (!dryRun) {
        writeFileSync(
          hookPath,
          content.replace(
            live,
            '\n# bunx eslint src  # uncomment after `devkit init --stack <x>`\n',
          ),
        );
      }
      console.log(
        `  ${dryRun ? '[dry-run]' : '✓'} re-commented structure-lint line in .husky/pre-commit`,
      );
    }
  }
}

function applyRemovals(cwd, remove, prevConfig, dryRun) {
  if (!remove.length) return;
  console.log(`\nRemoving deselected component(s): ${remove.join(', ')}`);
  // Guards (individual lines) before husky (whole-block) so order is irrelevant.
  if (remove.includes('guards')) {
    for (const g of GUARD_IDS) removeHuskyPiece(cwd, `guard-${g}`, dryRun);
  }
  if (remove.includes('biome')) removeBiome(cwd, dryRun);
  if (remove.includes('tsconfig')) removeTsconfig(cwd, dryRun);
  if (remove.includes('skills')) removeSkills(cwd, dryRun);
  if (remove.includes('structure')) removeStructure(cwd, prevConfig, dryRun);
  if (remove.includes('husky')) removeHusky(cwd, dryRun);
}

// ── orchestration ────────────────────────────────────────────────────────────

const STEP_LABELS = {
  biome: 'biome.jsonc',
  tsconfig: 'tsconfig.json',
  skills: 'skills',
  husky: 'husky pre-commit',
  guards: 'gate-engine guards',
  structure: 'structure-lint',
};

/**
 * The testable apply layer: given a resolved selection (+ removals), install/remove and
 * record .devkit/config.json.components. No prompting — callers (the CLI dispatcher, tests)
 * pass a fully-resolved plan.
 *
 * @param {string} cwd consumer root
 * @param {object} plan
 * @param {string} plan.stack
 * @param {object} plan.selection
 * @param {string[]} [plan.remove] component ids to remove
 * @param {boolean} [plan.force]
 * @param {boolean} [plan.dryRun]
 * @param {boolean} [plan.interactive] TTY run — enables fallow sub-confirms (default false)
 * @param {string[]} [plan.scanRoots] override guard.config.json scanRoots (--scan-root)
 * @param {string} [plan.devkitRef]
 */
export async function applyInit(cwd, plan) {
  const {
    stack,
    selection,
    remove = [],
    force = false,
    dryRun = false,
    interactive = false,
    scanRoots = null,
  } = plan;
  const isStructure = selection.structure && STRUCTURE_STACKS.has(stack);
  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = plan.devkitRef ?? (devkitPkg ? `v${devkitPkg.version}` : 'main');
  const prevConfig = readJson(join(cwd, '.devkit', 'config.json'));

  console.log(
    `devkit init${dryRun ? ' (dry-run — no files written)' : ''} — stack=${stack}, devkit=${devkitRef}`,
  );
  const on = COMPONENTS.filter((c) =>
    c.id === 'guards'
      ? selection.guards.length
      : selection[c.id] && !(c.id === 'structure' && !isStructure),
  ).map((c) => c.id);
  console.log(`  components: ${on.join(', ') || '(none)'}\n`);

  console.log('1. configs');
  if (isStructure) installStructureFiles(cwd, stack, force, dryRun);
  else installConfigs(cwd, selection, force, dryRun);
  applyScanRoots(cwd, scanRoots, dryRun);

  console.log('2. package.json');
  patchPackageJson(cwd, devkitRef, selection, isStructure, dryRun);

  if (selection.husky) {
    console.log('3. husky pre-commit');
    installHusky(cwd, selection, dryRun);
  }

  if (selection.guards?.includes('fanout') || selection.guards?.includes('size')) {
    console.log('4. freeze baselines');
    runFreezes(cwd, dryRun);
  }

  if (isStructure) {
    console.log('5. structure + import-wall baselines (grandfather current tree)');
    await runStructureBaselines(cwd, stack, dryRun);
    console.log('6. enable structure-lint in pre-commit');
    enableStructureLint(cwd, dryRun);
  }

  if (selection.skills) {
    console.log('7. skills');
    syncSkills(dryRun ? ['--dry-run'] : [], cwd);
  }

  if (selection.fallow) {
    console.log('8. fallow (optional code-health layer)');
    await applyFallow(cwd, dryRun, interactive);
  }

  // Removals (deselected + present).
  applyRemovals(cwd, remove, prevConfig, dryRun);

  // .devkit/config.json with the component selection.
  console.log('9. .devkit/config.json');
  const components = {
    biome: selection.biome,
    tsconfig: selection.tsconfig,
    skills: selection.skills,
    husky: selection.husky,
    structure: isStructure,
    fallow: Boolean(selection.fallow),
    guards: selection.husky ? [...selection.guards] : [],
  };
  const config = { stack, devkitRef, initVersion: INIT_VERSION, components };
  const configPath = join(cwd, '.devkit', 'config.json');
  if (dryRun) {
    console.log('  [dry-run] write .devkit/config.json');
  } else {
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log('  ✓ wrote .devkit/config.json');
  }

  printReferencedSteps();
  console.log(
    `\n${dryRun ? 'Dry-run complete (nothing written).' : 'devkit init complete.'} Run \`devkit doctor\` to verify.`,
  );
}

function printReferencedSteps() {
  console.log('\nNext, by hand (devkit prints these — it never runs them):');
  console.log('  • fallow (optional code-health audit): install per https://docs.fallow.tools');
  console.log('  • search-code (semantic dup matcher): point guard-dup at your index via');
  console.log('      GUARD_INDEX_PATH=<path/to/index.db>  (or indexPath in guard.config.json).');
  console.log(
    '      Without it the duplication gate fails open (clone + ratchet gates still run).',
  );
}

function structureAvailableFor(stack) {
  return STRUCTURE_STACKS.has(stack);
}

export default async function run(args, cwd) {
  const flags = parseFlags(args);
  const detectedStack = flags.stack ?? detectStack(cwd);
  const interactive = !flags.yes && process.stdout.isTTY && !flags.dryRun;

  let stack = detectedStack;
  let selection;
  let remove = [];

  if (interactive) {
    const installed = detectInstalled(cwd);
    const result = await runWizard({
      detectedStack,
      structureAvailable: structureAvailableFor(detectedStack),
      installed,
    });
    if (!result) return 0; // cancelled — nothing written
    ({ stack, selection, remove } = result);
  } else {
    selection = selectionFromFlags(flags);
    // Non-interactive removal of deselected-present components only with --remove-deselected.
    if (flags.removeDeselected) {
      const installed = detectInstalled(cwd);
      for (const id of installed) {
        const stillSelected = id === 'guards' ? selection.guards.length > 0 : selection[id];
        if (!stillSelected) remove.push(id);
      }
    }
  }

  if (!structureAvailableFor(stack) && selection.structure) {
    selection.structure = false; // no template for this stack — silently skip (noted below)
    if (stack !== 'generic') {
      console.log(`devkit init: no structure-lint preset for stack "${stack}" yet — skipping it.`);
    }
  }

  await applyInit(cwd, {
    stack,
    selection,
    remove,
    force: flags.force,
    dryRun: flags.dryRun,
    interactive,
    scanRoots: flags.scanRoots,
  });
  if (interactive) outro('Done — run `devkit doctor` to verify.');
  return 0;
}

export { detectInstalled, parseFlags, STEP_LABELS, selectionFromFlags };
