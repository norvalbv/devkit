import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRE_PUSH_HOOK = join(REPO_ROOT, '.husky/pre-push');
const ZERO_OID = '0000000000000000000000000000000000000000';
const cleanupPaths: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function seedRepository(): {
  fakeBin: string;
  logPath: string;
  root: string;
  tagOid: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'devkit-pre-push-'));
  cleanupPaths.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'pre-push-test@example.com');
  git(root, 'config', 'user.name', 'Pre-push Test');
  git(root, 'config', 'core.hooksPath', '.husky/_');

  mkdirSync(join(root, '.husky/_'), { recursive: true });
  const preCommit = join(root, '.husky/_/pre-commit');
  writeFileSync(preCommit, '#!/bin/sh\nexit 0\n');
  chmodSync(preCommit, 0o755);
  writeFileSync(join(root, 'package.json'), '{"name":"pre-push-fixture","private":true}\n');
  writeFileSync(join(root, 'tracked.mts'), 'export const clean = true;\n');
  for (const relativePath of [
    'cli/lib/husky/pre-push-validation.sh',
    'cli/lib/ship/dependency-preflight.mts',
    'cli/lib/ship/prepare-gate-worktree.sh',
  ]) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(REPO_ROOT, relativePath), destination);
  }
  git(root, 'add', 'package.json', 'tracked.mts', 'cli');
  git(root, 'commit', '-qm', 'seed');
  git(root, 'tag', '-a', 'v1.0.0', '-m', 'fixture tag');

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  const fakeBin = join(root, 'fake-bin');
  const logPath = join(root, 'bun.log');
  mkdirSync(fakeBin);
  const fakeBun = join(fakeBin, 'bun');
  writeFileSync(
    fakeBun,
    [
      '#!/bin/sh',
      'printf "%s\\t%s\\n" "$PWD" "$*" >> "$PRE_PUSH_TEST_LOG"',
      '[ ! -e "$PWD/dirty-only.mts" ]',
      '',
    ].join('\n'),
  );
  chmodSync(fakeBun, 0o755);

  return {
    fakeBin,
    logPath,
    root,
    tagOid: git(root, 'rev-parse', 'refs/tags/v1.0.0'),
  };
}

function runPrePush(root: string, fakeBin: string, logPath: string, input: string) {
  return spawnSync('sh', ['-e', PRE_PUSH_HOOK, 'origin', 'fixture://origin'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PRE_PUSH_TEST_LOG: logPath,
    },
    input,
  });
}

function readLog(logPath: string): string[] {
  return readFileSync(logPath, 'utf8').trim().split('\n');
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe('devkit repository pre-push hook', () => {
  it('validates an annotated tag in an isolated worktree at the tagged commit', () => {
    const { fakeBin, logPath, root, tagOid } = seedRepository();
    writeFileSync(join(root, 'dirty-only.mts'), 'const unrelatedTypeError: string = 1;\n');

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/tags/v1.0.0 ${tagOid} refs/tags/v1.0.0 ${ZERO_OID}\n`,
    );

    expect(result.stderr).toContain(`validating tagged commit ${git(root, 'rev-parse', 'HEAD')}`);
    expect(result.stderr).toContain('tag validation: linked node_modules');
    expect(result.status).toBe(0);
    const invocations = readLog(logPath);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain('\trun typecheck');
    expect(invocations[1]).toContain('\trun test:run');
    for (const invocation of invocations) {
      expect(invocation.startsWith(`${realpathSync(root)}\t`)).toBe(false);
    }
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('keeps branch-push validation in the caller worktree', () => {
    const { fakeBin, logPath, root } = seedRepository();
    const head = git(root, 'rev-parse', 'HEAD');

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `refs/heads/main ${head} refs/heads/main ${ZERO_OID}\n`,
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readLog(logPath)).toEqual([
      `${realpathSync(root)}\trun typecheck`,
      `${realpathSync(root)}\trun test:run`,
    ]);
  });

  it('does not run source validation for a tag deletion', () => {
    const { fakeBin, logPath, root } = seedRepository();

    const result = runPrePush(
      root,
      fakeBin,
      logPath,
      `(delete) ${ZERO_OID} refs/tags/v1.0.0 ${git(root, 'rev-parse', 'HEAD')}\n`,
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });
});
