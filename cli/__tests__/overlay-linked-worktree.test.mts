/**
 * sc-4157: an overlay's hooks must run in every linked worktree, not only the checkout it was
 * installed in. Real git throughout — the defect was git silently finding no hooks directory.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cleanRun from '../commands/clean.mts';
import doctorRun from '../commands/doctor.mts';
import { applyInit } from '../commands/init.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { healAliasCmd, isHealAlias } from '../lib/husky/overlay/heal-alias.mts';
import {
  isOverlayHooksValue,
  overlayCommandCwd,
  overlayHome,
  worktrees,
} from '../lib/husky/overlay/overlay-home.mts';
import { captureOrigHooksPath } from '../lib/overlay.mts';
import { overlayHooksPathRejection } from '../lib/ship/review/setup/overlay-hooks-path.mts';
import { rootRegistry, testExecFileSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();

// No gates selected: the hook's only observable effect is chaining to the team hook's marker.
const SELECTION = applyOverlayConstraints({
  ...defaultSelection(),
  biome: false,
  skills: false,
  agents: false,
  lineGrowth: false,
  guards: [],
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let marker = '';
const commit = (cwd: string, message: string) =>
  testExecFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DK_TEST_MARKER: marker, DEVKIT_NO_TELEMETRY: '1' },
  });
const markerLines = () =>
  existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];

// The team's committed husky hook records which checkout it ran in.
function workRepo() {
  const root = mkTmp('overlay-wt-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }));
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\npwd -P >> "$DK_TEST_MARKER"\n');
  writeFileSync(join(root, 'eslint.config.mjs'), 'export default [];\n');
  git(root, 'config', 'core.hooksPath', '.husky/_');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

const initOverlay = (root: string) =>
  applyInit(root, { stack: 'react-app', selection: SELECTION, overlay: true, devkitRef: 'v0.9.0' });

const addWorktree = (root: string, ...flags: string[]) => {
  const wt = join(mkTmp('overlay-linked-'), 'wt');
  git(root, 'worktree', 'add', '-q', '--detach', ...flags, wt);
  return wt;
};

const ORIGINAL = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  marker = join(mkTmp('overlay-marker-'), 'ran');
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  for (const [key, value] of [
    ['GIT_CONFIG_GLOBAL', ORIGINAL.global],
    ['GIT_CONFIG_SYSTEM', ORIGINAL.system],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('overlay hooks in linked worktrees (sc-4157)', () => {
  it('a commit in a fresh linked worktree runs the overlay chain and links the overlay in', async () => {
    const root = workRepo();
    await initOverlay(root);
    expect(git(root, 'config', '--get', 'core.hooksPath')).toBe(join(root, '.devkit', 'hooks'));
    const wt = addWorktree(root);

    commit(wt, 'from the worktree');

    expect(markerLines()).toEqual([realpathSync(wt)]);
    expect(lstatSync(join(wt, '.devkit')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(wt, 'eslint.config.devkit.mjs')).isSymbolicLink()).toBe(true);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('a --no-checkout worktree is gated too, since linking happens at commit time', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root, '--no-checkout');
    git(wt, 'checkout', '-q', '--detach', 'HEAD');

    commit(wt, 'no-checkout worktree');

    expect(markerLines()).toEqual([realpathSync(wt)]);
  });

  it('a real .devkit holding only ship logs gets the missing entries linked into it', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    mkdirSync(join(wt, '.devkit'));
    writeFileSync(join(wt, '.devkit', 'last-ship-gates-x.log'), 'log\n');

    commit(wt, 'legacy dir');

    expect(lstatSync(join(wt, '.devkit')).isDirectory()).toBe(true);
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, '.devkit', 'last-ship-gates-x.log'), 'utf8')).toBe('log\n');
    expect(markerLines()).toEqual([realpathSync(wt)]);
  });

  it('clean from the home unlinks every worktree before the exclude is pruned', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');
    expect(lstatSync(join(wt, '.devkit')).isSymbolicLink()).toBe(true);

    await cleanRun(['--yes'], root);

    expect(existsSync(join(wt, '.devkit'))).toBe(false);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(root, 'config', '--get', 'core.hooksPath')).toBe('.husky/_');
  });

  it('overlay-owning commands run in the home, never through a worktree’s links', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    commit(wt, 'link it');

    expect(realpathSync(overlayCommandCwd(wt))).toBe(realpathSync(root));
    expect(overlayCommandCwd(root)).toBe(root);
  });

  it('doctor --fix migrates a legacy relative hooksPath and its alias to the absolute path', async () => {
    const root = workRepo();
    await initOverlay(root);
    git(root, 'config', 'core.hooksPath', '.devkit/hooks');
    git(root, 'config', 'alias.ci', '!git config --local core.hooksPath .devkit/hooks; git commit');

    expect(await doctorRun([], root)).toBe(1);
    await doctorRun(['--fix'], root);

    const hooks = realpathSync(join(root, '.devkit', 'hooks'));
    expect(realpathSync(git(root, 'config', '--get', 'core.hooksPath'))).toBe(hooks);
    expect(git(root, 'config', '--get', 'alias.ci')).toContain(hooks);
  });

  it('review accepts the absolute value only when it is this checkout’s own .devkit/hooks', async () => {
    const root = workRepo();
    await initOverlay(root);
    const value = git(root, 'config', '--get', 'core.hooksPath');
    const linked = addWorktree(root);
    commit(linked, 'link it');
    const stale = addWorktree(root);
    mkdirSync(join(stale, '.devkit', 'hooks'), { recursive: true });
    const context = (gitRoot: string) => ({ gitRoot, chain: null, chainPresent: false });

    expect(overlayHooksPathRejection(value, context(root))).toBeNull();
    expect(overlayHooksPathRejection(value, context(linked))).toBeNull();
    expect(overlayHooksPathRejection(value, context(stale))).toContain('expected');
  });

  it('a bare repository’s own entry is never taken as the overlay home', async () => {
    const seed = workRepo();
    const bare = join(mkTmp('overlay-bare-'), 'repo.git');
    git(seed, 'clone', '-q', '--bare', seed, bare);
    const wt = join(mkTmp('overlay-bare-wt-'), 'wt');
    git(bare, 'worktree', 'add', '-q', '--detach', wt);
    git(wt, 'config', 'user.email', 't@t.t');
    git(wt, 'config', 'user.name', 't');
    await initOverlay(wt);

    expect(worktrees(wt)[0].bare).toBe(true);
    expect(realpathSync(overlayHome(wt) ?? '')).toBe(realpathSync(wt));
    expect(realpathSync(git(wt, 'config', '--get', 'core.hooksPath'))).toBe(
      realpathSync(join(wt, '.devkit', 'hooks')),
    );
  });

  it('only this repo’s own worktree .devkit/hooks counts as devkit’s value', async () => {
    const root = workRepo();
    await initOverlay(root);
    const other = workRepo();

    expect(isOverlayHooksValue('.devkit/hooks', root)).toBe(true);
    expect(isOverlayHooksValue(join(root, '.devkit', 'hooks'), root)).toBe(true);
    expect(isOverlayHooksValue('/opt/custom/.devkit/hooks', root)).toBe(false);
    expect(isOverlayHooksValue(join(other, '.devkit', 'hooks'), root)).toBe(false);
    git(other, 'config', 'core.hooksPath', '/opt/custom/.devkit/hooks');
    expect(captureOrigHooksPath(other, other)).toBe('/opt/custom/.devkit/hooks');
  });

  it('the heal alias is recognised only in the exact shape devkit writes', () => {
    const spaced = "/tmp/it's a repo/.devkit/hooks";
    expect(isHealAlias(healAliasCmd(spaced))).toBe(true);
    expect(isHealAlias('!git config --local core.hooksPath .devkit/hooks; git commit')).toBe(true);
    expect(isHealAlias('!echo core.hooksPath /tmp/.devkit/hooks')).toBe(false);
    expect(isHealAlias('!git config --local core.hooksPath /tmp/elsewhere; git commit')).toBe(
      false,
    );
    expect(isHealAlias(`${healAliasCmd('/r/.devkit/hooks')} && rm -rf ~`)).toBe(false);
  });

  it('clean also unlinks a worktree nested inside the home', async () => {
    const root = workRepo();
    await initOverlay(root);
    writeFileSync(join(root, '.git', 'info', 'exclude'), '\n.worktrees/\n', { flag: 'a' });
    const nested = join(root, '.worktrees', 'feature');
    git(root, 'worktree', 'add', '-q', '--detach', nested);
    commit(nested, 'link it');
    expect(lstatSync(join(nested, '.devkit')).isSymbolicLink()).toBe(true);

    await cleanRun(['--yes'], root);

    expect(existsSync(join(nested, '.devkit'))).toBe(false);
  });

  it('a real .devkit holding only a LINKED config is borrowed, so commands run in the home', async () => {
    const root = workRepo();
    await initOverlay(root);
    const wt = addWorktree(root);
    mkdirSync(join(wt, '.devkit'));
    commit(wt, 'merge the overlay in');
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);

    expect(realpathSync(overlayCommandCwd(wt))).toBe(realpathSync(root));
  });
});
