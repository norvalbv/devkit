/**
 * Standalone (no-package) install — devkit as a GLOBAL CLI (`bun add -g`), à la `fallow init`.
 * A consumer repo gets the guardrails with ZERO `@norvalbv/devkit` in package.json, so a SHARED
 * work repo never forces teammates to have private-repo access just to `bun install`.
 *
 * What changes vs the package install:
 *   - biome/tsconfig are VENDORED: devkit's base configs are copied into `.devkit/{biome,tsconfig}/`
 *     and the consumer's biome.jsonc / tsconfig.json extend them by RELATIVE path (no package to
 *     resolve). Re-run init to update the vendored copies.
 *   - the hook calls the GLOBAL `guard-*` bins, fail-open (skipped if devkit isn't installed).
 *   - package.json is untouched (no deps, no scripts).
 *   - husky is NOT a dependency: git runs the committed `.husky/pre-commit` via core.hooksPath.
 * (structure-lint is omitted — its eslint flat-config needs the plugin resolvable from the repo,
 * which a no-package setup can't provide; it also doesn't apply to a `generic` stack.)
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { packageDir, writeIfAbsent } from './fs-helpers.mjs';
import { buildStandaloneBlock, buildStandaloneHook, replaceGuardBlock } from './husky-block.mjs';

const firstLine = (e) => (e.stderr || e.message || '').toString().trim().split('\n')[0];

// Which vendored base each stack extends.
const biomeVariant = (stack) =>
  ['electron', 'react-app', 'next'].includes(stack) ? 'react' : 'base';
const tsconfigVariant = (stack) =>
  stack === 'next' ? 'next' : stack === 'node-service' ? 'node' : 'base';

// Copy every file from a devkit config dir into the consumer's `.devkit/<kind>/` (always
// overwrite — these are devkit-owned vendored copies, refreshed on every init).
function vendor(cwd, kind, dryRun) {
  const srcDir = join(packageDir(), kind);
  const destDir = join(cwd, '.devkit', kind);
  if (dryRun) {
    console.log(`  [dry-run] vendor ${kind}/* → .devkit/${kind}/`);
    return;
  }
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    copyFileSync(join(srcDir, f), join(destDir, f));
  }
  console.log(`  ✓ vendored ${kind}/* → .devkit/${kind}/`);
}

// Write a config that extends a vendored base by relative path (biome: array; tsconfig: string).
function writeExtends(cwd, dest, relPath, asArray, force, dryRun) {
  const target = join(cwd, dest);
  const content = `${JSON.stringify({ extends: asArray ? [relPath] : relPath }, null, 2)}\n`;
  if (dryRun) {
    console.log(`  [dry-run] ${existsSync(target) && !force ? 'skip (exists)' : 'write'} ${dest}`);
    return;
  }
  if (existsSync(target) && !force) {
    console.log(
      `  • ${dest} exists — add "extends": ${JSON.stringify(relPath)} yourself (or --force)`,
    );
    return;
  }
  writeFileSync(target, content);
  console.log(`  ✓ wrote ${dest} (extends ${relPath})`);
}

/**
 * Standalone configs: vendor the biome/tsconfig bases + relative-extends configs + guard.config.
 * @param {string} cwd consumer package dir
 * @param {string} stack
 * @param {{biome?:boolean, tsconfig?:boolean, guards?:string[], structure?:boolean}} sel
 */
export function installStandaloneConfigs(cwd, stack, sel, force, dryRun) {
  if (sel.biome) {
    vendor(cwd, 'biome', dryRun);
    writeExtends(
      cwd,
      'biome.jsonc',
      `./.devkit/biome/${biomeVariant(stack)}.jsonc`,
      true,
      force,
      dryRun,
    );
  }
  if (sel.tsconfig) {
    vendor(cwd, 'tsconfig', dryRun);
    writeExtends(
      cwd,
      'tsconfig.json',
      `./.devkit/tsconfig/${tsconfigVariant(stack)}.json`,
      false,
      force,
      dryRun,
    );
  }
  // guard.config.json (data) — same generic template as the package install.
  if (sel.guards?.length || sel.structure) {
    const src = join(packageDir(), 'templates', 'generic', 'guard.config.json');
    const dest = join(cwd, 'guard.config.json');
    if (dryRun) {
      console.log(
        `  [dry-run] ${existsSync(dest) && !force ? 'skip (exists)' : 'write'} guard.config.json`,
      );
    } else {
      const action = writeIfAbsent(dest, readFileSync(src, 'utf8'), { force });
      console.log(
        `  ${action === 'created' ? '✓ created' : action === 'forced' ? '✓ overwrote' : '• already wired'} guard.config.json`,
      );
    }
  }
}

// Set core.hooksPath to .husky (no husky package) only if it isn't already configured — leave an
// existing husky/custom hooksPath alone (our committed .husky/pre-commit is still sourced by it).
function ensureHooksPath(gitRoot, dryRun) {
  let current = '';
  try {
    current = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: gitRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    // unset — fall through to set it.
  }
  if (current) {
    console.log(`  • core.hooksPath already set (${current}) — leaving it`);
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] git config core.hooksPath .husky');
    return;
  }
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: gitRoot });
    console.log('  ✓ git config core.hooksPath .husky (no husky package needed)');
  } catch (e) {
    console.log(`  ! could not set core.hooksPath — set it by hand: ${firstLine(e)}`);
  }
}

/**
 * Standalone hook at the git root (pkgRel cd-scopes a monorepo package). Fail-open global gates;
 * husky-less (core.hooksPath). Fresh → full hook; existing → replace this package's block.
 */
export function installStandaloneHook(gitRoot, pkgRel, sel, dryRun) {
  ensureHooksPath(gitRoot, dryRun);
  const huskyDir = join(gitRoot, '.husky');
  const hookPath = join(huskyDir, 'pre-commit');
  if (!existsSync(hookPath)) {
    if (dryRun) {
      console.log('  [dry-run] write .husky/pre-commit (standalone, fail-open global gates)');
      return;
    }
    mkdirSync(huskyDir, { recursive: true });
    writeFileSync(hookPath, buildStandaloneHook(sel, pkgRel));
    chmodSync(hookPath, 0o755);
    console.log('  ✓ created .husky/pre-commit (standalone, fail-open global gates)');
    return;
  }
  const current = readFileSync(hookPath, 'utf8');
  const merged = replaceGuardBlock(current, buildStandaloneBlock(sel, pkgRel), pkgRel);
  if (merged === current) {
    console.log('  • .husky/pre-commit already wired (standalone block current)');
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] refresh standalone devkit-guards block in .husky/pre-commit');
    return;
  }
  writeFileSync(hookPath, merged);
  console.log('  ✓ refreshed standalone devkit-guards block in .husky/pre-commit');
}
