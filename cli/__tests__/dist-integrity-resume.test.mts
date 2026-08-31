import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readIntent } from '../lib/ship/ship-intent.mts';
import { rootRegistry } from './_helpers.mts';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const shipScript = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function repo(): string {
  const root = mkTmp('dist-integrity-resume-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  git(root, 'config', 'core.hooksPath', '.husky/_');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@norvalbv/devkit' })}\n`);
  writeFileSync(join(root, '.gitignore'), '.devkit/\ndist/\n');
  mkdirSync(join(root, 'dist/cli'), { recursive: true });
  mkdirSync(join(root, 'cli'));
  writeFileSync(join(root, 'dist/index.mjs'), 'export const ready = true;\n');
  git(root, 'add', 'package.json', '.gitignore');
  git(root, 'add', '-f', 'dist/index.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  mkdirSync(join(root, '.husky/_'), { recursive: true });
  writeFileSync(join(root, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, '.husky/_/pre-commit'), 0o755);
  writeFileSync(join(root, 'cli/new.mts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
  return root;
}

function intent(root: string, branch: string, mode: 'ship' | 'reship', paths: string[]): void {
  const result = readIntent(root, branch);
  expect(result).toHaveProperty('intent');
  if (!('intent' in result)) throw new Error(result.reason);
  expect(result.intent).toMatchObject({ mode, branch, title: 'test', paths });
  expect(Buffer.from(result.intent.bodyB64, 'base64').toString()).toBe('pr body');
}

function cleanDryRun(root: string, stderr: string, branch?: string): void {
  const match = /DRY: worktree kept at (.+?)(?: \(branch|\. Remove)/.exec(stderr);
  if (match) git(root, 'worktree', 'remove', '--force', match[1]);
  if (branch && git(root, 'branch', '--list', branch)) git(root, 'branch', '-D', branch);
}

describe('ship dist-integrity resume', () => {
  it('keeps dist-integrity blocking dry-gates without recording an intent', () => {
    const root = repo();
    const tempRoot = mkTmp('dist-integrity-resume-tmp-');
    const branch = 'feat/dist-dry-gates';
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');

    const result = spawnSync(
      '/bin/bash',
      [shipScript, branch, 'test', '--dry-gates', '--', 'cli/new.mts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, TMPDIR: tempRoot },
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Include after -- in the next devkit ship: 'dist/cli/new.mjs'");
    expect(readIntent(root, branch)).not.toHaveProperty('intent');
    expect(git(root, 'branch', '--list', branch)).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('devkit-ship-');
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('records a blocked new ship and resumes with the omitted artifact', () => {
    const root = repo();
    const tempRoot = mkTmp('dist-integrity-resume-tmp-');
    const branch = 'feat/dist-resume';
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    const env = { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1', TMPDIR: tempRoot };

    const first = spawnSync('/bin/bash', [shipScript, branch, 'test', '--', 'cli/new.mts'], {
      cwd: root,
      input: 'pr body\n',
      encoding: 'utf8',
      env,
    });

    expect(first.status, first.stderr).toBe(1);
    expect(first.stderr).toContain("Include after -- in the next devkit ship: 'dist/cli/new.mjs'");
    intent(root, branch, 'ship', ['cli/new.mts']);
    expect(git(root, 'branch', '--list', branch)).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('devkit-ship-');
    expect(readdirSync(tempRoot)).toEqual([]);

    const retry = spawnSync(
      '/bin/bash',
      [shipScript, '--resume', branch, '--', 'dist/cli/new.mjs'],
      {
        cwd: root,
        encoding: 'utf8',
        env,
      },
    );
    try {
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).toContain('Resuming recorded invocation');
      intent(root, branch, 'ship', ['cli/new.mts', 'dist/cli/new.mjs']);
    } finally {
      cleanDryRun(root, retry.stderr, branch);
    }
  });

  it('records a blocked reship and cross-dispatches resume with the omitted artifact', () => {
    const root = repo();
    const tempRoot = mkTmp('dist-integrity-resume-tmp-');
    const branch = 'feat/open';
    const bare = mkTmp('dist-integrity-resume-origin-');
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', `HEAD:${branch}`);
    const env = { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1', TMPDIR: tempRoot };

    const first = spawnSync(
      '/bin/bash',
      [reshipScript, branch, 'test', '--pr', '--', 'cli/new.mts'],
      { cwd: root, input: 'pr body\n', encoding: 'utf8', env },
    );

    expect(first.status, first.stderr).toBe(1);
    expect(first.stderr).toContain("Include after -- in the next devkit ship: 'dist/cli/new.mjs'");
    intent(root, branch, 'reship', ['cli/new.mts']);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('devkit-reship-');
    expect(readdirSync(tempRoot)).toEqual([]);

    const retry = spawnSync(
      '/bin/bash',
      [shipScript, '--resume', branch, '--', 'dist/cli/new.mjs'],
      {
        cwd: root,
        encoding: 'utf8',
        env,
      },
    );
    try {
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).toContain(`Resuming recorded invocation for ${branch} (--pr)`);
      intent(root, branch, 'reship', ['cli/new.mts', 'dist/cli/new.mjs']);
    } finally {
      cleanDryRun(root, retry.stderr);
    }
  });
});
