import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { dropWorktree, scriptPath, seedBaseRepo } from './_ship-branch-fixture.mts';

// sc-2480: under --base the caller's worktree HEAD is never the base the gates judge, and
// ship-branch.sh's own $SOURCE_HEAD is empty on the explicit-paths arm.
describe('the caller worktree HEAD reaches the gates (sc-2480)', () => {
  it('ship exports DEVKIT_SHIP_SOURCE_HEAD, distinct from the base it cut from', () => {
    const { dir, env, git, studioTip } = seedBaseRepo({
      hookBody: 'echo "HOOK_SRC=$DEVKIT_SHIP_SOURCE_HEAD"',
    });
    const callerHead = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(callerHead).not.toBe(studioTip);
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/source-head-flag', 't', '--base', 'studio', '--', 'note.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(
      join(dir, '.devkit/last-ship-gates-feat-source-head-flag.log'),
      'utf8',
    );
    expect(log).toContain(`HOOK_SRC=${callerHead}`);
  });
});
