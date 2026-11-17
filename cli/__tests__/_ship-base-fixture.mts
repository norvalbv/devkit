// Fixtures for `ship --base` against an origin whose base branch advances after the caller forked.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import { dirs, GIT_ENV, scriptPath, seedShipRepoLocalRemote } from './_ship-branch-fixture.mts';

export const PREFLIGHT_BLOCK = 'blocked before creating a branch or worktree';

/** A checkout parked at the fork point A, plus an origin whose `base` branch is also at A and ready
 *  to be advanced. `seed(dir)` writes the fork-point content before it is committed and pushed. */
export function seedForked(seed: (dir: string) => void, { hookBody = 'exit 0' } = {}) {
  const { dir, env, git, bare } = seedShipRepoLocalRemote({ hookBody });
  seed(dir);
  git(['add', '-A'], { stdio: 'ignore' });
  git(['commit', '-q', '-m', 'fork point'], { stdio: 'ignore' });
  git(['push', '-q', 'origin', 'work:base'], { stdio: 'ignore' });
  const forkPoint = git(['rev-parse', 'HEAD']).trim();
  return { dir, env, git, bare, forkPoint };
}

/** Advance origin/base with REAL new content, through a throwaway clone. The caller's checkout never
 *  fetches, so it stays at the fork point — which is the whole point of the bug. */
export function advanceBase(
  bare: string,
  mutate: (clone: string) => void,
  message = 'base advances',
) {
  const clone = mkdtempSync(join(tmpdir(), 'shipbase-'));
  dirs.push(clone);
  const cgit = (a: string[]) =>
    execFileSync('git', a, { cwd: clone, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  cgit(['clone', '-q', '--branch', 'base', bare, '.']);
  cgit(['config', 'user.email', 'a@b.c']);
  cgit(['config', 'user.name', 'a']);
  mutate(clone);
  cgit(['add', '-A']);
  cgit(['commit', '-q', '-m', message]);
  cgit(['push', '-q', 'origin', 'base']);
  return execFileSync('git', ['-C', bare, 'rev-parse', 'base'], {
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

export function shipBase(
  dir: string,
  env: NodeJS.ProcessEnv,
  branch: string,
  paths: string[],
  extra = {},
) {
  return spawnSync('/bin/bash', [scriptPath, branch, 'ship it', '--base', 'base', '--', ...paths], {
    cwd: dir,
    input: 'b\n',
    encoding: 'utf8',
    env: { ...env, SHIP_DRY_RUN: '1', ...extra },
  });
}
