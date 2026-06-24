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
import { pathToFileURL } from 'node:url';
import { confirm, isCancel, outro } from '@clack/prompts';
import { AGENT_TARGETS, COMPONENTS, defaultSelection, GUARD_IDS } from '../lib/components.mjs';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { detectStack } from '../lib/detect-stack.mjs';
import { packageDir, readJson, writeIfAbsent } from '../lib/fs-helpers.mjs';
import { generateImportWallBaseline } from '../lib/generate/generate-import-wall-baseline.mjs';
import { generateStructureBaselines } from '../lib/generate/generate-structure-baseline.mjs';
import {
  buildFullHook,
  buildGuardBlock,
  extractGuardBlock,
  hasFragment,
  removeFragment,
  removeGuardBlock,
  replaceGuardBlock,
} from '../lib/husky/husky-block.mjs';
import {
  ensureFallowGitignore,
  installFallow,
  saveFallowBaselines,
  wireFallowGate,
} from '../lib/install/install-fallow.mjs';
import {
  installHookRegistrations,
  removeHookRegistrations,
  removeHookScripts,
  syncHookScripts,
} from '../lib/install/install-hooks.mjs';
import { installSearchCode } from '../lib/install/install-search-code.mjs';
import { installOverlay } from '../lib/overlay.mjs';
import { installStandaloneConfigs, installStandaloneHook } from '../lib/standalone.mjs';
import { removeAgents, removeSkills } from '../lib/sync-manifest.mjs';
import { runWizard } from '../lib/wizard.mjs';
import { syncAgents } from './sync-agents.mjs';
import { syncSkills } from './sync-skills.mjs';

const INIT_VERSION = 2;

// Stacks with a structure-lint preset (eslint.config.mjs + eslint/domains.mjs + baselines).
// next/node-service are deliberately OUT until a template ships for them — listing one here
// would make init read a non-existent templates/<stack> dir.
const STRUCTURE_STACKS = new Set(['electron', 'react-app', 'component-lib']);

