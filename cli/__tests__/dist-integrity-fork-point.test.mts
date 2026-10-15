/** Briefed deletions are judged at the caller's fork point, where ship staging anchors — not at BASE. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectDistIntegrity } from '../lib/ship/dist-integrity.mts';
import { recordShip } from '../lib/ship/reconcile-manifest-write.mts';
import { buildableFixture, rootRegistry } from './_helpers.mts';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const SRC = 'cli/new.mts';
const DIST = 'dist/cli/new.mjs';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function write(root: string, file: string, body: string): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** A devkit-shaped repo on `main` whose base tracks one compiled source and its dist twin. */
function repo() {
  const root = mkTmp('dist-integrity-fork-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  write(root, 'package.json', `${JSON.stringify({ name: '@norvalbv/devkit' })}\n`);
  write(root, '.gitignore', '.devkit/\ndist/\nnode_modules\n');
  write(root, 'cli/old.mts', 'export const old = 1;\n');
  write(root, 'dist/cli/old.mjs', 'export const old = 1;\n');
  git(root, 'add', 'package.json', '.gitignore', 'cli/old.mts');
  git(root, 'add', '-f', 'dist/cli/old.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  buildableFixture(root);
  return { root, main: git(root, 'rev-parse', 'HEAD') };
}

/** Commit <files> on a side branch and return to `main`, leaving them on disk but out of the index. */
function sideCommit(root: string, branch: string, files: Record<string, string>): string {
  git(root, 'checkout', '-q', '-b', branch);
  for (const [file, body] of Object.entries(files)) {
    write(root, file, body);
    git(root, 'add', '-f', file);
  }
  git(root, 'commit', '-q', '-m', branch);
  const tip = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  for (const [file, body] of Object.entries(files)) write(root, file, body);
  return tip;
}

const NEW_FILES = { [SRC]: 'export const value = 1;\n', [DIST]: 'export const value = 1;\n' };

describe('inspectDistIntegrity — deletions judged at the fork point', () => {
  it('passes an append re-ship that briefs the PR-new dist artifact this checkout never tracked', async () => {
    const { root } = repo();
    const tip = sideCommit(root, 'feat/pr', NEW_FILES);

    const sourceOnly = await inspectDistIntegrity(root, tip, [SRC]);
    const withDist = await inspectDistIntegrity(root, tip, [SRC, DIST]);

    expect(sourceOnly.untracked).toEqual([]);
    expect(withDist.untracked).toEqual([]);
    expect(withDist.unresolved).toEqual([]);
  });

  it('still reports a fork-point artifact dropped from the index on an append re-ship', async () => {
    const { root } = repo();
    const tip = sideCommit(root, 'feat/pr', NEW_FILES);
    git(root, 'rm', '-q', '--cached', 'dist/cli/old.mjs');

    const report = await inspectDistIntegrity(root, tip, ['dist/cli/old.mjs']);

    expect(report.untracked).toEqual(['dist/cli/old.mjs']);
  });

  it('passes a dist path the base added after this checkout forked', async () => {
    const { root } = repo();
    const later = { 'dist/cli/later.mjs': 'export const later = 1;\n' };
    const base = sideCommit(root, 'origin-moved', later);

    const report = await inspectDistIntegrity(root, base, ['dist/cli/later.mjs']);

    expect(report.untracked).toEqual([]);
  });

  it('falls back to the base when it shares no history with HEAD', async () => {
    const { root } = repo();
    git(root, 'checkout', '-q', '--orphan', 'unrelated');
    git(root, 'commit', '-q', '-m', 'unrelated');
    const orphan = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', 'main');
    write(root, DIST, 'export const value = 1;\n');

    const report = await inspectDistIntegrity(root, orphan, [DIST]);

    expect(report.untracked).toEqual([]);
  });
});

describe('ship --pr re-briefing a PR-new dist artifact', () => {
  it('commits the edited source and its rebuilt dist without a local git add -f', () => {
    const { root, main } = repo();
    git(root, 'config', 'core.hooksPath', '.husky/_');
    write(root, '.husky/_/pre-commit', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, '.husky/_/pre-commit'), 0o755);
    const bare = mkTmp('dist-integrity-fork-origin-');
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
    git(root, 'remote', 'add', 'origin', bare);
    const tip = sideCommit(root, 'feat/pr', NEW_FILES);
    git(root, 'push', '-q', 'origin', `${tip}:refs/heads/feat/pr`);
    const ship = { root, branch: 'feat/pr', repo: 'acme/app', baseRef: 'main', baseSha: main };
    expect(recordShip(ship, [SRC, DIST])).toBe(0);
    write(root, SRC, 'export const value = 2;\n');
    write(root, DIST, 'export const value = 2;\n');

    const result = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/pr', 'test', '--pr', '--', SRC, DIST],
      {
        cwd: root,
        input: 'pr body\n',
        encoding: 'utf8',
        env: {
          ...process.env,
          ...GIT_ENV,
          SHIP_DRY_RUN: '1',
          TMPDIR: mkTmp('dist-integrity-fork-tmp-'),
        },
      },
    );
    const wt = /DRY: worktree kept at (.+?)\. Remove/.exec(result.stderr)?.[1];
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('dist integrity preflight failed');
      expect(wt).toBeDefined();
      const committed = git(wt!, 'show', '--name-only', '--format=', 'HEAD').split('\n');
      expect(committed.sort()).toEqual([SRC, DIST].sort());
    } finally {
      if (wt) git(root, 'worktree', 'remove', '--force', wt);
    }
  });
});
