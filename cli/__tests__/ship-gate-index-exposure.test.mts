/** What the ship gate worktree's INDEX exposes to the gates, and what the commit carries (sc-1959).
 *  Sibling of ship-branch.test.mts, which has no headroom left. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { dropWorktree, installHook, scriptPath, seedShipRepo } from './_ship-branch-fixture.mts';

describe('ship-branch.sh — gate worktree index exposure', () => {
  it('exposes tracked paths outside the briefed set to the gates, without committing them', () => {
    const { dir, env, git } = seedShipRepo();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/keep.txt'), 'tracked at base, never briefed\n');
    git(['add', 'docs/keep.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'track keep'], { stdio: 'ignore' });
    // Armed only now: the seed commit above runs the hook too, and a probe there proves nothing about
    // the ship worktree (_ship-branch-fixture.mts installHook).
    installHook(dir, 'git cat-file -e :docs/keep.txt && echo UNBRIEFED_INDEX_OK\nexit 0');
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/index-scope', 't', '--', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-index-scope.log'), 'utf8');
    expect(log).toMatch(/UNBRIEFED_INDEX_OK/);
    expect(git(['show', '--name-only', '--format=', 'feat/index-scope']).trim()).toBe('note.txt');
  });
});
