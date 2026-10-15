/** A waiting ship runs its own pre-worktree refusals without a slot, and writes nothing. */
import type { ExecFileSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { prequeueEnv, queueAhead } from '../lib/ship/queue/enter.mts';
import { runPackagedScriptQuiet } from '../lib/ship/run-packaged-script.mts';
import { readIntent } from '../lib/ship/ship-intent.mts';
import { rewriteRepo } from './_reship-rewrite-fixture.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  createPreservedCommit,
  dirs,
  ghStub,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

type Seeded = {
  dir: string;
  env: NodeJS.ProcessEnv;
  git: (a: string[], o?: ExecFileSyncOptions) => string;
};

const MISSING_RUNNER_RE = /missing \.husky\/_ in /;
const DEAD_PID = '999999';

/** One pre-queue pass, as the dispatcher runs it: no slot env, no stdin. */
function pass(script: string, s: Seeded, args: string[], ahead: string[] = [], env = {}) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: s.dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: prequeueEnv({ ...s.env, SHIP_DRY_RUN: '1', ...env }, ahead),
  });
}

function seedNote(s: Seeded): void {
  writeFileSync(join(s.dir, 'note.txt'), 'hi\n');
}

function wroteNothing(s: Seeded, branch: string): void {
  expect(readIntent(s.dir, branch)).not.toHaveProperty('intent');
  expect(s.git(['worktree', 'list', '--porcelain'])).not.toMatch(/devkit-(re)?ship-/);
}

const view = (running: string[], waiters: Array<[string, number, number]>) => ({
  running: running.map((branch) => ({ branch })),
  waiters: waiters.map(([branch, seq, pid]) => ({ branch, seq, pid })),
});

describe('queueAhead', () => {
  it('is undefined when this process holds no waiting ticket (claimed at once, or a guest)', () => {
    expect(queueAhead(7, () => view(['a'], []))).toBeUndefined();
  });

  it('names the running ships and the waiters ahead of this ticket, never the ones behind', () => {
    expect(
      queueAhead(7, () =>
        view(
          ['a'],
          [
            ['b', 2, 3],
            ['mine', 3, 7],
            ['c', 4, 9],
          ],
        ),
      ),
    ).toEqual(['a', 'b']);
  });

  it('is undefined when the queue cannot be read', () => {
    const unreadable = () => {
      throw new Error('timed out acquiring queue lock');
    };
    expect(queueAhead(7, unreadable)).toBeUndefined();
  });
});

describe('prequeueEnv', () => {
  it('marks the pass and drops every slot variable, so the pass can never register under one', () => {
    const env = prequeueEnv(
      {
        KEEP: '1',
        DEVKIT_SHIP_SLOT: 't',
        DEVKIT_SHIP_SLOT_DIR: '/q',
        DEVKIT_SHIP_SLOT_RELEASE: '1',
      },
      ['a', 'b'],
    );
    expect(env).toEqual({
      KEEP: '1',
      DEVKIT_SHIP_PREQUEUE: '1',
      DEVKIT_SHIP_PREQUEUE_AHEAD: 'a\nb',
    });
  });
});

describe('runPackagedScriptQuiet', () => {
  it('stays silent on success and replays the output of a failure', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const options = { command: 'devkit ship', cwd: tmpdir(), env: process.env };
      expect(runPackagedScriptQuiet('queue/slot.sh', [], options)).toBe(0);
      expect(write).not.toHaveBeenCalled();
      expect(runPackagedScriptQuiet('ship-branch.sh', [], options)).toBe(1);
      expect(write.mock.calls.flat().join('')).toContain('branch');
    } finally {
      write.mockRestore();
    }
  });

  // The pass must leave a piped or here-doc PR body for the queued run, which reads it after the wait.
  it("never reads the caller's stdin", () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ship-prequeue-stdin-'));
    dirs.push(tmp);
    const probe = join(tmp, 'probe.sh');
    writeFileSync(probe, 'cat >&2\nexit 3\n');
    const runner = fileURLToPath(new URL('../lib/ship/run-packaged-script.mts', import.meta.url));
    const rel = relative(dirname(runner), probe);
    const code = `import(${JSON.stringify(runner)}).then((m) => process.exit(m.runPackagedScriptQuiet(${JSON.stringify(rel)}, [], { command: 'x', cwd: process.cwd(), env: process.env })));`;

    const r = spawnSync(process.execPath, ['-e', code], { input: 'PR BODY\n', encoding: 'utf8' });

    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).not.toContain('PR BODY');
  });
});

