/**
 * A sibling worktree's fetch holds refs/remotes/origin/<base>.lock while origin is ahead of it.
 * Ship pins the base without writing that shared ref, so the lock cannot fail it.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { rewriteRepo } from './_reship-rewrite-fixture.mts';
import {
  dropWorktree,
  GIT_ENV,
  reshipScript,
  scriptPath,
  seedBaseRepo,
} from './_ship-branch-fixture.mts';

/** Rewind the tracking ref so a plain fetch must rewrite it, then hold its lock. */
function holdStaleTrackingRef(
  git: (a: string[]) => string,
  dir: string,
  ref: string,
  staleOid: string,
) {
  git(['update-ref', ref, staleOid]);
  writeFileSync(resolve(dir, git(['rev-parse', '--git-path', `${ref}.lock`]).trim()), '');
}

describe('ship names an unreachable origin as unverifiable, never as a missing branch', () => {
  it.each([
    ['--base', ['--', 'note.txt']],
    ['--from-branch', ['--from-branch']],
  ])('%s', (label, tail) => {
    const { bare, dir, env, git } = seedBaseRepo();
    git(['remote', 'set-url', 'origin', join(dirname(bare), 'gone.git')]);

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/x', 't', '--base', 'studio', ...tail], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${label}: could not verify origin/studio (ls-remote exit 128)`);
    expect(r.stderr).not.toMatch(/no branch origin/);
  });
});

describe('ship pins the base while a sibling fetch holds its tracking-ref lock', () => {
  it('--base resolves origin’s tip instead of reporting a missing branch', () => {
    const { dir, env, git, studioTip } = seedBaseRepo();
    const stale = git(['rev-parse', `${studioTip}^`]).trim();
    holdStaleTrackingRef(git, dir, 'refs/remotes/origin/studio', stale);

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/fresh', 't', '--base', 'studio', '--', 'note.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );
    dropWorktree(git, r.stderr);

    expect(r.stderr).not.toMatch(/no branch origin\/studio/);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['rev-parse', 'feat/fresh^']).trim()).toBe(studioTip);
    expect(git(['rev-parse', 'refs/remotes/origin/studio']).trim()).toBe(stale);
  });

  it('reship --pr --base pins the PR head and base', () => {
    const { bare, dir, env, g, mainTip, oldBase } = rewriteRepo();
    holdStaleTrackingRef(g, dir, 'refs/remotes/origin/main', oldBase);

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

    expect(r.stderr).not.toMatch(/cannot pin origin/);
    expect(r.status, r.stderr).toBe(0);
    const replacement = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(g(['--git-dir', bare, 'rev-parse', `${replacement}^`])).toBe(mainTip);
  });
});
