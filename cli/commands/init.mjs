/**
 * `devkit init` — scaffold a consumer repo onto devkit's shared configs + gate-engine.
 *
 * Idempotent (create-if-absent, reports "already wired" per step). Steps (generic stack):
 *   1. guard.config.json
 *   2. biome.jsonc + tsconfig.json (extend devkit's bare subpaths)
 *   3. consumer package.json devDeps + scripts
 *   4. .husky/pre-commit (write template OR append the devkit-guards block, never clobber)
 *   5. guard-fanout freeze + guard-size freeze (grandfather current debt)
 *   6. sync-skills
 *   7. .devkit/config.json
 *   8. print (never run) the referenced-tool steps (fallow, search-code index)
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectStack } from '../lib/detect-stack.mjs';
import { packageDir, readJson, writeIfAbsent } from '../lib/fs-helpers.mjs';
import { generateImportWallBaseline } from '../lib/generate-import-wall-baseline.mjs';
import { generateStructureBaselines } from '../lib/generate-structure-baseline.mjs';
import { extractBlock, mergeBlock, readHook } from '../lib/husky.mjs';
import { syncSkills } from './sync-skills.mjs';

const INIT_VERSION = 1;

// Stacks with a structure-lint preset (eslint.config.mjs + eslint/domains.mjs +
// per-tree baselines). Generic gets the gate set only; these get structure too.
const STRUCTURE_STACKS = new Set(['electron']);

// The commented structure-lint placeholder in the generic husky template that a
// structure stack flips live (enableStructureLint).
const COMMENTED_LINT_RE = /\n# bunx eslint src.*\n/;

// The files each structure stack emits, as [src-relative-to-template, dest-relative-to-cwd].
const STRUCTURE_TEMPLATE_FILES = {
  electron: [
    ['eslint.config.mjs', 'eslint.config.mjs'],
    ['eslint/domains.mjs', 'eslint/domains.mjs'],
    ['eslint/baselines/exempt.mjs', 'eslint/baselines/exempt.mjs'],
    ['guard.config.json', 'guard.config.json'],
    ['biome.jsonc', 'biome.jsonc'],
    ['tsconfig.json', 'tsconfig.json'],
  ],
};

function parseFlags(args) {
  const flags = { yes: false, dryRun: false, force: false, stack: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--stack') flags.stack = args[++i];
  }
  return flags;
}

// Report the outcome of a writeIfAbsent-style step, honouring dry-run.
function logWrite(action, label) {
  const map = { created: '✓ created', forced: '✓ overwrote', exists: '• already wired' };
  console.log(`  ${map[action] ?? action} ${label}`);
}

// Step 1+2: template configs that extend devkit. A structure stack (electron)
// emits the structure-lint preset (eslint.config.mjs + eslint/domains.mjs +
// exempt.mjs) on top of the shared guard/biome/tsconfig set; generic emits only
// the shared set.
function writeConfigs(cwd, stack, force, dryRun) {
  const isStructure = STRUCTURE_STACKS.has(stack);
  const tplDir = join(packageDir(), 'templates', isStructure ? stack : 'generic');
  const items = isStructure
    ? STRUCTURE_TEMPLATE_FILES[stack]
    : [
        ['guard.config.json', 'guard.config.json'],
        ['biome.jsonc', 'biome.jsonc'],
        ['tsconfig.json', 'tsconfig.json'],
      ];
  for (const [src, dest] of items) {
    const content = readText(join(tplDir, src));
    const target = join(cwd, dest);
    if (dryRun) {
      console.log(
        `  [dry-run] ${existsSync(target) && !force ? 'skip (exists)' : 'write'} ${dest}`,
      );
    } else {
      logWrite(writeIfAbsent(target, content, { force }), dest);
    }
  }
}

// Read a template file verbatim (preserve comments in .jsonc — don't round-trip through JSON.parse).
function readText(path) {
  return readFileSync(path, 'utf8');
}

// Step 3: patch the consumer package.json devDeps + scripts (idempotent). A
// structure stack also pulls eslint + the project-structure plugin + the TS parser
// and adds the structure-lint scripts.
function patchPackageJson(cwd, devkitRef, isStructure, dryRun) {
  const pkgPath = join(cwd, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) {
    console.log('  ! no package.json — skipping devDeps/scripts wiring');
    return;
  }
  const devDeps = {
    '@norvalbv/devkit': `git+ssh://git@github.com/norvalbv/devkit.git#${devkitRef}`,
    '@biomejs/biome': '^2.5.0',
    husky: '^9.1.7',
    jscpd: '^4.2.4',
    ...(isStructure
      ? {
          eslint: '^9.0.0',
          'eslint-plugin-project-structure': '^3.0.0',
          '@typescript-eslint/parser': '^8.0.0',
        }
      : {}),
  };
  const scripts = {
    lint: 'biome check .',
    format: 'biome check --write .',
    prepare: 'husky',
    'guard:freeze': 'guard-fanout freeze && guard-size freeze',
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

// Step 4: wire .husky/pre-commit (write template if absent, else append marker block).
function wireHusky(cwd, dryRun) {
  const tplPath = join(packageDir(), 'templates', '_shared', 'husky', 'pre-commit.generic.sh');
  const tplContent = readText(tplPath);
  const hookPath = join(cwd, '.husky', 'pre-commit');

  if (!existsSync(hookPath)) {
    if (dryRun) {
      console.log('  [dry-run] write .husky/pre-commit (full generic template) + husky init');
      return;
    }
    mkdirSync(join(cwd, '.husky'), { recursive: true });
    writeFileSync(hookPath, tplContent);
    chmodSync(hookPath, 0o755);
    console.log('  ✓ created .husky/pre-commit (generic gates)');
    return;
  }

  // Hook present (frink / marketing have their own) — insert/refresh only the marker block.
  const block = extractBlock(tplContent);
  const current = readHook(hookPath);
  const { content, action } = mergeBlock(current, block);
  if (action === 'unchanged') {
    console.log('  • .husky/pre-commit already wired (devkit-guards block current)');
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] ${action} devkit-guards block in existing .husky/pre-commit`);
    return;
  }
  writeFileSync(hookPath, content);
  console.log(`  ✓ ${action} devkit-guards block in .husky/pre-commit`);
}

// Step 5: grandfather current debt so the ratchets only block FUTURE growth.
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
      console.log(
        `  ! ${name} freeze failed: ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}`,
      );
    }
  }
}

// Structure stacks: grandfather the consumer's existing tree against the
// just-emitted eslint.config.mjs + eslint/domains.mjs. Runs the folder-structure
// walker (per existing tree) + the import-wall scan generator. Skipped on dry-run.
async function runStructureBaselines(cwd, dryRun) {
  if (dryRun) {
    console.log('  [dry-run] skip structure + import-wall baseline generators');
    return;
  }
  // Folder-structure grandfathers (per existing tree). Reads the emitted eslint/domains.mjs.
  try {
    await generateStructureBaselines(cwd, { log: (m) => console.log(m) });
  } catch (e) {
    console.log(`  ! structure baseline generator failed: ${firstLine(e)}`);
  }
  // Import-wall grandfather (scan mode). Needs eslint installed in the consumer.
  try {
    generateImportWallBaseline(cwd, { log: (m) => console.log(m) });
  } catch (e) {
    console.log(`  ! import-wall baseline generator skipped: ${firstLine(e)}`);
    console.log('    (install deps — bun install — then re-run `devkit init --stack electron`)');
  }
}

function firstLine(e) {
  return (e.stderr || e.message || '').toString().trim().split('\n')[0];
}

// Structure stacks: flip the commented structure-lint line in the pre-commit hook
// to the live `bunx eslint <roots>` call. Idempotent: a no-op once already live.
function enableStructureLint(cwd, dryRun) {
  const hookPath = join(cwd, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return;
  const content = readFileSync(hookPath, 'utf8');
  const LIVE = '\nbunx eslint src\n';
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
  writeFileSync(hookPath, content.replace(COMMENTED_LINT_RE, LIVE));
  console.log('  ✓ enabled structure-lint (`bunx eslint src`) in .husky/pre-commit');
}

// Step 8: print (never run) the referenced-tool follow-ups.
function printReferencedSteps() {
  console.log('\nNext, by hand (devkit prints these — it never runs them):');
  console.log('  • fallow (optional code-health audit): install per https://docs.fallow.tools');
  console.log('  • search-code (semantic dup matcher): point guard-dup at your index via');
  console.log('      GUARD_INDEX_PATH=<path/to/index.db>  (or indexPath in guard.config.json).');
  console.log(
    '      Without it the duplication gate fails open (clone + ratchet gates still run).',
  );
}

export default async function run(args, cwd) {
  const flags = parseFlags(args);
  const stack = flags.stack ?? detectStack(cwd);
  const isStructure = STRUCTURE_STACKS.has(stack);
  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : 'main';

  if (stack !== 'generic' && !isStructure) {
    console.log(`devkit init: stack "${stack}" detected — wires the GENERIC gate set`);
    console.log(
      '  (no structure-lint preset for this stack yet; only electron has one — left OFF here).',
    );
  }
  console.log(
    `devkit init${flags.dryRun ? ' (dry-run — no files written)' : ''} — stack=${stack}, devkit=${devkitRef}\n`,
  );

  console.log('1. configs');
  writeConfigs(cwd, stack, flags.force, flags.dryRun);

  console.log('2. package.json');
  patchPackageJson(cwd, devkitRef, isStructure, flags.dryRun);

  console.log('3. husky pre-commit');
  wireHusky(cwd, flags.dryRun);

  console.log('4. freeze baselines');
  runFreezes(cwd, flags.dryRun);

  if (isStructure) {
    console.log('5. structure + import-wall baselines (grandfather current tree)');
    await runStructureBaselines(cwd, flags.dryRun);
    console.log('6. enable structure-lint in pre-commit');
    enableStructureLint(cwd, flags.dryRun);
  }

  const skillsStep = isStructure ? 7 : 5;
  console.log(`${skillsStep}. skills`);
  syncSkills(flags.dryRun ? ['--dry-run'] : [], cwd);

  const configStep = isStructure ? 8 : 6;
  console.log(`${configStep}. .devkit/config.json`);
  const steps = isStructure
    ? [
        'configs',
        'package.json',
        'husky',
        'freeze',
        'structure-baselines',
        'structure-lint',
        'skills',
      ]
    : ['configs', 'package.json', 'husky', 'freeze', 'skills'];
  const config = {
    stack,
    devkitRef,
    initVersion: INIT_VERSION,
    steps,
  };
  const configPath = join(cwd, '.devkit', 'config.json');
  if (flags.dryRun) {
    console.log('  [dry-run] write .devkit/config.json');
  } else {
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log('  ✓ wrote .devkit/config.json');
  }

  printReferencedSteps();
  console.log(
    `\n${flags.dryRun ? 'Dry-run complete (nothing written).' : 'devkit init complete.'} Run \`devkit doctor\` to verify.`,
  );
  return 0;
}
