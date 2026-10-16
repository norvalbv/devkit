/**
 * A sibling worktree's fetch holds refs/remotes/origin/<branch>.lock while origin is ahead of it.
 * Ship pins the base, or the PR branch under --pr, without writing that shared ref.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  seedReshipRepo,
  WT_RE,
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

/** origin's pr-open moves one commit ahead of the local tracking ref, which a sibling fetch has locked. */
function seedLockedReshipRepo() {
  const s = seedReshipRepo();
  const stale = s.git(['rev-parse', 'HEAD']).trim();
  const ahead = s.git(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'ahead']).trim();
  s.git(['push', '-q', 'origin', `${ahead}:refs/heads/pr-open`], { stdio: 'ignore' });
  holdStaleTrackingRef(s.git, s.dir, 'refs/remotes/origin/pr-open', stale);
  writeFileSync(join(s.dir, 'note.txt'), 'n\n');
  return { ...s, ahead, stale };
}

function reshipPr(s: ReturnType<typeof seedReshipRepo>, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/bash', [reshipScript, 'pr-open', 't', '--pr', '--', 'note.txt'], {
    cwd: s.dir,
    input: '',
    encoding: 'utf8',
    env: { ...s.env, SHIP_DRY_RUN: '1', ...env },
  });
}

/** Dry-run ship --pr, returning the parent of the commit it stacked (empty when none landed). */
function reshipParent(s: ReturnType<typeof seedReshipRepo>) {
  const r = reshipPr(s);
  const wt = WT_RE.exec(r.stderr)?.[1];
  const parent = wt ? s.git(['-C', wt, 'rev-parse', 'HEAD^']).trim() : '';
  dropWorktree(s.git, r.stderr);
  return { r, parent };
}

describe('ship --pr pins the PR branch without the shared tracking ref or FETCH_HEAD', () => {
  it('commits on origin’s tip while a sibling fetch holds the tracking-ref lock', () => {
    const s = seedLockedReshipRepo();
    const { r, parent } = reshipParent(s);

    expect(r.stderr).not.toMatch(/no remote branch/);
    expect(r.status, r.stderr).toBe(0);
    expect(parent).toBe(s.ahead);
    expect(s.git(['rev-parse', 'refs/remotes/origin/pr-open']).trim()).toBe(s.stale);
    const fetchHead = s.git(['rev-parse', '--git-path', 'FETCH_HEAD']).trim();
    expect(existsSync(resolve(s.dir, fetchHead))).toBe(false);
  });

  it('names an unreachable origin with git’s reason, never as a PR to open first', () => {
    const s = seedReshipRepo();
    s.git(['remote', 'set-url', 'origin', join(dirname(s.bare), 'gone.git')]);
    writeFileSync(join(s.dir, 'note.txt'), 'n\n');
    const r = reshipPr(s);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ship --pr: could not verify origin/pr-open (ls-remote exit 128)');
    expect(r.stderr).toMatch(/gone\.git/);
    expect(r.stderr).not.toMatch(/open the PR first/);
  });

  it('stacks on the branch, not on an origin tag of the same name', () => {
    const s = seedReshipRepo();
    writeFileSync(join(s.dir, 'note.txt'), 'n\n');
    const branchTip = s.git(['rev-parse', 'HEAD']).trim();
    const tagged = s.git(['commit-tree', 'HEAD^{tree}', '-m', 'unrelated tag']).trim();
    s.git(['push', '-q', 'origin', `${tagged}:refs/tags/pr-open`], { stdio: 'ignore' });

    const { r, parent } = reshipParent(s);

    expect(r.status, r.stderr).toBe(0);
    expect(parent).toBe(branchTip);
    expect(s.git(['tag', '--list', 'pr-open']).trim()).toBe('');
  });

  it('names a failed object fetch with git’s reason after the branch was advertised', () => {
    const s = seedReshipRepo();
    writeFileSync(join(s.dir, 'note.txt'), 'n\n');
    const bin = join(s.dir, 'failing-fetch-bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/bash',
        'for a in "$@"; do [ "$a" != fetch ] || { echo "fatal: simulated pack failure" >&2; exit 1; }; done',
        'exec "$REAL_GIT" "$@"',
      ].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).stdout.trim();

    const r = reshipPr(s, { PATH: `${bin}:${process.env.PATH ?? ''}`, REAL_GIT: realGit });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      'ship --pr: could not fetch the advertised origin/pr-open commit (fetch exit 1)',
    );
    expect(r.stderr).toContain('  fatal: simulated pack failure');
    expect(r.stderr).not.toMatch(/open the PR first/);
  });
});
