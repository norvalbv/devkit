/**
 * Standalone (no-package) install: `devkit init --standalone` must add NOTHING to package.json,
 * vendor the biome/tsconfig bases (relative extends), and write a fail-open hook that calls the
 * GLOBAL guard-* bins — the "like fallow init" model for shared work repos.
 */
import { execFileSync } from 'node:child_process';
// Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
// fallow-ignore-next-line code-duplication
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mjs';
import { defaultSelection } from '../lib/components.mjs';
import { rootRegistry } from './_helpers.mjs';

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
    expect(hook).toContain('__dk_gate');
    expect(hook).toContain('guard-fanout gate');
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
    expect(JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8')).standalone).toBe(
      true,
    );
  });
});
