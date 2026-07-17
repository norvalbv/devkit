/**
 * Standalone (no-package) install: `devkit init --standalone` must add NOTHING to package.json,
 * vendor the biome/tsconfig bases (relative extends), and write a fail-open hook that calls the
 * GLOBAL guard-* bins — the "like fallow init" model for shared work repos.
 */
import { execFileSync } from 'node:child_process';
// Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
// fallow-ignore-next-line code-duplication
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import doctorRun from '../commands/doctor.mts';
import { applyInit } from '../commands/init.mts';
import { defaultSelection } from '../lib/components.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
function repo(pkg = { name: 'shared', devDependencies: { react: '^18' } }) {
  const root = mkTmp('standalone-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  // Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
  // fallow-ignore-next-line code-duplication
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  return root;
}
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('standalone (no-package) install', () => {
  it('leaves package.json untouched; vendors configs; fail-open hook; records standalone', async () => {
    const root = repo();
    const pkgBefore = readFileSync(join(root, 'package.json'), 'utf8');
    await applyInit(root, {
      stack: 'react-app',
      selection: { ...defaultSelection(), skills: false }, // skills off keeps the test light
      standalone: true,
      devkitRef: 'v0.6.0',
    });

    // package.json is byte-identical — NO @norvalbv/devkit dep, no scripts
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkgBefore);

    // biome/tsconfig vendored + extended by RELATIVE path
    expect(existsSync(join(root, '.devkit/biome/base.jsonc'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'biome.jsonc'), 'utf8')).extends).toEqual([
      './.devkit/biome/react.jsonc',
    ]);
    expect(JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')).extends).toBe(
      './.devkit/tsconfig/base.json',
    );
    expect(existsSync(join(root, 'guard.config.json'))).toBe(true);

    // structure-lint omitted in standalone (no eslint.config.mjs)
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(false);

    // hook: fail-open GLOBAL gates (no bunx / node_modules), valid POSIX sh
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).toContain('command -v guard-deterministic'); // fail-open global orchestrator
    expect(hook).toContain('--structure "guard-structure gate"'); // config-driven structure via the bin
    expect(hook).not.toContain('bunx guard'); // gates call global bins, not bunx/node_modules
    expect(() =>
      execFileSync('sh', ['-n', join(root, '.husky/pre-commit')], { stdio: 'pipe' }),
    ).not.toThrow();

    // git runs the committed hook without husky — core.hooksPath set
    const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    expect(hooksPath).toBe('.husky');

    // config records standalone so doctor skips the pin / package checks
    const cfg = JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));
    expect(cfg.standalone).toBe(true);
    expect(cfg.components.agentTargets).toEqual(['claude', 'cursor', 'codex']);
    expect(existsSync(join(root, '.codex/agents/feature-critique.md'))).toBe(true);
  });

  it('doctor --fix on a standalone repo: no phantom package dep, config deltas preserved', async () => {
    const root = repo();
    await applyInit(root, {
      stack: 'react-app',
      selection: { ...defaultSelection(), skills: false },
      standalone: true,
      devkitRef: 'v0.6.0',
    });

    // Consumer-tuned configs that DRIFTED their extends to the package pointer (the pre-fix bug
    // force-rewrote these from the package template, wiping the deltas + flipping to package mode).
    writeFileSync(
      join(root, 'biome.jsonc'),
      '{\n  // repo-local tweak\n  "extends": ["@norvalbv/devkit/biome/base"],\n  "overrides": [{ "includes": ["**/*.test.ts"] }]\n}\n',
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      '{\n  "extends": "@norvalbv/devkit/tsconfig/base",\n  "compilerOptions": { "paths": { "@/*": ["src/*"] } }\n}\n',
    );
    // Remove the hook so --fix re-runs `init` (the path that wrote the git+ssh dep pre-fix).
    rmSync(join(root, '.husky/pre-commit'));

    const pkgBefore = readFileSync(join(root, 'package.json'), 'utf8');
    await doctorRun(['--fix'], root);

    // Fix 1: re-init stayed standalone — package.json is byte-identical, NO @norvalbv/devkit dep.
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkgBefore);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).not.toContain('@norvalbv/devkit');

    // Fix 2: only the extends pointer repaired (mode-correct) — comment + deltas intact.
    const biome = readFileSync(join(root, 'biome.jsonc'), 'utf8');
    expect(biome).toContain('"./.devkit/biome/react.jsonc"');
    expect(biome).not.toContain('@norvalbv/devkit/biome/base');
    expect(biome).toContain('// repo-local tweak');
    expect(biome).toContain('overrides');

    const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.extends).toBe('./.devkit/tsconfig/base.json');
    expect(tsconfig.compilerOptions.paths['@/*']).toEqual(['src/*']);

    // Hook recreated by the standalone re-init.
    expect(existsSync(join(root, '.husky/pre-commit'))).toBe(true);
  });

  it('config-driven structure: zero deps, guard-structure gate wired, stack guard.config vendored, doctor clean', async () => {
    const root = repo({ name: 'shared', peerDependencies: { react: '^18' }, exports: {} });
    const pkgBefore = readFileSync(join(root, 'package.json'), 'utf8');
    await applyInit(root, {
      stack: 'component-lib',
      selection: { ...defaultSelection(), skills: false, agents: false },
      standalone: true,
      devkitRef: 'v0.6.0',
    });

    // Still ZERO consumer deps (the whole point).
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkgBefore);

    // Structure-lint runs via the global guard-structure bin (devkit's own eslint/plugin), joined to
    // the deterministic orchestrator with --structure — fail-open (the orchestrator is command -v-guarded).
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).toContain('--structure "guard-structure gate"');

    // The STACK guard.config (with the `structure` grammar) is vendored, not the generic one.
    const structure = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8')).structure;
    expect((structure?.trees ?? []).map((t) => t.root)).toContain('src');

    // component-lib standalone extends the REACT biome base (S4 parity) — not a false DRIFT.
    expect(JSON.parse(readFileSync(join(root, 'biome.jsonc'), 'utf8')).extends).toEqual([
      './.devkit/biome/react.jsonc',
    ]);

    // doctor is clean (structure-line present, biome react, no pin check).
    const r = await doctorRun([], root);
    expect(r).toBe(0);
  });
});
