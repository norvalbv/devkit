import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import { bodyUpdateRepo, dirs, GIT_ENV, reshipScript } from './_ship-branch-fixture.mts';

// reship.sh's per-branch publication lock (rewrite_publish_lock_acquire / _release): its reclaim
// arms decide whether a killed publisher wedges the branch or a live one loses mutual exclusion.
describe('reship.sh — the rewrite publication lock', () => {
  // Recomputed through git exactly as reship.sh does, never via an env override: an override is a
  // second input that could key two publishers of one clone to different locks.
  const sh = (cmd: string, input?: string) =>
    execFileSync('/bin/sh', ['-c', cmd], {
      input,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    })
      .toString()
      .trim();
  const commonDir = (dir: string) =>
    sh(`git -C '${dir}' rev-parse --path-format=absolute --git-common-dir`);
  const lockOf = (dir: string, branch = 'feat/pr') =>
    join(commonDir(dir), 'devkit/reship-publish', `${sh('git hash-object --stdin', branch)}.lock`);

  // A holder the reclaim arms must treat as LIVE: a real process plus the same pid:lstart-digest
  // stamp reship.sh writes, so neither the dead-pid nor the recycled-pid arm can take it over.
  const holders: number[] = [];
  afterEach(() => {
    for (const pid of holders.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
  const holdLive = (lock: string) => {
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) throw new Error('could not spawn the live lock holder');
    holders.push(pid);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, 'holder'),
      `${pid}:${sh(`ps -o lstart= -p ${pid} | git hash-object --stdin`)}:0`,
    );
  };

  const reship = (dir: string, env: Record<string, string>, body: string) =>
    spawnSync(
      '/bin/bash',
      [
        reshipScript,
        'feat/pr',
        'add v2',
        '--pr',
        '--body',
        body,
        '--no-qavis-publish',
        '--',
        'a.ts',
      ],
      {
        cwd: dir,
        input: 'body\n',
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, ...env },
      },
    );

  it('reclaims a stale publish lock whose holder process is gone', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    // Two independent reclaim reasons: a pid above every platform's ceiling, and an identity no
    // real `ps -o lstart=` digest can equal — so a recycled pid cannot revive this holder.
    const lock = lockOf(dir);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'holder'), '999999:not-a-live-identity:0');
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, 'reclaimed');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('another publisher still owns');
    // Gone, not merely re-held: the seeded directory could only disappear by being reclaimed,
    // re-acquired under this run's own stamp, and released.
    expect(existsSync(lock)).toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).not.toBe(before);
    expect(readFileSync(ghBody, 'utf8')).toBe('reclaimed');
  });

  it('reclaims a holder-less publish lock once it is older than the acquire grace', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    // A holder-less lock leaves no pid to prove dead, so age is the only self-heal; without it
    // every later publisher spends the full acquire wait and refuses, forever.
    const lock = lockOf(dir);
    mkdirSync(lock, { recursive: true });
    const aged = new Date(Date.now() - 300_000);
    utimesSync(lock, aged, aged);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, 'aged');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('another publisher still owns');
    expect(existsSync(lock)).toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).not.toBe(before);
    expect(readFileSync(ghBody, 'utf8')).toBe('aged');
  });

  it('leaves a publish lock standing when its holder was taken over mid-publication', () => {
    const { dir, env, ghBody } = bodyUpdateRepo();
    // Repointing the stub's lock seam overwrites the holder mid-publication, as a peer that
    // reclaimed it would. Releasing must then be a no-op, or two publishers share the window.
    const lock = lockOf(dir);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, { ...env, GH_INTENT_LOCK: lock }, 'taken over');

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe('taken over');
    expect(existsSync(lock), 'a foreign holder must survive this run releasing').toBe(true);
    expect(readFileSync(join(lock, 'holder'), 'utf8')).toContain(':held');
  });

  // sc-2476: the lock used to live under each checkout's own .devkit, so a publisher in a linked
  // worktree never saw a sibling's lock and could publish a stale PR body over a newer one.
  it('a live publisher in a linked worktree blocks this checkout, whatever each TMPDIR is', () => {
    const { bare, dir, env, g, ghBody, ghLog } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    const sibling = mkdtempSync(join(tmpdir(), 'reship-lock-sibling-'));
    const otherTmp = mkdtempSync(join(tmpdir(), 'reship-lock-tmp-'));
    dirs.push(sibling, otherTmp);
    g(['worktree', 'add', '-q', '--detach', join(sibling, 'wt')]);
    // One lock per clone+branch: the sibling and this checkout must resolve the same path.
    expect(lockOf(join(sibling, 'wt'))).toBe(lockOf(dir));
    holdLive(lockOf(join(sibling, 'wt')));
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    // A divergent TMPDIR (a sandboxed agent) must not split the mutex.
    const r = reship(dir, { ...env, TMPDIR: otherTmp }, 'stale');

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('another publisher still owns origin/feat/pr');
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(before);
    expect(existsSync(ghBody)).toBe(false);
    expect(existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '').not.toContain('pr edit');
  });

  it('keys the lock by the exact branch, so a/b and a-b never share one', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    // The old ${BR//\//-} sanitiser mapped both names to feat-pr.lock, so an unrelated branch's
    // publisher stalled this one for the full wait and then refused it.
    expect(lockOf(dir, 'feat-pr')).not.toBe(lockOf(dir, 'feat/pr'));
    holdLive(lockOf(dir, 'feat-pr'));
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, 'own lock');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('another publisher still owns');
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).not.toBe(before);
    expect(readFileSync(ghBody, 'utf8')).toBe('own lock');
  });

  it('refuses at once, naming the path, when the lock directory cannot be created', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    // A file where the lock root's parent should be: mkdir -p can never succeed. Without a checked
    // mkdir the acquire loop spins its whole budget and then blames a publisher that does not exist.
    writeFileSync(join(commonDir(dir), 'devkit'), 'not a directory\n');
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const started = Date.now();
    const r = reship(dir, env, 'unlockable');

    expect(r.status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.stderr).not.toContain('another publisher still owns');
    expect(r.stderr).toContain('reship-publish');
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(before);
    expect(existsSync(ghBody)).toBe(false);
  });
});
