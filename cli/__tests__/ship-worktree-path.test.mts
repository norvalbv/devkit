/** Where ship puts its ephemeral gate worktree: a fresh path per run, inside the caller's TMPDIR. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { scriptPath, seedShipRepo, WT_RE } from './_ship-branch-fixture.mts';

function dryShip(dir: string, env: NodeJS.ProcessEnv, shell: string) {
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  return spawnSync('/bin/bash', ['-c', shell, 'ship-wrapper', scriptPath], {
    cwd: dir,
    input: 'b\n',
    encoding: 'utf8',
    env: { ...env, SHIP_DRY_RUN: '1' },
  });
}

describe('ship-branch.sh — ephemeral gate worktree path', () => {
  it('ignores a leftover non-empty dir under the name a pid-keyed path would reuse', () => {
    const { dir, env } = seedShipRepo();
    // `exec` keeps this shell's pid, so a `-$$`-suffixed worktree name lands on the leftover.
    const r = dryShip(
      dir,
      env,
      'd="$TMPDIR/devkit-ship-feat-x-$$"; mkdir -p "$d"; : > "$d/stale"; exec /bin/bash "$1" feat/x t -- note.txt',
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('already exists');
  });

  it("keeps a dry run's worktree inside the caller's TMPDIR, so the fixture's cleanup reaps it", () => {
    const { dir, env } = seedShipRepo();
    const r = dryShip(dir, env, 'exec /bin/bash "$1" feat/kept t -- note.txt');

    expect(r.status, r.stderr).toBe(0);
    const kept = WT_RE.exec(r.stderr)?.[1] ?? '';
    expect(kept.startsWith(`${env.TMPDIR}/devkit-ship-feat-kept.`), kept).toBe(true);
  });
});
