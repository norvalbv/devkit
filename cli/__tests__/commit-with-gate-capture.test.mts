import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const helper = resolve(here, '../lib/ship/commit-with-gate-capture.sh');
const created: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Devkit Test',
  GIT_AUTHOR_EMAIL: 'devkit@example.com',
  GIT_COMMITTER_NAME: 'Devkit Test',
  GIT_COMMITTER_EMAIL: 'devkit@example.com',
};

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

function fixture(withHooks: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'ship-hook-proof-root-'));
  const wt = mkdtempSync(join(tmpdir(), 'ship-hook-proof-wt-'));
  rmSync(wt, { recursive: true, force: true });
  created.push(root, wt);

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'devkit@example.com');
  git(root, 'config', 'user.name', 'Devkit Test');
  mkdirSync(join(root, '.husky/_'), { recursive: true });
  writeFileSync(join(root, '.husky/.keep'), '');
  if (withHooks) {
    const huskyShim = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
    writeFileSync(
      join(root, '.husky/_/h'),
      '#!/bin/sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n' +
        '[ ! -f "$s" ] && exit 0\nexec sh -e "$s" "$@"\n',
    );
    writeFileSync(join(root, '.husky/_/pre-commit'), huskyShim);
    writeFileSync(join(root, '.husky/_/commit-msg'), huskyShim);
    writeFileSync(join(root, '.husky/pre-commit'), "echo 'REAL_PRE_COMMIT_RAN' >&2\n");
    writeFileSync(join(root, '.husky/commit-msg'), 'echo "REAL_COMMIT_MSG_RAN:$1" >&2\n');
    chmodSync(join(root, '.husky/_/h'), 0o755);
    chmodSync(join(root, '.husky/_/pre-commit'), 0o755);
    chmodSync(join(root, '.husky/_/commit-msg'), 0o755);
  }
  git(root, 'add', '.husky');
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'worktree', 'add', '-q', '--detach', wt, base);
  writeFileSync(join(wt, 'note.txt'), 'changed\n');
  git(wt, 'add', 'note.txt');
  return { root, wt, base };
}

function runCommit(root: string, wt: string, base: string, hideHookProof = false) {
  const telemetry = join(root, 'telemetry', 'gate-events.jsonl');
  const script = `
set -e
. "$1"
if [ "$6" = hide-proof ]; then
  grep() {
    if [ "$1" = -qF ] && [[ "$2" = devkit-ship-hook-start:* ]]; then return 1; fi
    command grep "$@"
  }
fi
export DEVKIT_GATE_EVENTS="$2"
export DEVKIT_SHIP_BASE_SHA="$3"
export DEVKIT_SHIP_ID=sc1537-test
export SHIP_COMMIT_TIMEOUT=10
commit_with_gate_capture "$4" "$5" feat/sc1537 "test title" "test body"
`;
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      script,
      'ship-hook-test',
      helper,
      telemetry,
      base,
      wt,
      root,
      hideHookProof ? 'hide-proof' : '',
    ],
    {
      cwd: root,
      env: gitEnv,
      encoding: 'utf8',
    },
  );
}

afterEach(() => {
  for (const path of created.splice(0).reverse()) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

describe('commit_with_gate_capture — executable hook proof', () => {
  it('runs the projected Husky hook when core.hooksPath is unset and captures proof', () => {
    const { root, wt, base } = fixture(true);

    expect(() => git(root, 'config', '--get', 'core.hooksPath')).toThrow();
    const result = runCommit(root, wt, base);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('devkit-ship-hook-start:sc1537-test');
    expect(result.stderr).toContain('REAL_PRE_COMMIT_RAN');
    expect(result.stderr).toMatch(/REAL_COMMIT_MSG_RAN:.*COMMIT_EDITMSG/);
    expect(result.stderr).toContain('pre-commit gates ran in the ship worktree');
    const log = join(root, '.devkit/last-ship-gates-feat-sc1537.log');
    expect(existsSync(log)).toBe(true);
    expect(git(wt, 'rev-parse', 'HEAD')).not.toBe(base);
    expect(readdirSync(wt).some((name) => name.startsWith('.devkit-ship-hooks.'))).toBe(false);
  });

  it('fails closed before committing when no executable pre-commit hook resolves', () => {
    const { root, wt, base } = fixture(false);

    const result = runCommit(root, wt, base);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no executable pre-commit hook/);
    expect(result.stderr).toMatch(/gates must not fail open/);
    expect(result.stderr).not.toMatch(/pre-commit gates ran/);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(base);
    const events = readFileSync(join(root, 'telemetry/gate-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      type: 'ship_result',
      exit_code: 1,
      blocked_gate: 'hook_setup',
    });
  });

  it('rewinds and records a failed result when the execution proof is not observed', () => {
    const { root, wt, base } = fixture(true);

    const result = runCommit(root, wt, base, true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/NO pre-commit execution proof/);
    expect(result.stderr).not.toMatch(/pre-commit gates ran/);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(base);
    const events = readFileSync(join(root, 'telemetry/gate-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      type: 'ship_result',
      exit_code: 1,
      blocked_gate: 'hook_proof',
    });
  });
});
