/** ship_end: the one terminal row a ship writes, whichever step decided its exit. */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shipEndRow } from '../lib/ship/ship-intent-event.mts';
import { assertInterruptedGateKeepsWorktree, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  ghStub,
  installHook,
  scriptPath,
  seedShipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const PR_URL = 'echo https://github.com/acme/app/pull/42';

function rows(sink: string, type: string): unknown[] {
  if (!existsSync(sink)) return [];
  return readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === type);
}

function ship(
  dir: string,
  env: NodeJS.ProcessEnv,
  branch: string,
  gh = PR_URL,
  {
    args = [],
    sink = join(dir, 'gate-events.jsonl'),
    bin = ghStub(gh),
  }: { args?: string[]; sink?: string; bin?: string } = {},
) {
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  const r = spawnSync('/bin/bash', [scriptPath, branch, 't', ...args, 'note.txt'], {
    cwd: dir,
    input: 'b\n',
    encoding: 'utf8',
    env: { ...env, DEVKIT_GATE_EVENTS: sink, PATH: `${bin}:${env.PATH ?? process.env.PATH}` },
  });
  return { r, sink };
}

/** A gh whose `pr checks` never answers, so a --wait-ci ship sits in its wait until signalled. */
const HANGING_CHECKS =
  'case "$2" in checks) exec sleep 60 ;; *) echo https://github.com/acme/app/pull/42 ;; esac';

describe('shipEndRow', () => {
  it.each([
    [0, 'push_failed', null],
    [1, 'pr_create_failed', 'pr_create_failed'],
    [1, '', 'aborted'],
    [130, '', 'interrupted'],
    [143, '', 'interrupted'],
    [134, '', 'aborted'],
  ])('rc %d with cause %j records cause %j', (rc, cause, expected) => {
    expect(shipEndRow(rc, cause)).toEqual({ type: 'ship_end', exit_code: rc, cause: expected });
  });
});

describe('ship-branch.sh — ship_end', () => {
  it('a successful ship writes exactly one ship_end with no cause', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const { r, sink } = ship(dir, env, 'feat/end-ok');

    expect(r.status, r.stderr).toBe(0);
    expect(rows(sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 0, cause: null }),
    ]);
  });

  it('a failed gh pr create ends the ship with cause pr_create_failed', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const { r, sink } = ship(dir, env, 'feat/end-pr-fail', 'exit 1');

    expect(r.status, r.stderr).toBe(1);
    expect(rows(sink, 'ship_result')).toEqual([expect.objectContaining({ exit_code: 0 })]);
    expect(rows(sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 1, cause: 'pr_create_failed' }),
    ]);
  });

  it('a rejected push ends the ship with cause push_failed', () => {
    const { dir, env, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(bare, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bare, 'hooks/pre-receive'), 0o755);
    const { r, sink } = ship(dir, env, 'feat/end-push-fail');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('push failed');
    expect(rows(sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 1, cause: 'push_failed' }),
    ]);
  });

  it('a blocking preflight names itself and writes no gate-chain row', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    const { r, sink } = ship(dir, env, 'feat/end-preflight');

    expect(r.status, r.stderr).toBe(1);
    expect(rows(sink, 'ship_result')).toEqual([]);
    expect(rows(sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 1, cause: 'hook_source' }),
    ]);
  });

  it('a gate block carries the blocked_gate token as its cause', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    installHook(
      dir,
      "echo 'Confirmed completeness gap (hard-by-default; findings above).' >&2\nexit 1",
    );
    const { r, sink } = ship(dir, env, 'feat/end-gate');

    expect(r.status, r.stderr).toBe(1);
    expect(rows(sink, 'ship_result')).toEqual([
      expect.objectContaining({ exit_code: 1, blocked_gate: 'review' }),
    ]);
    expect(rows(sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 1, cause: 'review' }),
    ]);
  });

  it('a signal during the gate chain records interrupted on both rows', async () => {
    const { dir, env, git } = seedShipRepo();
    const sink = join(dir, 'gate-events.jsonl');
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    await assertInterruptedGateKeepsWorktree({
      dir,
      env: { ...env, DEVKIT_GATE_EVENTS: sink },
      script: scriptPath,
      args: ['feat/end-signal', 't', 'note.txt'],
      listWorktrees: () => git(['worktree', 'list']),
    });

    expect(rows(sink, 'ship_result')).toEqual([
      expect.objectContaining({ exit_code: 143, blocked_gate: 'interrupted' }),
    ]);
    expect(rows(sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 143, cause: 'interrupted' }),
    ]);
  });

  it('a ship interrupted while it waits on CI still ended as a success', async () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const sink = join(dir, 'gate-events.jsonl');
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const child = spawn('/bin/bash', [scriptPath, 'feat/end-wait', 't', '--wait-ci', 'note.txt'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...env,
        DEVKIT_GATE_EVENTS: sink,
        PATH: `${ghStub(HANGING_CHECKS)}:${env.PATH ?? process.env.PATH}`,
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // Ctrl-C reaches the whole foreground group, which is what the ship's own banner invites.
      if (stderr.includes('waiting on its checks') && child.pid) process.kill(-child.pid, 'SIGINT');
    });
    const [code] = await once(child, 'exit');

    expect(code, stderr).toBe(130);
    expect(rows(sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 0, cause: null }),
    ]);
  });

  it('a signal after the gates landed the commit, then its resume, each end once', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const bin = ghStub(PR_URL);
    const realTee = execFileSync('/bin/sh', ['-c', 'command -v tee'], { encoding: 'utf8' }).trim();
    // tee sees EOF only once the gate supervisor is reaped: the commit has landed, the ship has not.
    writeFileSync(join(bin, 'tee'), `#!/bin/sh\n"${realTee}" "$@"\nkill -TERM "$PPID"\nexit 0\n`);
    chmodSync(join(bin, 'tee'), 0o755);
    const first = ship(dir, env, 'feat/end-resume', PR_URL, { bin });
    rmSync(join(bin, 'tee'));
    const retry = ship(dir, env, 'feat/end-resume', PR_URL, { bin });

    expect(first.r.status, first.r.stderr).toBe(143);
    expect(retry.r.status, retry.r.stderr).toBe(0);
    expect(retry.r.stderr).toContain('gate receipt verified');
    expect(rows(first.sink, 'ship_end')).toEqual([
      expect.objectContaining({ exit_code: 143, cause: 'interrupted' }),
      expect.objectContaining({ exit_code: 0, cause: null }),
    ]);
  });

  it('a --dry-gates rehearsal writes no terminal row', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const { r, sink } = ship(dir, env, 'feat/end-dry', PR_URL, { args: ['--dry-gates', '--'] });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('Ship dry gates passed');
    expect(rows(sink, 'ship_end')).toEqual([]);
  });

  it('a sink that cannot be written never changes the outcome of a ship', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'not-a-dir'), '');
    const { r } = ship(dir, env, 'feat/end-sink', PR_URL, {
      sink: join(dir, 'not-a-dir/events.jsonl'),
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(git(['worktree', 'list'])).not.toContain('devkit-ship-');
  });
});
