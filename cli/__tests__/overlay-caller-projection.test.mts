/**
 * `devkit review` and `devkit ship` started from a linked worktree of an overlay install project the
 * home's overlay into that caller first, through the same projector a commit there runs.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { CLI, devkitHome, rootRegistry, testSpawnSync } from './_helpers.mts';
import { addOverlay, scriptPath, seedShipRepo } from './_ship-branch-fixture.mts';

const overlayRoot = fileURLToPath(
  new URL('../lib/husky/overlay/overlay-root.mts', import.meta.url),
);

const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const SELECTION = applyOverlayConstraints({
  ...defaultSelection(),
  biome: false,
  skills: false,
  agents: false,
  lineGrowth: false,
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function overlayHome() {
  const root = mkTmp('caller-projection-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'work' }));
  writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

describe('devkit review from a fresh linked worktree of an overlay install', () => {
  it('projects the overlay into the target, then every gate input reaches the private copy', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = overlayHome();
    // Before init: the hook renders its projection check from guard.config.json's paths.
    writeFileSync(join(root, 'guard.config.json'), '{"indexPath": ".search-code/index.db"}\n');
    await applyInit(root, {
      stack: 'react-app',
      selection: SELECTION,
      overlay: true,
      devkitRef: 'v0.9.0',
      review: { enabled: true, guards: [] },
    });
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'docs', 'decisions', 'a.md'), '# a\n');
    mkdirSync(join(root, '.search-code'));
    writeFileSync(join(root, '.search-code', 'index.db'), 'db');
    writeFileSync(
      join(root, '.git', 'info', 'exclude'),
      '\n/docs/decisions\n.search-code\n.devkit/review-runs\n',
      { flag: 'a' },
    );
    const base = git(root, 'rev-parse', 'HEAD');
    const wt = join(mkTmp('caller-projection-linked-'), 'wt');
    git(root, 'worktree', 'add', '-q', '--detach', wt);
    writeFileSync(join(wt, 'app.txt'), 'changed\n');
    const home = devkitHome(realpathSync(mkTmp('caller-projection-home-')));

    const r = testSpawnSync(process.execPath, [CLI, 'review', '--base', base], {
      cwd: wt,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${join(home, '.bun', 'bin')}:${process.env.PATH}`,
        DEVKIT_NO_TELEMETRY: '1',
        DEVKIT_PREFLIGHT_TIMEOUT: '600',
        SHIP_COMMIT_TIMEOUT: '120',
      },
    });

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain('copied into the isolated review worktree');
    for (const rel of ['guard.config.json', 'docs/decisions', '.search-code/index.db'])
      expect(r.stderr).toContain(`- ${rel}`);
    expect(lstatSync(join(wt, '.devkit', 'config.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, 'gate-calls'), 'utf8')).toContain('guard-deterministic');
    // An already-projected target is left exactly as it is.
    const again = testSpawnSync(process.execPath, [overlayRoot, wt, '--project'], {
      encoding: 'utf8',
    });
    expect(again.status, again.stderr).toBe(0);
    expect(`${again.stdout}${again.stderr}`).toBe('');
  });
});

describe('devkit ship from an unprojected linked worktree of an overlay install', () => {
  it("projects the caller first, so the gates read its branch-local copies, never the home's", () => {
    const { dir, env, git } = seedShipRepo();
    addOverlay(
      dir,
      `echo 'devkit-gates: chain start' >&2
echo "BASELINE=$(cat .devkit/baselines/size-lines.json)" >&2
echo "ESLINT=$(readlink eslint.config.devkit.mjs)" >&2`,
    );
    writeFileSync(join(dir, 'eslint.config.devkit.mjs'), 'export default [];\n');
    mkdirSync(join(dir, '.devkit', 'baselines'));
    writeFileSync(join(dir, '.devkit', 'baselines', 'size-lines.json'), 'home\n');
    writeFileSync(
      join(dir, '.git', 'info', 'exclude'),
      '.devkit/\n.devkit\neslint.config.devkit.mjs\n',
    );
    git(['config', 'core.hooksPath', join(dir, '.devkit', 'hooks')], { stdio: 'ignore' });
    // The branch lowered a ratchet ceiling; nothing else of the overlay is projected yet.
    const linked = join(realpathSync(mkTmp('caller-projection-ship-')), 'wt');
    git(['worktree', 'add', '-q', '-b', 'task', linked], { stdio: 'ignore' });
    mkdirSync(join(linked, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(linked, '.devkit', 'baselines', 'size-lines.json'), 'branch\n');
    writeFileSync(join(linked, 'note.txt'), 'hello\n');

    const r = testSpawnSync('/bin/bash', [scriptPath, 'feat/caller', 't', '--', 'note.txt'], {
      cwd: linked,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('BASELINE=branch');
    expect(r.stderr).toContain(`ESLINT=${join(linked, 'eslint.config.devkit.mjs')}`);
    expect(lstatSync(join(linked, 'eslint.config.devkit.mjs')).isFile()).toBe(true);
    expect(readFileSync(join(dir, '.devkit', 'baselines', 'size-lines.json'), 'utf8')).toBe(
      'home\n',
    );
  });
});
