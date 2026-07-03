/**
 * Monorepo support: `devkit init` run INSIDE a package subdir must put configs/baselines in
 * the package, but the husky hook + repo-wide skills at the GIT ROOT, with the gates scoped
 * `cd <pkgRel>` in a package-scoped marker block (so multiple packages coexist).
 */
// Reason: test scenario setup is intentionally explicit + self-contained per install mode (package/standalone/overlay/monorepo); shared bits already live in __tests__/_helpers.mjs
// fallow-ignore-next-line code-duplication
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mjs';
import { defaultSelection } from '../lib/components.mjs';
import { rootRegistry } from './_helpers.mjs';

const { mkTmp, cleanup } = rootRegistry();

// A fake monorepo: a `.git` marker at the root (detectGitRoot only checks existence) + a
// package under services/<name>.
function monorepo(pkgName = 'webapp') {
  const root = mkTmp('mono-');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mono' }, null, 2));
  const pkg = join(root, 'services', pkgName);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: pkgName, dependencies: { react: '^18' } }, null, 2),
  );
  return { root, pkg, rel: `services/${pkgName}` };
}

// A react-app package selection (no biome/tsconfig — the package owns its own).
const PKG_SELECTION = {
  ...defaultSelection(),
  biome: false,
  tsconfig: false,
  structure: true,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('monorepo: init in a package subdir', () => {
  it('configs land in the package; the hook lands at the git root, scoped + cd-wrapped', async () => {
    const { root, pkg } = monorepo();
    await applyInit(pkg, { stack: 'react-app', selection: PKG_SELECTION, devkitRef: 'v0.5.0' });

    // configs/baselines in the PACKAGE
    expect(existsSync(join(pkg, 'guard.config.json'))).toBe(true);
    expect(existsSync(join(pkg, 'eslint.config.mjs'))).toBe(true);
    expect(existsSync(join(pkg, '.devkit', 'config.json'))).toBe(true);
    // NO hook in the package
    expect(existsSync(join(pkg, '.husky', 'pre-commit'))).toBe(false);

    // hook at the GIT ROOT, package-scoped + cd-wrapped + structure-lint enabled
    const hook = readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');
    expect(hook).toContain('# >>> devkit-guards: services/webapp >>>');
    expect(hook).toContain('cd "services/webapp"');
    expect(hook).toContain(') || exit 1');
    expect(hook).toContain('bunx guard-structure || rc=$?'); // config-driven stack → devkit's guard-structure bin (no consumer eslint dep), trichotomy-accumulating into the det-verdict block

    // skills are repo-wide → at the git root, not the package
    expect(existsSync(join(root, '.devkit', 'skills-manifest.json'))).toBe(true);
    expect(existsSync(join(pkg, '.devkit', 'skills-manifest.json'))).toBe(false);

    // config records pkgRel so doctor finds the git-root hook
    const cfg = JSON.parse(readFileSync(join(pkg, '.devkit', 'config.json'), 'utf8'));
    expect(cfg.pkgRel).toBe('services/webapp');
  });

  it('the generated hook is valid POSIX sh (cd-subshell + exit propagation parse)', async () => {
    const { root, pkg } = monorepo();
    await applyInit(pkg, { stack: 'react-app', selection: PKG_SELECTION, devkitRef: 'v0.5.0' });
    // `sh -n` parses without executing — fails non-zero on a syntax error in the cd-wrap.
    expect(() =>
      execFileSync('sh', ['-n', join(root, '.husky', 'pre-commit')], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('a second package adds its own block without clobbering the first', async () => {
    const { root, pkg } = monorepo('webapp');
    const second = monorepoSecond(root, 'admin');
    await applyInit(pkg, { stack: 'react-app', selection: PKG_SELECTION, devkitRef: 'v0.5.0' });
    await applyInit(second, { stack: 'react-app', selection: PKG_SELECTION, devkitRef: 'v0.5.0' });

    const hook = readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');
    expect(hook).toContain('# >>> devkit-guards: services/webapp >>>');
    expect(hook).toContain('# >>> devkit-guards: services/admin >>>');
    expect(hook).toContain('cd "services/webapp"');
    expect(hook).toContain('cd "services/admin"');
    // both package blocks run BEFORE the final exit 0 (not appended as dead code after it)
    expect(hook.indexOf('services/admin')).toBeLessThan(hook.lastIndexOf('exit 0'));
    // still valid shell with two blocks
    expect(() =>
      execFileSync('sh', ['-n', join(root, '.husky', 'pre-commit')], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});

// Add a sibling package under the SAME monorepo root.
function monorepoSecond(root, pkgName) {
  const pkg = join(root, 'services', pkgName);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: pkgName, dependencies: { react: '^18' } }, null, 2),
  );
  return pkg;
}