describe('ship-branch.sh pre-queue pass', () => {
  it.each([[[]], [['--dry-gates']]])(
    'passes a clean ship %j without creating a branch, worktree or record',
    (flags) => {
      const s = seedShipRepo();
      seedNote(s);

      const r = pass(scriptPath, s, ['feat/clean', 't', ...flags, '--', 'note.txt']);

      expect(r.status, r.stderr).toBe(0);
      expect(s.git(['branch', '--list', 'feat/clean']).trim()).toBe('');
      wroteNothing(s, 'feat/clean');
    },
  );

  it('refuses on a blocking preflight and, unlike the queued run, records nothing', () => {
    const s = seedShipRepo();
    seedNote(s);
    rmSync(join(s.dir, '.husky/_'), { recursive: true, force: true });

    const r = pass(scriptPath, s, ['feat/hook', 't', '--', 'note.txt']);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(MISSING_RUNNER_RE);
    wroteNothing(s, 'feat/hook');
  });

  it('refuses an existing branch, unless a ship of that branch is ahead in the queue', () => {
    const s = seedShipRepo();
    seedNote(s);
    s.git(['branch', 'feat/twice']);
    const args = ['feat/twice', 't', '--', 'note.txt'];

    expect(pass(scriptPath, s, args).status).toBe(1);
    const deferred = pass(scriptPath, s, args, ['feat/twice']);
    expect(deferred.status, deferred.stderr).toBe(0);
  });

  it('refuses a --base missing on origin, unless a ship of that base is ahead in the queue', () => {
    const s = seedShipRepoLocalRemote();
    seedNote(s);
    const args = ['feat/stacked', 't', '--base', 'parent', '--', 'note.txt'];

    expect(pass(scriptPath, s, args).status).not.toBe(0);
    const deferred = pass(scriptPath, s, args, ['parent']);
    expect(deferred.status, deferred.stderr).toBe(0);
  });

  it('ends before the preserved-commit checks, so an existing branch writes no record', () => {
    const s = seedShipRepoLocalRemote();
    const tip = createPreservedCommit({ ...s, branch: 'feat/kept', tempPrefix: 'ship-prequeue-' });
    const gh = { PATH: `${ghStub('')}:${s.env.PATH ?? process.env.PATH ?? ''}` };

    const r = pass(scriptPath, s, ['feat/kept', 'ship it', '--', 'note.txt'], [], {
      SHIP_DRY_RUN: '',
      ...gh,
    });

    expect(r.status, r.stderr).toBe(0);
    expect(s.git(['rev-parse', 'feat/kept']).trim()).toBe(tip);
    wroteNothing(s, 'feat/kept');
  });
});

