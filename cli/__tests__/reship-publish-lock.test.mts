import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { bodyUpdateRepo, GIT_ENV, reshipScript } from './_ship-branch-fixture.mts';

// reship.sh's per-branch publication lock (rewrite_publish_lock_acquire / _release): its reclaim
// arms decide whether a killed publisher wedges the branch or a live one loses mutual exclusion.
describe('reship.sh — the rewrite publication lock', () => {
  const lockOf = (dir: string) => join(dir, '.devkit/reship-rewrite-publish/feat-pr.lock');

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
      { cwd: dir, input: 'body\n', encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env } },
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
});
