/** A stopped ship can strand its branch with no worktree, hence no run record. Ship reclaims it only
 *  when the drop is lossless; every guard below keeps a branch that might carry anything. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  installHook,
  localBranchExists,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const RECLAIM_LINE = 'held no commit of its own over origin/work';

function runShip(dir, env, branch, extraEnv = {}) {
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  return spawnSync('/bin/bash', [scriptPath, branch, 'ship it', 'note.txt'], {
    cwd: dir,
    input: 'pr body\n',
    encoding: 'utf8',
    env: { ...publishEnvFor(dir, env).publishEnv, ...extraEnv },
  });
}

/** A stopped ship's leftover: a local branch at the base tip, no worktree, no record. */
function strandedBranch(branch) {
  const seeded = seedShipRepoLocalRemote();
  seeded.git(['branch', branch, 'work'], { stdio: 'ignore' });
  return { ...seeded, tip: seeded.git(['rev-parse', branch]).trim() };
}

describe('ship-branch.sh — reclaiming an empty branch no record names', () => {
  it('deletes and recreates a branch the base already contains, logging the old tip once', () => {
    const { dir, env, bare, tip } = strandedBranch('feat/stranded');

    const r = runShip(dir, env, 'feat/stranded');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.split(RECLAIM_LINE)).toHaveLength(2);
    expect(r.stderr).toContain(`(tip ${tip.slice(0, 7)})`);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(remoteBranchExists(bare, 'feat/stranded')).toBe(true);
  });

  it('leaves a branch another checkout holds untouched', () => {
    const { dir, env, git, tip } = strandedBranch('feat/held');
    const holder = mkdtempSync(join(tmpdir(), 'ship-holder-'));
    dirs.push(holder);
    rmSync(holder, { recursive: true, force: true });
    git(['worktree', 'add', '-q', holder, 'feat/held'], { stdio: 'ignore' });

    const r = runShip(dir, env, 'feat/held');

    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain(RECLAIM_LINE);
    expect(git(['rev-parse', 'feat/held']).trim()).toBe(tip);
  });

  it('keeps a branch with an upstream configured', () => {
    const { dir, env, git } = strandedBranch('feat/tracked');
    git(['config', 'branch.feat/tracked.merge', 'refs/heads/work'], { stdio: 'ignore' });

    const r = runShip(dir, env, 'feat/tracked');

    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain(RECLAIM_LINE);
    expect(localBranchExists(git, 'feat/tracked')).toBe(true);
  });

  it('keeps a branch whose reflog shows history beyond its creation', () => {
    const { dir, env, git } = strandedBranch('feat/moved');
    const detour = git(['commit-tree', 'work^{tree}', '-p', 'work', '-m', 'detour']).trim();
    git(['update-ref', '-m', 'out', 'refs/heads/feat/moved', detour], { stdio: 'ignore' });
    git(['update-ref', '-m', 'back', 'refs/heads/feat/moved', 'work'], { stdio: 'ignore' });

    const r = runShip(dir, env, 'feat/moved');

    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain(RECLAIM_LINE);
    expect(localBranchExists(git, 'feat/moved')).toBe(true);
  });

  it('keeps the strict new-branch rule on a dry run', () => {
    const { dir, env, git } = strandedBranch('feat/dry');

    const r = runShip(dir, env, 'feat/dry', { SHIP_DRY_RUN: '1' });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('branch already exists: feat/dry');
    expect(localBranchExists(git, 'feat/dry')).toBe(true);
  });

  // cleanup() now drops the ref BEFORE the worktree, so a kill between them leaves this state:
  // a recorded worktree whose branch is already gone. The existing orphan reclaim must finish it.
  it('ships after a cleanup interrupted between deleting the branch and removing the worktree', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const wt = mkdtempSync(join(tmpdir(), 'ship-halfclean-'));
    dirs.push(wt);
    rmSync(wt, { recursive: true, force: true });
    git(['worktree', 'add', '-q', '-b', 'feat/halfclean', wt, 'work'], { stdio: 'ignore' });
    const base = git(['rev-parse', 'work']).trim();
    const admin = git(['-C', wt, 'rev-parse', '--absolute-git-dir']).trim();
    writeFileSync(
      join(admin, 'devkit-ship-run'),
      `v=1\nbranch=feat/halfclean\nwt=${wt}\npid=999999\nbase=${base}\nbranch_created=1\nmode=live\n`,
    );
    git(['update-ref', '-d', 'refs/heads/feat/halfclean', base], { stdio: 'ignore' });

    const r = runShip(dir, env, 'feat/halfclean');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('reclaimed the worktree of a ship that was killed');
    expect(git(['worktree', 'list'])).not.toContain(wt);
    expect(remoteBranchExists(bare, 'feat/halfclean')).toBe(true);
  });
  // The banner a stopped ship prints says `devkit ship --resume <br>`, so that is the realistic retry.
  it('reclaims the stranded branch on --resume and replays the recorded invocation', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    installHook(dir, 'exit 1');
    const first = runShip(dir, env, 'feat/resumed');
    expect(first.status).not.toBe(0);
    expect(localBranchExists(git, 'feat/resumed')).toBe(false); // cleanup dropped its empty branch
    git(['branch', 'feat/resumed', 'work'], { stdio: 'ignore' });
    installHook(dir, 'exit 0');

    const r = spawnSync('/bin/bash', [scriptPath, '--resume', 'feat/resumed'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: publishEnvFor(dir, env).publishEnv,
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(RECLAIM_LINE);
    expect(remoteBranchExists(bare, 'feat/resumed')).toBe(true);
  });

  // main usually moves between a stopped ship and its retry: the tip is then an ancestor, not equal.
  it('reclaims when origin/<base> advanced past the stranded tip', () => {
    const { dir, env, git, bare, tip } = strandedBranch('feat/behind');
    writeFileSync(join(dir, 'other.txt'), 'parallel agent\n');
    git(['add', 'other.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'parallel agent lands'], { stdio: 'ignore' });
    git(['push', '-q', 'origin', 'work:work'], { stdio: 'ignore' });
    expect(git(['rev-parse', 'origin/work']).trim()).not.toBe(tip);

    const r = runShip(dir, env, 'feat/behind');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`(tip ${tip.slice(0, 7)})`);
    expect(remoteBranchExists(bare, 'feat/behind')).toBe(true);
  });

  it('deletes nothing when the worktree list could not be read in full', () => {
    const { dir, git, tip } = strandedBranch('feat/torn');
    const lib = dirname(scriptPath);
    const reclaim = (stub) =>
      execFileSync(
        '/bin/bash',
        [
          '-c',
          `. "${lib}/worktree-registry.sh"; . "${lib}/reclaim-orphan-worktrees.sh"; ${stub}
ship_reclaim_empty_branch "$PWD" feat/torn work`,
        ],
        { cwd: dir, encoding: 'utf8' },
      );

    reclaim("worktree_registry_stream() { printf 'devkit-worktree-list-status 128\\0'; }");
    expect(git(['rev-parse', 'feat/torn']).trim()).toBe(tip);
    reclaim(':'); // control: the same call with a complete list does delete it
    expect(localBranchExists(git, 'feat/torn')).toBe(false);
  });
});