// The structure files each stack emits, [src-relative-to-template, dest-relative-to-cwd].
// The full install set adds biome/tsconfig/guard.config on top (installStructureFiles).
const STRUCTURE_TEMPLATE_FILES = {
  electron: [
    ['eslint.config.mjs', 'eslint.config.mjs'],
    ['eslint/domains.mjs', 'eslint/domains.mjs'],
    ['eslint/baselines/exempt.mjs', 'eslint/baselines/exempt.mjs'],
  ],
  // react-app — CONFIG-DRIVEN (data): components + pages trees declared in guard.config.json, compiled
  // by the shared shim. No per-stack eslint.config / domains. (electron is the one remaining preset.)
  'react-app': [
    ['_shared/eslint.config.mjs', 'eslint.config.mjs'],
    ['_shared/exempt.mjs', 'eslint/baselines/exempt.mjs'],
  ],
  // Flat component lib — CONFIG-DRIVEN (the universal path): the topology is a `structure` block in
  // guard.config.json, and eslint.config.mjs is the shared shim that compiles it via devkit's
  // compileToEslint. No per-stack eslint.config / domains. `_shared/` srcs resolve from templates/.
  'component-lib': [
    ['_shared/eslint.config.mjs', 'eslint.config.mjs'],
    ['_shared/exempt.mjs', 'eslint/baselines/exempt.mjs'],
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
    searchSteering: false,
    agentHooks: false,
    searchCode: false,
    standalone: false,
    overlay: false,
    baselinesOnly: false,
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
    else if (a === '--search-steering') flags.searchSteering = true;
    else if (a === '--agent-hooks') flags.agentHooks = true;
    else if (a === '--search-code') flags.searchCode = true;
    else if (a === '--standalone') flags.standalone = true;
    else if (a === '--overlay') flags.overlay = true;
    else if (a === '--baselines-only') flags.baselinesOnly = true;
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
  for (const id of ['biome', 'tsconfig', 'skills', 'agents', 'husky', 'structure']) {
    if (flags.no.has(id)) sel[id] = false;
  }
  if (flags.no.has('guards')) sel.guards = [];
  else if (flags.guards) sel.guards = flags.guards.filter((g) => GUARD_IDS.includes(g));
  // fallow + the agent-hook components are OPT-IN: off unless their flag is passed (and --no-* keeps off).
  sel.fallow = flags.fallow && !flags.no.has('fallow');
  sel.searchSteering = flags.searchSteering && !flags.no.has('search-steering');
  sel.agentHooks = flags.agentHooks && !flags.no.has('agent-hooks');
  sel.searchCode = flags.searchCode && !flags.no.has('search-code');
  // Agent surfaces: both by default; --no-claude / --no-cursor drop one (don't double-install).
  // ponytail: --no-claude --no-cursor leaves [] → skills/agents sync nowhere (explicit, allowed).
  sel.agentTargets = AGENT_TARGETS.filter((t) => !flags.no.has(t));
  return sel;
}

// Which components are currently wired? Read the recorded set first (authoritative), then
// fall back to on-disk detection for a pre-wizard repo with no `components` block.
function detectInstalled(cwd) {
  const cfg = readJson(join(cwd, '.devkit', 'config.json'));
  const installed = new Set();
  const recorded = cfg?.components;
  if (recorded) {
    for (const id of [
      'biome',
      'tsconfig',
      'skills',
      'agents',
      'searchSteering',
      'agentHooks',
      'husky',
      'structure',
    ]) {
      if (recorded[id]) installed.add(id);
    }
    if (recorded.guards?.length) installed.add('guards');
    return installed;
  }
  // Per-package configs live in cwd; the hook + skills are at the git root (monorepo) or cwd
  // (single-package, where gitRoot === cwd).
  if (existsSync(join(cwd, 'biome.jsonc'))) installed.add('biome');
  if (existsSync(join(cwd, 'tsconfig.json'))) installed.add('tsconfig');
  if (existsSync(join(cwd, 'eslint.config.mjs'))) installed.add('structure');
  const { gitRoot } = detectGitRoot(cwd);
  if (existsSync(join(gitRoot, '.devkit', 'skills-manifest.json'))) installed.add('skills');
  if (existsSync(join(gitRoot, '.devkit', 'agents-manifest.json'))) installed.add('agents');
  if (existsSync(join(gitRoot, '.devkit', 'agent-hooks-manifest.json')))
    installed.add('agentHooks');
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  if (existsSync(hookPath)) {
    installed.add('husky');
    const hook = readFileSync(hookPath, 'utf8');
    if (GUARD_IDS.some((g) => hasFragment(hook, `guard-${g}`))) installed.add('guards');
  }
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

// Reason: flat orchestration: builds a [src,dest] item list from independent `if (sel.x)` toggles, then one write loop with a dry-run branch; high branch COUNT, each toggle trivial and non-nested
// fallow-ignore-next-line complexity
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
    // A `_shared/<file>` src resolves from templates/ (the universal shim/exempt shared across stacks);
    // everything else from the stack's own template dir.
    const srcPath = src.startsWith('_shared/')
      ? join(packageDir(), 'templates', src)
      : join(tplDir, src);
    if (dryRun) {
      console.log(
        `  [dry-run] ${existsSync(target) && !force ? 'skip (exists)' : 'write'} ${dest}`,
      );
    } else {
      logWrite(writeIfAbsent(target, readText(srcPath), { force }), dest);
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

// Reason: the branches ARE the per-component devDep/script manifest: each `...(sel.x ? {...} : {})` spread names exactly which deps+scripts a component owns; flattening scatters this single source-of-truth table that remove() mirrors
// fallow-ignore-next-line complexity
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

// Wire the pre-commit hook from the selection. The hook lives at `hookRoot` (the git root —
// which is `cwd` for a single-package repo, or the monorepo root when init runs in a package
// subdir). `pkgRel` scopes the block + `cd`s the gates into the package. Fresh repo → full
// hook; existing hook → replace/insert THIS package's devkit-guards block (others untouched).
function installHusky(sel, hookRoot, pkgRel, dryRun) {
  const where = pkgRel ? ` (git root, scoped to ${pkgRel})` : '';
  const hookPath = join(hookRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) {
    if (dryRun) {
      console.log(`  [dry-run] write .husky/pre-commit${where} (assembled from selection)`);
      return;
    }
    mkdirSync(join(hookRoot, '.husky'), { recursive: true });
    writeFileSync(hookPath, buildFullHook(sel, pkgRel));
    chmodSync(hookPath, 0o755);
    console.log(`  ✓ created .husky/pre-commit${where}`);
    return;
  }
  const current = readText(hookPath);
  const block = buildGuardBlock(sel, pkgRel);
  const merged = replaceGuardBlock(current, block, pkgRel);
  if (merged === current) {
    console.log('  • .husky/pre-commit already wired (devkit-guards block current)');
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] refresh devkit-guards block${where} in existing .husky/pre-commit`);
    return;
  }
  writeFileSync(hookPath, merged);
  console.log(`  ✓ refreshed devkit-guards block${where} in .husky/pre-commit`);
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

/** The consumer's permanent import-wall exemptions (eslint/baselines/exempt.mjs `importWallExempt`), or empty. */
export async function readImportWallExempt(cwd) {
  const file = join(cwd, 'eslint', 'baselines', 'exempt.mjs');
  if (!existsSync(file)) return new Set();
  try {
    const { importWallExempt = [] } = await import(pathToFileURL(file).href);
    return new Set(importWallExempt.map((m) => m.pattern));
  } catch {
    return new Set();
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
    // Honour the consumer's hand-maintained import-wall exemptions (eslint/baselines/exempt.mjs):
    // an exempt file is a permanent architectural allowance, not a violator, so it must be skipped
    // during the scan — else it would be re-grandfathered every regen.
    generateImportWallBaseline(cwd, { ...opts, exemptPatterns: await readImportWallExempt(cwd) });
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
// Reason: flat fail-open orchestration: each fallow step (install → gitignore → optional init → wire gate → save baselines) is a sequential guarded call with its own dryRun/ok branch; the branch COUNT is the step count, no nesting
// fallow-ignore-next-line complexity
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

// Flip the commented structure-lint placeholder to the live `bunx eslint src` call, scoped to
// THIS package's block (a monorepo hook may hold several). Inside a package block the gates run
// cd'd into the package, so `bunx eslint src` resolves the package's own eslint.config + src.
function enableStructureLint(hookRoot, pkgRel, dryRun) {
  const hookPath = join(hookRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return;
  const content = readFileSync(hookPath, 'utf8');
  const block = extractGuardBlock(content, pkgRel);
  if (!block) {
    console.log('  ! no devkit-guards block to enable structure-lint in');
    return;
  }
  if (block.includes('\nbunx eslint src')) {
    console.log('  • structure-lint already enabled in .husky/pre-commit');
    return;
  }
  if (!COMMENTED_LINT_RE.test(block)) {
    console.log('  ! could not find the commented structure-lint placeholder to enable');
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] uncomment `bunx eslint src` in .husky/pre-commit');
    return;
  }
  // `|| exit 1` so a structure violation BLOCKS the commit — a bare line would let a non-zero
  // eslint pass (no `set -e`). In a package subshell the exit propagates via the `) || exit 1`.
  const newBlock = block.replace(COMMENTED_LINT_RE, '\nbunx eslint src || exit 1\n');
  writeFileSync(hookPath, replaceGuardBlock(content, newBlock, pkgRel));
  console.log('  ✓ enabled structure-lint (`bunx eslint src`) in .husky/pre-commit');
}

// ── removal steps (SAFE: never delete a file devkit didn't create) ───────────

// Reason: CRAP-flagged thin package.json mutator: two near-identical key-delete loops (devDeps, scripts) each gated on existence + dryRun; exercised end-to-end via every remove* caller, not unit-isolated
// fallow-ignore-next-line complexity
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
// Reason: the branches ARE the safe-strip decision tiers: unparseable → bail, no-devkit-extends → bail, array-extends → filter, scalar-extends → delete; each guard exists to NEVER delete a tsconfig devkit didn't author
// fallow-ignore-next-line complexity
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

// Remove this package's devkit-guards block from the (git-root) hook, leaving the rest + any
// other packages' blocks intact.
function removeHusky(hookRoot, pkgRel, dryRun) {
  const hookPath = join(hookRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return;
  const { content, removed } = removeGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel);
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

// Remove a single fragment (one guard, or the biome step) from THIS package's block. Scoped via
// extract→removeFragment→replace so a shared sentinel in another package's block is untouched.
function removeHuskyPiece(hookRoot, pkgRel, id, dryRun) {
  const hookPath = join(hookRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return false;
  const content = readFileSync(hookPath, 'utf8');
  const block = extractGuardBlock(content, pkgRel);
  if (!block) return false;
  const { content: newBlock, removed } = removeFragment(block, id);
  if (!removed) return false;
  if (dryRun) {
    console.log(`  [dry-run] remove ${id} from .husky/pre-commit`);
    return true;
  }
  writeFileSync(hookPath, replaceGuardBlock(content, newBlock, pkgRel));
  console.log(`  ✓ removed ${id} from .husky/pre-commit`);
  return true;
}

// Remove ONLY devkit-created structure files (guarded by config marker), re-comment the line.
// Reason: safe-removal sequence guarded per artifact: marker check → delete template files → delete baselines → strip pkg entries → re-comment the live eslint hook line; each existsSync/dryRun branch is a separate file devkit must verify it created before touching
// fallow-ignore-next-line complexity
function removeStructure(cwd, prevConfig, hookRoot, pkgRel, dryRun) {
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
  // Re-comment the live structure-lint line inside THIS package's block at the git-root hook.
  const hookPath = join(hookRoot, '.husky', 'pre-commit');
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, 'utf8');
    const block = extractGuardBlock(content, pkgRel);
    const live = '\nbunx eslint src || exit 1\n';
    if (block?.includes(live)) {
      const newBlock = block.replace(
        live,
        '\n# bunx eslint src  # uncomment after `devkit init --stack <x>`\n',
      );
      if (!dryRun) writeFileSync(hookPath, replaceGuardBlock(content, newBlock, pkgRel));
      console.log(
        `  ${dryRun ? '[dry-run]' : '✓'} re-commented structure-lint line in .husky/pre-commit`,
      );
    }
  }
}

// Reason: flat removal dispatch: one `if (remove.includes(id)) removeX()` per component, ordered so guards (line-level) precede husky (block-level); high branch COUNT mirrors the component list, each branch a single delegated call
// fallow-ignore-next-line complexity
function applyRemovals(cwd, remove, prevConfig, gitRoot, pkgRel, dryRun, selection) {
  if (!remove.length) return;
  console.log(`\nRemoving deselected component(s): ${remove.join(', ')}`);
  // Guards (individual lines) before husky (whole-block) so order is irrelevant.
  if (remove.includes('guards')) {
    for (const g of GUARD_IDS) removeHuskyPiece(gitRoot, pkgRel, `guard-${g}`, dryRun);
  }
  if (remove.includes('biome')) removeBiome(cwd, dryRun);
  if (remove.includes('tsconfig')) removeTsconfig(cwd, dryRun);
  if (remove.includes('skills')) removeSkills(gitRoot, dryRun);
  if (remove.includes('agents')) removeAgents(gitRoot, dryRun);
  if (remove.includes('agentHooks')) removeHookScripts(gitRoot, { dryRun });
  // searchSteering/agentHooks own hook registrations. Re-derive the survivors and re-install:
  // installHookRegistrations strips ALL devkit hooks first, so the deselected one's entries drop
  // and only the still-selected component's entries are re-added (idempotent). With none left,
  // strip-only via removeHookRegistrations.
  if (remove.includes('searchSteering') || remove.includes('agentHooks')) {
    const survivors = [
      selection.searchSteering && !remove.includes('searchSteering') && 'searchSteering',
      selection.agentHooks && !remove.includes('agentHooks') && 'agentHooks',
    ].filter(Boolean);
    if (survivors.length) installHookRegistrations(gitRoot, survivors, { dryRun });
    else removeHookRegistrations(gitRoot, { dryRun });
  }
  if (remove.includes('structure')) removeStructure(cwd, prevConfig, gitRoot, pkgRel, dryRun);
  if (remove.includes('husky')) removeHusky(gitRoot, pkgRel, dryRun);
}

// ── orchestration ────────────────────────────────────────────────────────────

// Overlay (local-only) install: invisible to git (.git/info/exclude), non-invasive (extends the
// repo, edits nothing committed). Self-contained — writes its own git-ignored .devkit/config.json
// and returns; applyInit's package/standalone path never runs for an overlay.
function applyOverlay(cwd, plan, pkgRel, devkitRef) {
  const { stack, selection, force = false, dryRun = false } = plan;
  console.log(
    `devkit init${dryRun ? ' (dry-run)' : ''} — OVERLAY (local-only) — stack=${stack}, devkit=${devkitRef}`,
  );
  console.log(
    '  invisible to git (.git/info/exclude); extends the repo; edits nothing committed\n',
  );
  const { origHooksPath } = installOverlay(cwd, selection, stack, force, dryRun);
  if (selection.guards?.includes('fanout') || selection.guards?.includes('size')) {
    console.log('  freeze baselines (grandfather current tree)');
    runFreezes(cwd, dryRun);
  }
  if (!dryRun) {
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(
      join(cwd, '.devkit', 'config.json'),
      `${JSON.stringify(
        {
          stack,
          devkitRef,
          initVersion: INIT_VERSION,
          overlay: true,
          pkgRel,
          origHooksPath, // what core.hooksPath was before — `devkit clean` restores it
          components: { guards: [...(selection.guards ?? [])] },
        },
        null,
        2,
      )}\n`,
    );
    console.log('  ✓ wrote .devkit/config.json (git-ignored)');
  }
  console.log(
    `\n${dryRun ? 'Dry-run complete (nothing written).' : 'devkit overlay complete — local-only.'}`,
  );
  console.log(
    '  Re-run `devkit init --overlay` after a `bun install` (husky re-claims core.hooksPath).',
  );
}

// Sync skills / agents / agent-hook scripts + their hook registrations to the SELECTED agent
// surface(s) (.claude / .cursor), then prune any surface a prior run installed but that's now
// deselected. Repo-wide → operates on the git root. Returns the resolved agentTargets (for config).
// Reason: flat orchestration: ordered `if (selection.x) syncX()` steps (skills → agents → hook scripts → registrations → prune) that must run in dependency order since registrations reference the scripts synced first; branch COUNT is the surface count, each step trivial
// fallow-ignore-next-line complexity
function installAgentSurfaces(gitRoot, selection, dryRun) {
  const agentTargets = selection.agentTargets ?? AGENT_TARGETS;
  if (selection.skills) {
    console.log('7. skills');
    // Skills are repo-wide → sync to the git root's selected agent surface(s) (+ manifest).
    syncSkills(dryRun ? ['--dry-run'] : [], gitRoot, agentTargets);
  }
  if (selection.agents) {
    console.log('7a. agents');
    // Agents are repo-wide too → sync to the git root's selected agent surface(s) (+ manifest).
    syncAgents(dryRun ? ['--dry-run'] : [], gitRoot, agentTargets);
  }
  // Agent-hook scripts (agentHooks) live under <surface>/hooks; the registrations below reference
  // them, so sync the scripts first.
  if (selection.agentHooks) {
    console.log('7b. agent-hook scripts');
    syncHookScripts(gitRoot, { dryRun, targets: agentTargets });
  }
  // Register the agent hooks each selected component owns into the selected surfaces' settings.
  const hookComponents = [
    selection.searchSteering && 'searchSteering',
    selection.agentHooks && 'agentHooks',
  ].filter(Boolean);
  if (hookComponents.length) {
    console.log('7c. agent hook registrations');
    installHookRegistrations(gitRoot, hookComponents, { dryRun, targets: agentTargets });
  }
  pruneDeselectedSurfaces(gitRoot, selection, agentTargets, hookComponents, dryRun);
  return agentTargets;
}

// A previous run may have synced to BOTH surfaces; if a surface is now deselected, remove devkit's
// files from it (manifests kept — the surviving surface still tracks them). Only for components
// staying selected; a fully-deselected component is removed wholesale by applyRemovals. Skipped on a
// fresh install where the dropped surface has no devkit dir (no work, no noise).
function pruneDeselectedSurfaces(gitRoot, selection, agentTargets, hookComponents, dryRun) {
  const prunedTargets = AGENT_TARGETS.filter((t) => !agentTargets.includes(t));
  // Settings file holding hook registrations differs per surface (Claude settings.json vs Cursor
  // hooks.json) — searchSteering writes one without a hooks/ script dir, so check it too.
  const settingsFile = { claude: '.claude/settings.json', cursor: '.cursor/hooks.json' };
  const hasPrunableContent = prunedTargets.some(
    (t) =>
      ['skills', 'agents', 'hooks'].some((kind) => existsSync(join(gitRoot, `.${t}`, kind))) ||
      existsSync(join(gitRoot, settingsFile[t])),
  );
  if (!prunedTargets.length || !hasPrunableContent) return;
  console.log(`7d. prune deselected agent surface(s): ${prunedTargets.join(', ')}`);
  if (selection.skills) removeSkills(gitRoot, dryRun, prunedTargets, false);
  if (selection.agents) removeAgents(gitRoot, dryRun, prunedTargets, false);
  if (selection.agentHooks)
    removeHookScripts(gitRoot, { dryRun, targets: prunedTargets, dropManifest: false });
  if (hookComponents.length) removeHookRegistrations(gitRoot, { dryRun, targets: prunedTargets });
}

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
 * @param {boolean} [plan.standalone] no-package mode — vendored configs + global fail-open hook
 * @param {boolean} [plan.overlay] local-only mode — git-ignored, non-invasive, extends the repo
 * @param {string} [plan.devkitRef]
 */
// Reason: flat top-level init pipeline: numbered sequential steps (1 configs → 2 package.json → 3 husky → 4 freeze → 5/6 structure → 7 surfaces → 8 fallow → 9 config), each gated by a selection flag and delegated to a named installer; the branch COUNT is the step count, near-zero nesting
// fallow-ignore-next-line complexity
export async function applyInit(cwd, plan) {
  const {
    stack,
    selection,
    remove = [],
    force = false,
    dryRun = false,
    interactive = false,
    scanRoots = null,
    standalone = false,
    overlay = false,
  } = plan;
  // Standalone (no-package): structure-lint is omitted (its eslint flat-config needs the plugin
  // resolvable from the repo, which a no-package setup can't provide).
  const isStructure = !standalone && selection.structure && STRUCTURE_STACKS.has(stack);
  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = plan.devkitRef ?? (devkitPkg ? `v${devkitPkg.version}` : 'main');
  const prevConfig = readJson(join(cwd, '.devkit', 'config.json'));
  // Monorepo: configs/baselines stay in cwd (the package), but the husky hook + repo-wide
  // skills target the git root, with gates scoped `cd <pkgRel>`. Single-package repo → gitRoot
  // === cwd, pkgRel '' → everything as before.
  const { gitRoot, pkgRel } = detectGitRoot(cwd);

  // Overlay (local-only): a self-contained path — invisible to git, non-invasive. Returns early.
  if (overlay) return applyOverlay(cwd, plan, pkgRel, devkitRef);

  console.log(
    `devkit init${dryRun ? ' (dry-run — no files written)' : ''} — stack=${stack}, devkit=${devkitRef}`,
  );
  if (standalone) {
    console.log('  standalone: no package.json dep — global devkit CLI, fail-open hook');
  }
  if (pkgRel) {
    console.log(`  monorepo: package "${pkgRel}" — hook + skills at the git root (${gitRoot})`);
  }
  const on = COMPONENTS.filter((c) =>
    c.id === 'guards'
      ? selection.guards.length
      : selection[c.id] && !(c.id === 'structure' && !isStructure),
  ).map((c) => c.id);
  console.log(`  components: ${on.join(', ') || '(none)'}\n`);

  console.log('1. configs');
  if (standalone) installStandaloneConfigs(cwd, stack, selection, force, dryRun);
  else if (isStructure) installStructureFiles(cwd, stack, force, dryRun);
  else installConfigs(cwd, selection, force, dryRun);
  applyScanRoots(cwd, scanRoots, dryRun);

  // Standalone touches NO package.json (the whole point — no private dep in a shared repo).
  if (!standalone) {
    console.log('2. package.json');
    patchPackageJson(cwd, devkitRef, selection, isStructure, dryRun);
  }

  if (selection.husky) {
    console.log('3. husky pre-commit');
    if (standalone) installStandaloneHook(gitRoot, pkgRel, selection, dryRun);
    else installHusky(selection, gitRoot, pkgRel, dryRun);
  }

  if (selection.guards?.includes('fanout') || selection.guards?.includes('size')) {
    console.log('4. freeze baselines');
    runFreezes(cwd, dryRun);
  }

  if (isStructure) {
    console.log('5. structure + import-wall baselines (grandfather current tree)');
    await runStructureBaselines(cwd, stack, dryRun);
    console.log('6. enable structure-lint in pre-commit');
    enableStructureLint(gitRoot, pkgRel, dryRun);
  }

  // Skills / agents / agent-hooks → the selected agent surface(s), with a prune of any now-dropped
  // surface a prior run installed. Returns the resolved agentTargets (recorded in the config below).
  const agentTargets = installAgentSurfaces(gitRoot, selection, dryRun);

  if (selection.fallow) {
    console.log('8. fallow (optional code-health layer)');
    await applyFallow(cwd, dryRun, interactive);
  }

  if (selection.searchCode) {
    console.log('8b. search-code (opt-in semantic search)');
    installSearchCode(cwd, dryRun);
  }

  // Removals (deselected + present).
  applyRemovals(cwd, remove, prevConfig, gitRoot, pkgRel, dryRun, selection);

  // .devkit/config.json with the component selection.
  console.log('9. .devkit/config.json');
  const components = {
    biome: selection.biome,
    tsconfig: selection.tsconfig,
    skills: selection.skills,
    agents: Boolean(selection.agents),
    searchSteering: Boolean(selection.searchSteering),
    agentHooks: Boolean(selection.agentHooks),
    husky: selection.husky,
    structure: isStructure,
    fallow: Boolean(selection.fallow),
    searchCode: Boolean(selection.searchCode),
    agentTargets: [...agentTargets],
    guards: selection.husky ? [...selection.guards] : [],
  };
  // Record pkgRel (monorepo: '' for a root install) so doctor finds the git-root hook + skills,
  // and standalone (no-package mode) so doctor doesn't flag a missing devkit pin / deps.
  // Stamp the devkit version that set this repo up — `doctor` warns if a contributor later runs an
  // OLDER devkit than the repo was initialised with (or below a hand-declared `minDevkit` floor).
  const devkitVersion = readJson(join(packageDir(), 'package.json'))?.version;
  const config = {
    stack,
    devkitRef,
    devkitVersion,
    initVersion: INIT_VERSION,
    pkgRel,
    standalone,
    components,
  };
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

// Reason: flat CLI dispatch: resolves one `selection` via three converging paths (interactive wizard / --yes flags / non-TTY) then hands a fully-resolved plan to applyInit; the branches ARE the resolution-mode fork, each path linear with no shared nesting
// fallow-ignore-next-line complexity
export default async function run(args, cwd) {
  const flags = parseFlags(args);
  const detectedStack = flags.stack ?? detectStack(cwd);
  // Mode: --overlay / --standalone seed it; the wizard asks (so the interactive flow exposes it).
  const detectedMode = flags.overlay ? 'overlay' : flags.standalone ? 'standalone' : 'package';
  const interactive = !flags.yes && process.stdout.isTTY && !flags.dryRun;

  let stack = detectedStack;
  let selection;
  let remove = [];
  let mode = detectedMode;

  // --baselines-only: re-derive the structure + import-wall baselines and NOTHING else (no config
  // emit, package.json, husky, freezes, skills/agents, .devkit/config.json). For the RARE legit
  // regen — a structure-RULE change (the baseline is otherwise generate-once + shrink-only). Guarded
  // to the package-mode structure stacks: overlay/standalone omit structure; a bare repo has no preset.
  if (flags.baselinesOnly) {
    if (mode !== 'package') {
      console.error(
        'devkit init --baselines-only: unsupported in overlay/standalone mode (no structure preset).',
      );
      return 1;
    }
    if (!structureAvailableFor(stack)) {
      console.error(`devkit init --baselines-only: no structure-lint preset for stack "${stack}".`);
      return 1;
    }
    if (!existsSync(join(cwd, 'eslint.config.mjs'))) {
      console.error(
        'devkit init --baselines-only: no eslint.config.mjs — run a full `devkit init` first.',
      );
      return 1;
    }
    console.log('devkit init --baselines-only — regenerating structure + import-wall baselines');
    await runStructureBaselines(cwd, stack, flags.dryRun);
    return 0;
  }

  if (interactive) {
    const installed = detectInstalled(cwd);
    const result = await runWizard({
      detectedStack,
      detectedMode,
      structureAvailable: structureAvailableFor(detectedStack),
      installed,
    });
    if (!result) return 0; // cancelled — nothing written
    ({ mode, stack, selection, remove } = result);
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
    standalone: mode === 'standalone',
    overlay: mode === 'overlay',
  });
  if (interactive) outro('Done — run `devkit doctor` to verify.');
  return 0;
}

export { detectInstalled, parseFlags, selectionFromFlags };
