/** Overlay init, upgrade and doctor --fix run the package-mode steps; only the git-exclude lines
 * and where core.hooksPath points differ. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import doctorRun from '../commands/doctor.mts';
import { applyInit } from '../commands/init.mts';
import upgrade from '../commands/upgrade.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { packageDir } from '../lib/fs-helpers.mts';
import { rootRegistry, testExecFileSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
const AGENT = join('.claude', 'agents', 'feature-critique.md');
const SELECTION = applyOverlayConstraints(defaultSelection(), 'react-app');
const OVERLAY_FORCED = { tsconfig: false, searchSteering: false, husky: true };
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  // An unreachable remote: upgrade reconciles against the running devkit, never reaching the network.
  process.env.DEVKIT_REPO = join(mkTmp('no-remote-'), 'missing.git');
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  process.env = { ...ORIGINAL_ENV };
});

/** A react app with its code under app/src (not the template's src) and a committed husky hook. */
function reactRepo() {
  const root = mkTmp('parity-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(
    join(root, 'package.json'),
    '{ "name": "app", "dependencies": { "react": "^18" } }',
  );
  mkdirSync(join(root, 'app', 'src'), { recursive: true });
  writeFileSync(join(root, 'app', 'src', 'main.ts'), 'export const main = 1;\n');
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\necho team-hook\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
const components = (root: string) => JSON.parse(read(root, '.devkit/config.json')).components;
const manifestFiles = (root: string, kind: string) =>
  JSON.parse(read(root, `.devkit/${kind}-manifest.json`)).files;
const status = (root: string) =>
  execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
const logged = () => vi.mocked(console.log).mock.calls.flat().join('\n');

const install = (root: string, overlay: boolean, extra = {}) =>
  applyInit(root, {
    stack: 'react-app',
    selection: SELECTION,
    scanRoots: ['app/src'],
    overlay,
    devkitRef: 'v0.9.0',
    ...extra,
  });

describe('overlay install parity with package mode', () => {
  it('records the same selection, scan roots, guard.config.json and asset set', async () => {
    const pkg = reactRepo();
    const overlay = reactRepo();
    // Each mode resolves the same unconstrained selection; only the overlay invariants differ.
    await install(pkg, false, { selection: defaultSelection() });
    await install(overlay, true);

    expect(components(overlay)).toEqual({ ...components(pkg), ...OVERLAY_FORCED });
    expect(JSON.parse(read(overlay, 'guard.config.json')).scanRoots).toEqual(['app/src']);
    expect(read(overlay, 'guard.config.json')).toBe(read(pkg, 'guard.config.json'));
    // The react-app template (it declares the structure grammar), not the generic one.
    expect(JSON.parse(read(overlay, 'guard.config.json')).structure.trees.length).toBeGreaterThan(
      0,
    );
    for (const kind of ['skills', 'agents', 'agent-hooks'])
      expect(manifestFiles(overlay, kind)).toEqual(manifestFiles(pkg, kind));
    // What differs: overlay hides everything from git and owns core.hooksPath.
    expect(status(overlay)).toBe('');
    const hooksPath = (root: string) =>
      execFileSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim();
    expect(hooksPath(overlay)).toBe(join(overlay, '.devkit', 'hooks'));
  });

  it('leaves a tracked guard.config.json alone and says --scan-root was not applied', async () => {
    const root = reactRepo();
    writeFileSync(join(root, 'guard.config.json'), '{ "scanRoots": ["src"] }\n');
    testExecFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    testExecFileSync('git', ['commit', '-qm', 'team config'], { cwd: root });
    await install(root, true);

    expect(JSON.parse(read(root, 'guard.config.json')).scanRoots).toEqual(['src']);
    expect(logged()).toContain('--scan-root not applied: guard.config.json is tracked');
  });
});

describe('overlay asset collisions resolve as in package mode', () => {
  it('preserves a consumer-authored asset with a notice; upgrade --force adopts it', async () => {
    const root = reactRepo();
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, AGENT), '# my own critique agent\n');
    await install(root, true);

    expect(read(root, AGENT)).toBe('# my own critique agent\n');
    expect(logged()).toContain('! preserving 1 non-devkit asset(s)');

    await upgrade(['--force'], root);

    expect(read(root, AGENT)).toBe(
      readFileSync(join(packageDir(), 'agents', 'feature-critique.md'), 'utf8'),
    );
    expect(status(root)).toBe(''); // the adopted file is devkit's now, so it is git-excluded
  });
});

describe('overlay doctor gates the synced agent half', () => {
  it('exits 1 on a missing synced agent, and --fix restores it', async () => {
    const root = reactRepo();
    await install(root, true);
    expect(await doctorRun([], root)).toBe(0);
    rmSync(join(root, AGENT));

    expect(await doctorRun([], root)).toBe(1);
    expect(logged()).toContain('⚠ agents: consumer copy drifted (1) — run `devkit doctor --fix`');
    expect(await doctorRun(['--fix'], root)).toBe(0);
    expect(existsSync(join(root, AGENT))).toBe(true);
    expect(status(root)).toBe('');
  });

  it('syncs the agent half from what was wired, so doctor agrees with the install', async () => {
    const root = reactRepo();
    writeFileSync(join(root, 'guard.config.json'), '{ "scanRoots": ["app/src"] }\n');
    testExecFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    testExecFileSync('git', ['commit', '-qm', 'team config'], { cwd: root });
    // Structure is asked for but cannot run (the tracked config has no grammar), and no guard is on.
    await install(root, true, { selection: { ...SELECTION, guards: [] } });

    expect(components(root).structure).toBe(false);
    expect(existsSync(join(root, '.claude', 'skills', 'commit-gates'))).toBe(false);
    expect(await doctorRun([], root)).toBe(0);
  });

  it('checks the agent half at the overlay home, so a linked worktree is healthy too', async () => {
    const root = reactRepo();
    await install(root, true);
    const wt = join(mkTmp('parity-wt-'), 'wt');
    testExecFileSync('git', ['worktree', 'add', '-q', wt], { cwd: root });
    expect(await doctorRun(['--fix'], root)).toBe(0); // projects the overlay into the worktree

    expect(await doctorRun([], wt)).toBe(0);
  });
});
