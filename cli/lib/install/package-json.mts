/**
 * Patch a consumer's package.json with devkit's devDeps + scripts for the recorded selection.
 * Never overwrites an existing key — a customized script/dep stays the consumer's own.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Selection } from '../components.mts';
import { readJson } from '../fs-helpers.mts';

// The consumer's package.json — only the maps this patches add/remove entries in.
export interface PackageJson {
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

// Re-stages the husky runner past its own gitignore on every install, so a fresh `git worktree add`
// always finds it (sync-hook-runner). Guarded: a partial/production install must not fail just
// because the gate tool isn't resolvable.
const PREPARE_SCRIPT =
  'husky && (command -v devkit >/dev/null 2>&1 && devkit sync-hook-runner || true)';

// Reason: the branches ARE the per-component devDep/script manifest: each `...(sel.x ? {...} : {})` spread names exactly which deps+scripts a component owns; flattening scatters this single source-of-truth table that remove() mirrors
// fallow-ignore-next-line complexity
export function patchPackageJson(
  cwd: string,
  devkitRef: string,
  repoUrl: string,
  sel: Selection,
  isStructure: boolean,
  dryRun: boolean,
  stack: string,
) {
  const pkgPath = join(cwd, 'package.json');
  const pkg = readJson(pkgPath) as PackageJson | null;
  if (!pkg) {
    console.log('  ! no package.json — skipping devDeps/scripts wiring');
    return;
  }
  // Zero-consumer-dependency model: devkit bundles the gate tools. jscpd is no longer a consumer dep
  // (the clone gate resolves devkit's OWN bundled jscpd), and the config-driven structure gate runs via
  // the `guard-structure` bin (devkit's own eslint + plugin). Only ELECTRON keeps consumer-side
  // eslint/parser/plugin — its preset imports them directly in a consumer eslint.config.mjs + domains.
  const electronPreset = isStructure && stack === 'electron';
  const devDeps = {
    '@norvalbv/devkit': `${repoUrl}#${devkitRef}`,
    ...(sel.biome ? { '@biomejs/biome': '^2.5.0' } : {}),
    ...(sel.husky ? { husky: '^9.1.7' } : {}),
    ...(electronPreset
      ? {
          eslint: '^10.0.0',
          'eslint-plugin-project-structure': '^3.14.3',
          '@typescript-eslint/parser': '^8.0.0',
        }
      : {}),
  };
  const scripts = {
    ...(sel.biome ? { lint: 'biome check .', format: 'biome check --write .' } : {}),
    ...(sel.husky ? { prepare: PREPARE_SCRIPT } : {}),
    ...(sel.guards?.includes('fanout') || sel.guards?.includes('size')
      ? { 'guard:freeze': 'guard-fanout freeze && guard-size freeze' }
      : {}),
    ...(electronPreset ? { 'lint:structure': 'eslint src' } : {}),
  };

  pkg.devDependencies = pkg.devDependencies ?? {};
  pkg.scripts = pkg.scripts ?? {};
  const added: string[] = [];
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
