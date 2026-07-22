/**
 * `devkit sync-hook-runner` and its wiring into a fresh `devkit init`'s package.json — the
 * mechanism that closes the untracked-runner bug class for every NEW repo, permanently: no
 * manual `git add -f` ever needed again, because every `bun install` re-stages it.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('sync-hook-runner-');
afterEach(cleanup);

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

/** The same husky-install shape used throughout doctor-hook-runner.test.mts. */
function huskyRepo(root: string): void {
  git(root, 'init', '-q');
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(root, '.husky', '_'), { recursive: true });
  writeFileSync(join(root, '.husky', '_', '.gitignore'), '*');
  writeFileSync(join(root, '.husky', '_', 'h'), '#!/usr/bin/env sh\n');
  writeFileSync(join(root, '.husky', '_', 'pre-commit'), '. "$(dirname "$0")/h"\n', {
    mode: 0o755,
  });
  git(root, 'config', 'core.hooksPath', '.husky/_');
}

function isTracked(root: string, relPath: string): boolean {
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', relPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('devkit sync-hook-runner', () => {
  it('stages exactly the unreachable runner files', () => {
    const root = tmpRepo();
    huskyRepo(root);

    const r = execFileSync(process.execPath, [CLI, 'sync-hook-runner'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(r).toContain('staged');
    expect(isTracked(root, '.husky/_/h')).toBe(true);
    expect(isTracked(root, '.husky/_/pre-commit')).toBe(true);
  });

  it('is a no-op once the runner is already tracked', () => {
    const root = tmpRepo();
    huskyRepo(root);
    git(root, 'add', '-f', '.husky/_/h', '.husky/_/pre-commit');

    const r = execFileSync(process.execPath, [CLI, 'sync-hook-runner'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(r).toContain('nothing to stage');
  });

  it('--dry-run reports without staging anything', () => {
    const root = tmpRepo();
    huskyRepo(root);

    const r = execFileSync(process.execPath, [CLI, 'sync-hook-runner', '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(r).toContain('[dry-run]');
    expect(isTracked(root, '.husky/_/h')).toBe(false);
  });
});

describe('devkit init — prepare script wiring', () => {
  it('chains sync-hook-runner into a fresh package-mode install, guarded', () => {
    const root = tmpRepo();
    const result = devkit(root, 'init', '--yes');

    expect(result.status, result.stderr).toBe(0);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepare).toBe(
      'husky && (command -v devkit >/dev/null 2>&1 && devkit sync-hook-runner || true)',
    );
  });

  it('does not touch package.json for a standalone install', () => {
    const root = tmpRepo();
    const before = readFileSync(join(root, 'package.json'), 'utf8');
    const result = devkit(root, 'init', '--yes', '--standalone');

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
  });
});