describe('reship.sh pre-queue pass', () => {
  it('passes an open PR branch without the publish lock or a record', () => {
    const s = seedReshipRepo();
    seedNote(s);

    const r = pass(reshipScript, s, ['pr-open', 't', '--pr', '--', 'note.txt']);

    expect(r.status, r.stderr).toBe(0);
    const common = s.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    expect(existsSync(join(common, 'devkit/reship-publish'))).toBe(false);
    wroteNothing(s, 'pr-open');
  });

  it('refuses --pr to a branch missing on origin, unless a ship of it is ahead in the queue', () => {
    const s = seedReshipRepo();
    seedNote(s);
    const args = ['feat/absent', 't', '--pr', '--', 'note.txt'];

    const refused = pass(reshipScript, s, args);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('no remote branch origin/feat/absent');
    expect(pass(reshipScript, s, args, ['feat/absent']).status).toBe(0);
  });

  it('passes a --pr --base rewrite without leaving its pin refs, the publish lock or a record', () => {
    const repo = rewriteRepo();
    const prTip = repo.g(['ls-remote', 'origin', 'refs/heads/feat/pr']);

    const r = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/pr', 't', '--pr', '--base', 'main', '--', 'conflict.txt'],
      {
        cwd: repo.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: prequeueEnv(repo.env, []),
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(repo.g(['for-each-ref', '--format=%(refname)', 'refs/devkit/'])).toBe('');
    const common = repo.g(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    expect(existsSync(join(common, 'devkit/reship-publish'))).toBe(false);
    expect(readIntent(repo.dir, 'feat/pr')).not.toHaveProperty('intent');
    expect(repo.g(['ls-remote', 'origin', 'refs/heads/feat/pr'])).toBe(prTip);
  });

  it('refuses on a blocking preflight and records nothing', () => {
    const s = seedReshipRepo();
    seedNote(s);
    rmSync(join(s.dir, '.husky/_'), { recursive: true, force: true });

    const r = pass(reshipScript, s, ['pr-open', 't', '--pr', '--', 'note.txt']);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(MISSING_RUNNER_RE);
    wroteNothing(s, 'pr-open');
  });
});

/** A dead ship's worktree on `branch` with the run record the reclaim preflight reads; `kept`
 *  makes it a detached worktree that ship preserved on purpose, which the preflight refuses. */
function deadOrphan(s: Seeded, branch: string, kept = false): string {
  const wt = mkdtempSync(join(tmpdir(), 'ship-prequeue-orphan-'));
  dirs.push(wt);
  rmSync(wt, { recursive: true, force: true });
  s.git(['worktree', 'add', '-q', ...(kept ? ['--detach'] : ['-b', branch]), wt, 'work']);
  const admin = s.git(['-C', wt, 'rev-parse', '--absolute-git-dir']).trim();
  const base = s.git(['rev-parse', 'work']).trim();
  const fields = { v: 1, branch, wt, pid: DEAD_PID, identity: 'x', base, branch_created: 1 };
  const extra = kept ? { keep: 1 } : {};
  const record = Object.entries({ ...fields, ...extra, mode: 'live' }).map(
    ([k, v]) => `${k}=${v}\n`,
  );
  writeFileSync(join(admin, 'devkit-ship-run'), record.join(''));
  return wt;
}

/** The reclaim preflight alone, sourced without queue/slot.sh as ship-run-record.test does. */
function reclaim(s: Seeded, branch: string, env: NodeJS.ProcessEnv): number | null {
  const lib = dirname(scriptPath);
  const script = `set -euo pipefail
. "${lib}/worktree-registry.sh"; . "${lib}/ship-run-record.sh"; . "${lib}/reclaim-orphan-worktrees.sh"
PREFLIGHT_HINT=; PREFLIGHT_SELF=
ship_reclaim_orphan_worktrees "${s.dir}" "${branch}"`;
  const opts = { cwd: s.dir, encoding: 'utf8' as const, env: { ...s.env, ...env } };
  return spawnSync('/bin/bash', ['-c', script], opts).status;
}

describe('orphan reclaim in the pre-queue pass', () => {
  it('leaves a reclaimable orphan to the queued run, which does reclaim it', () => {
    const s = seedShipRepo();
    const wt = deadOrphan(s, 'feat/orphan');
    mkdirSync(join(s.dir, '.devkit'), { recursive: true });

    expect(reclaim(s, 'feat/orphan', { DEVKIT_SHIP_PREQUEUE: '1' })).toBe(0);
    expect(existsSync(wt)).toBe(true);

    expect(reclaim(s, 'feat/orphan', {})).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  // The queued run would refuse on the kept worktree, so the pass must too: a pending reclaim
  // elsewhere in the list may not end the pass before every entry is judged.
  it('still refuses on a kept worktree when another entry would be reclaimed', () => {
    const s = seedShipRepo();
    const orphan = deadOrphan(s, 'feat/both');
    deadOrphan(s, 'feat/both', true);

    expect(reclaim(s, 'feat/both', { DEVKIT_SHIP_PREQUEUE: '1' })).toBe(1);
    expect(existsSync(orphan)).toBe(true);
  });
});
