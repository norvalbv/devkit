/**
 * `devkit clean` — fully UNINSTALL devkit from a repo. Reverses init for the recorded mode:
 *   - overlay  → restore core.hooksPath, remove the local hooks + package devkit files, prune
 *                the devkit lines from .git/info/exclude (the repo goes back to untouched).
 *   - package/standalone → remove devkit-created configs, the husky devkit-guards block, skills,
 *                baselines, .devkit, and the @norvalbv/devkit dep + devkit scripts.
 *
 * Safe: only touches what devkit created (biome/tsconfig are removed ONLY if they still extend
 * devkit). Confirms first unless --yes; --dry-run prints every action and writes nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, isCancel } from '@clack/prompts';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { readJson } from '../lib/fs-helpers.mjs';
import { removeGuardBlock } from '../lib/husky-block.mjs';
import { removeHookRegistrations, removeHookScripts } from '../lib/install-hooks.mjs';

function rm(path, label, dryRun) {
  if (!existsSync(path)) return;
  console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${label}`);
  if (!dryRun) rmSync(path, { recursive: true, force: true });
}

// A biome/tsconfig is devkit-created only if it still extends devkit (the package subpath, the
// vendored .devkit/ base, or an overlay sibling) — never remove a config the user owns.
function extendsDevkit(path) {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf8');
  return (
    raw.includes('@norvalbv/devkit') ||
    raw.includes('.devkit/biome') ||
    raw.includes('.devkit/tsconfig') ||
    raw.includes('biome.devkit') ||
    raw.includes('eslint.config.devkit')
  );
}

// Drop devkit's lines (+ its header) from .git/info/exclude, leaving the user's own ignores.
const DEVKIT_EXCLUDE_LINE =
  /^(# devkit overlay|\.devkit\/|.*\/\.devkit\/|.*guard\.config\.json|.*biome\.devkit\.jsonc|.*eslint\.config\.devkit\.mjs|.*eslint\/baselines\/)/;
const BLANK_RUN_RE = /\n{3,}/g;
const LEADING_BLANKS_RE = /^\n+/;
function pruneGitExclude(gitRoot, dryRun) {
  const file = join(gitRoot, '.git', 'info', 'exclude');
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((l) => !DEVKIT_EXCLUDE_LINE.test(l));
  if (kept.length === lines.length) return;
  if (dryRun) {
    console.log('  [dry-run] prune devkit lines from .git/info/exclude');
    return;
  }
  writeFileSync(file, kept.join('\n').replace(BLANK_RUN_RE, '\n\n').replace(LEADING_BLANKS_RE, ''));
  console.log('  ✓ pruned devkit lines from .git/info/exclude');
}

function restoreHooksPath(gitRoot, orig, dryRun) {
  // A poisoned origHooksPath (devkit's own dir — from a pre-0.8.1 re-overlay) can't be restored
  // to itself (clean just deleted it). Fall back to husky's dir if present, else unset.
  let target = orig;
  if (target === '.devkit/hooks') {
    target = existsSync(join(gitRoot, '.husky', '_')) ? '.husky/_' : '';
  }
  if (dryRun) {
    console.log(`  [dry-run] restore core.hooksPath → ${target || '(unset)'}`);
    return;
  }
  try {
    if (target) execFileSync('git', ['config', 'core.hooksPath', target], { cwd: gitRoot });
    else execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: gitRoot });
    console.log(`  ✓ restored core.hooksPath → ${target || '(unset)'}`);
  } catch (e) {
    console.log(`  ! could not restore core.hooksPath: ${(e.message || '').split('\n')[0]}`);
  }
}

function cleanOverlay(cwd, cfg, dryRun) {
  const { gitRoot } = detectGitRoot(cwd);
  console.log('cleaning OVERLAY — restoring the repo to untouched:');
  restoreHooksPath(gitRoot, cfg.origHooksPath ?? '', dryRun);
  rm(join(gitRoot, '.devkit'), '.devkit/ (git-root hooks)', dryRun);
  rm(join(cwd, '.devkit'), `${cwd === gitRoot ? '' : 'package '}.devkit/`, dryRun);
  rm(join(cwd, 'guard.config.json'), 'guard.config.json', dryRun);
  rm(join(cwd, 'biome.devkit.jsonc'), 'biome.devkit.jsonc', dryRun);
  rm(join(cwd, 'eslint.config.devkit.mjs'), 'eslint.config.devkit.mjs', dryRun);
  rm(join(cwd, 'eslint', 'baselines'), 'eslint/baselines/', dryRun);
  pruneGitExclude(gitRoot, dryRun);
}

// Remove the @norvalbv/devkit dep + devkit-only scripts from package.json (leave public deps the
// user may have had — biome/husky/eslint — untouched).
function depesc(cwd, dryRun) {
  const pkgPath = join(cwd, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) return;
  let changed = false;
  for (const k of ['dependencies', 'devDependencies']) {
    if (pkg[k]?.['@norvalbv/devkit']) {
      delete pkg[k]['@norvalbv/devkit'];
      changed = true;
    }
  }
  for (const s of ['guard:freeze', 'lint:structure']) {
    if (pkg.scripts?.[s]) {
      delete pkg.scripts[s];
      changed = true;
    }
  }
  if (!changed) return;
  console.log(
    `  ${dryRun ? '[dry-run] remove' : '✓ removed'} @norvalbv/devkit dep + devkit scripts`,
  );
  if (!dryRun) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function cleanPackage(cwd, cfg, dryRun) {
  const { gitRoot } = detectGitRoot(cwd);
  console.log(`cleaning ${cfg.standalone ? 'STANDALONE' : 'PACKAGE'} devkit install:`);
  // husky devkit-guards block (package-scoped marker for a monorepo).
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  if (existsSync(hookPath)) {
    const { content, removed } = removeGuardBlock(readFileSync(hookPath, 'utf8'), cfg.pkgRel ?? '');
    if (removed) {
      console.log(
        `  ${dryRun ? '[dry-run] remove' : '✓ removed'} devkit-guards block from .husky/pre-commit`,
      );
      if (!dryRun) writeFileSync(hookPath, content);
    }
  }
  // skills (manifest at the git root).
  rm(join(gitRoot, '.devkit', 'skills-manifest.json'), 'skills-manifest.json', dryRun);
  // agents (manifest at the git root) + agent-hook scripts + the hook registrations they wrote.
  rm(join(gitRoot, '.devkit', 'agents-manifest.json'), 'agents-manifest.json', dryRun);
  removeHookScripts(gitRoot, { dryRun });
  removeHookRegistrations(gitRoot, { dryRun });
  // devkit-created configs/data in the package.
  for (const f of ['biome.jsonc', 'tsconfig.json']) {
    if (extendsDevkit(join(cwd, f))) rm(join(cwd, f), f, dryRun);
  }
  rm(join(cwd, 'guard.config.json'), 'guard.config.json', dryRun);
  rm(join(cwd, 'eslint.config.mjs'), 'eslint.config.mjs', dryRun);
  rm(join(cwd, 'eslint'), 'eslint/ (domains + baselines)', dryRun);
  rm(join(cwd, '.co-occurrence-allowlist.json'), '.co-occurrence-allowlist.json', dryRun);
  rm(join(cwd, '.devkit'), '.devkit/', dryRun);
  depesc(cwd, dryRun);
  console.log(
    '  (left your own biome/husky/eslint deps + skills files in place — remove by hand if wanted)',
  );
}

export default async function run(args, cwd) {
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const cfg = readJson(join(cwd, '.devkit', 'config.json'));
  if (!cfg) {
    // Orphaned overlay: the config is gone but core.hooksPath still points at our (deleted) dir.
    const { gitRoot } = detectGitRoot(cwd);
    let hp = '';
    try {
      hp = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: gitRoot,
        encoding: 'utf8',
      }).trim();
    } catch {
      // unset
    }
    if (hp === '.devkit/hooks') {
      console.log(
        'devkit clean: orphaned overlay (core.hooksPath → .devkit/hooks, no config) — recovering:\n',
      );
      restoreHooksPath(gitRoot, '.devkit/hooks', dryRun); // guard maps it to .husky/_ or unset
      rm(join(gitRoot, '.devkit'), '.devkit/', dryRun);
      pruneGitExclude(gitRoot, dryRun);
      console.log(`\n${dryRun ? 'Dry-run complete.' : 'Recovered.'}`);
      return 0;
    }
    console.log('devkit clean: nothing to clean — no .devkit/config.json in this repo.');
    return 0;
  }
  const mode = cfg.overlay ? 'overlay' : cfg.standalone ? 'standalone' : 'package';
  if (!yes && !dryRun && process.stdout.isTTY) {
    const go = await confirm({
      message: `Remove ALL devkit (${mode}) from this repo?`,
      initialValue: true,
    });
    if (isCancel(go) || !go) {
      console.log('Aborted — nothing removed.');
      return 0;
    }
  }
  console.log('');
  if (cfg.overlay) cleanOverlay(cwd, cfg, dryRun);
  else cleanPackage(cwd, cfg, dryRun);
  console.log(`\n${dryRun ? 'Dry-run complete (nothing removed).' : 'devkit clean complete.'}`);
  return 0;
}
