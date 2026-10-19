/** A hook that exits 0 but leaves a process running: git lands the commit, the gate supervisor reaps
 *  the leftover, and ship publishes instead of stopping at exit 124 for a --resume. */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import { rewriteRepo } from './_reship-rewrite-fixture.mts';
import {
  bodyUpdateRepo,
  dirs,
  GIT_ENV,
  localBranchExists,
  publishEnvFor,
  remoteBranchExists,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const LEAKING_HOOK = 'echo run >> "$TEST_HOOK_COUNT"\nsleep 30 &';
const REAPED_NOTICE =
  /✓ ship: the gate chain passed; a process it started outlived it and was reaped/;

function events(sink: string) {
  return readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function bareSha(bare: string, ref: string) {
  return execFileSync('git', ['--git-dir', bare, 'rev-parse', ref], {
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

function shipLeaking(extraPath = '') {
  const { dir, env, git, bare } = seedShipRepoLocalRemote({ hookBody: LEAKING_HOOK });
  const { hookCount, publishEnv } = publishEnvFor(dir, env);
  const sink = join(dir, 'events.jsonl');
  writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  const r = spawnSync('/bin/bash', [scriptPath, 'feat/reaped', 'ship it', '--', 'note.txt'], {
    cwd: dir,
    input: 'pr body\n',
    encoding: 'utf8',
    env: {
      ...publishEnv,
      PATH: extraPath ? `${extraPath}:${publishEnv.PATH}` : publishEnv.PATH,
      DEVKIT_GATE_EVENTS: sink,
      SHIP_COMMIT_TIMEOUT: '120',
    },
  });
  return { r, git, bare, hookCount, sink };
}

describe('ship — a landed commit whose hook left a process behind', () => {
  it('publishes the commit and records the reap, with no timeout and no --resume', () => {
    const { r, git, bare, hookCount, sink } = shipLeaking();

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(REAPED_NOTICE);
    expect(r.stderr).not.toMatch(/exit 124|--resume/);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
    const pushed = bareSha(bare, 'feat/reaped');
    expect(git(['show', '-s', '--format=%s', pushed]).trim()).toBe('ship it');
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1);
    const rows = events(sink);
    expect(rows.find((e) => e.type === 'ship_result')).toMatchObject({
      exit_code: 0,
      timed_out: false,
      reaped: true,
      blocked_gate: null,
    });
    // The merge verdict reads this record; a resumed 124 never wrote one.
    expect(rows.find((e) => e.type === 'ship_gated')?.head).toBe(pushed);
  }, 240_000);

  it('still fails closed when the gate output could not be persisted', () => {
    const stub = mkdtempSync(join(tmpdir(), 'ship-reaped-tee-'));
    dirs.push(stub);
    const realTee = execFileSync('/bin/sh', ['-c', 'command -v tee'], { encoding: 'utf8' }).trim();
    writeFileSync(join(stub, 'tee'), `#!/bin/sh\n"${realTee}" "$@"\nexit 1\n`);
    chmodSync(join(stub, 'tee'), 0o755);

    const { r, git, bare, sink } = shipLeaking(stub);

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('could not persist gate output');
    expect(remoteBranchExists(bare, 'feat/reaped')).toBe(false);
    expect(localBranchExists(git, 'refs/devkit/ship-receipts/feat/reaped')).toBe(false);
    expect(events(sink).find((e) => e.type === 'ship_result')).toMatchObject({
      exit_code: 1,
      reaped: true,
    });
  }, 240_000);
});

describe('ship --pr — a landed commit whose hook left a process behind', () => {
  it('appends to the PR branch and pushes', () => {
    const { bare, dir, env } = bodyUpdateRepo({ hookBody: 'sleep 30 &' });
    const before = bareSha(bare, 'feat/pr');
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = spawnSync('/bin/bash', [reshipScript, 'feat/pr', 'add v2', '--pr', '--', 'a.ts'], {
      cwd: dir,
      input: 'body\n',
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, ...env },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(REAPED_NOTICE);
    const after = bareSha(bare, 'feat/pr');
    expect(bareSha(bare, `${after}^`)).toBe(before);
  }, 240_000);

  it('rewrites the PR branch onto its base and pushes under the lease', () => {
    const { bare, dir, env, mainTip } = rewriteRepo();
    const hook = join(dir, '.husky/_/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nsleep 30 &\n');
    chmodSync(hook, 0o755);

    const r = spawnSync(
      '/bin/bash',
      [
        reshipScript,
        'feat/pr',
        'publish resolved PR',
        '--pr',
        '--base',
        'main',
        '--',
        'conflict.txt',
      ],
      { cwd: dir, input: 'body\n', encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env } },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(REAPED_NOTICE);
    const replacement = bareSha(bare, 'feat/pr');
    expect(bareSha(bare, `${replacement}^`)).toBe(mainTip);
  }, 240_000);
});
