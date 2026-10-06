/**
 * `devkit review` and `devkit ship` started from a linked worktree of an overlay install project the
 * home's overlay into that caller first, through the same projector a commit there runs.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mts';
import { applyOverlayConstraints, defaultSelection } from '../lib/components.mts';
import { relIntentPath, writeIntent } from '../lib/ship/ship-intent.mts';
import { CLI, devkitHome, rootRegistry, testSpawnSync } from './_helpers.mts';
import { addOverlay, reshipScript, scriptPath, seedShipRepo } from './_ship-branch-fixture.mts';

const overlayRoot = fileURLToPath(
  new URL('../lib/husky/overlay/overlay-root.mts', import.meta.url),
);

const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const SELECTION = applyOverlayConstraints(
  {
    ...defaultSelection(),
    biome: false,
    skills: false,
    agents: false,
    lineGrowth: false,
  },
  'react-app',
);

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

/** An overlay home plus a linked worktree still on the pre-projection layout: `.devkit` is a link. */
function legacyLinkedWorktree(reship: boolean) {
  const { dir, env, git } = seedShipRepo();
  if (reship) {
    // reship reads owner/repo from the raw URL, then fetches the PR branch through insteadOf.
    const bare = mkTmp('legacy-linked-bare-');
    git(['init', '-q', '--bare', bare], { stdio: 'ignore' });
    git(['config', `url.${bare}.insteadOf`, 'git@github.com:acme/app.git'], { stdio: 'ignore' });
    git(['push', '-q', 'origin', 'work:pr-open'], { stdio: 'ignore' });
  }
  addOverlay(dir, 'exit 0');
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.devkit/\n.devkit\n');
  git(['config', 'core.hooksPath', join(dir, '.devkit', 'hooks')], { stdio: 'ignore' });
  const linked = join(realpathSync(mkTmp('legacy-linked-')), 'wt');
  git(['worktree', 'add', '-q', '-b', 'task', linked], { stdio: 'ignore' });
  symlinkSync(join(dir, '.devkit'), join(linked, '.devkit'));
  writeFileSync(join(linked, 'note.txt'), 'hello\n');
  writeFileSync(join(linked, 'body.md'), 'pr body\n');
  return { dir, env, linked };
}

/** Ignored only as a directory, so the home's copy can never be linked: a gap no repair closes. */
function openProjectionGap(dir: string) {
  writeFileSync(join(dir, 'guard.config.json'), '{}\n');
  mkdirSync(join(dir, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'decisions', 'a'), 'a\n');
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'guard.config.json\ndocs/decisions/\n', {
    flag: 'a',
  });
}

/** A recorded invocation titled "home", written straight into the home checkout's `.devkit`. */
function plantHomeRecord(dir: string, script: string, branch: string) {
  const mode = script === reshipScript ? 'reship' : 'ship';
  const home = { root: dir, branch, mode, title: 'home', links: [], body: Buffer.from('home\n') };
  const flags = { noQavisPublish: false, updatePrBody: false, draft: false, resumed: false };
  expect(writeIntent({ ...home, ...flags, mergePaths: false }, ['note.txt'])).toBe(0);
}

describe('devkit ship from a linked worktree whose .devkit is a legacy link into the home', () => {
  it.each([
    ['ship', scriptPath, ['feat/legacy', 't', '--body-file', 'body.md', '--', 'note.txt']],
    [
      'ship --pr',
      reshipScript,
      ['pr-open', 't', '--pr', '--body-file', 'body.md', '--', 'note.txt'],
    ],
  ])('%s replaces the link before recording the invocation', (_name, script, args) => {
    const { dir, env, linked } = legacyLinkedWorktree(script === reshipScript);

    const r = testSpawnSync('/bin/bash', [script, ...args], {
      cwd: linked,
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(linked, '.devkit')).isDirectory()).toBe(true);
    expect(r.stderr).not.toMatch(/ship-intent:|invocation not recorded/);
    expect(readdirSync(join(dir, '.devkit')).filter((f) => f.startsWith('ship-intent-'))).toEqual(
      [],
    );
  });

  it.each([
    ['ship', scriptPath, 'feat/legacy', false],
    ['ship --pr', reshipScript, 'pr-open', false],
    ['ship --pr with a projection gap', reshipScript, 'pr-open', true],
  ])(
    '%s --resume replaces the link before reading, so a home-only record is not replayed',
    (_name, script, branch, gap) => {
      const { dir, env, linked } = legacyLinkedWorktree(script === reshipScript);
      if (gap) openProjectionGap(dir);
      plantHomeRecord(dir, script, branch);

      const r = testSpawnSync('/bin/bash', [script, '--resume', branch], {
        cwd: linked,
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      });

      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain(`no recorded ship invocation for '${branch}'`);
      expect(lstatSync(join(linked, '.devkit')).isDirectory()).toBe(true);
      expect(existsSync(join(dir, relIntentPath(branch)))).toBe(true);
    },
  );

  it.each([
    ['ship', scriptPath, 'feat/legacy'],
    ['ship --pr', reshipScript, 'pr-open'],
  ])('%s --resume in the home still replays its own record', (_name, script, branch) => {
    const { dir, env } = legacyLinkedWorktree(script === reshipScript);
    plantHomeRecord(dir, script, branch);

    const r = testSpawnSync('/bin/bash', [script, '--resume', branch], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.stderr).toContain(`Resuming recorded invocation for ${branch}`);
    expect(r.stderr).toContain('"home"');
  });

  it('still records the invocation when the early projection leaves a gap open', () => {
    const { dir, env, linked } = legacyLinkedWorktree(true);
    openProjectionGap(dir);

    const r = testSpawnSync(
      '/bin/bash',
      [reshipScript, 'pr-open', 't', '--pr', '--body-file', 'body.md', '--', 'note.txt'],
      { cwd: linked, encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain('docs/decisions cannot be linked from the overlay');
    expect(existsSync(join(linked, relIntentPath('pr-open')))).toBe(true);
  });
});
