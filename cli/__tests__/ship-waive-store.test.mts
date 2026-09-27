import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { dropWorktree, scriptPath, seedShipRepo } from './_ship-branch-fixture.mts';

describe('ship — guard-review waive store projection', () => {
  // sc-2175: the gate's reconcile reads the gitignored waive store relative to $WT; unprojected, a
  // recorded waive never cleared a ship while the CLI printed "waived".
  it('links a recorded guard-review waive into the gate worktree (a waive can clear a ship)', () => {
    const waiveHook =
      '[ -e .devkit/correctness-overrides.json ] && grep -q abc123def456 .devkit/correctness-overrides.json && echo WAIVE_SEEN || echo WAIVE_MISSING\nexit 0';
    const { dir, env, git } = seedShipRepo({ hookBody: waiveHook });
    writeFileSync(join(dir, '.gitignore'), '.devkit/correctness-overrides.json\n');
    git(['add', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'ignore waiver store'], { stdio: 'ignore' });
    mkdirSync(join(dir, '.devkit'), { recursive: true });
    writeFileSync(
      join(dir, '.devkit/correctness-overrides.json'),
      '{"abc123def456":{"rationale":"false positive"}}\n',
    );
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/waive-store', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\.devkit\/correctness-overrides\.json .*gitignored cache/);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-waive-store.log'), 'utf8');
    expect(log).toMatch(/WAIVE_SEEN/);
    expect(log).not.toMatch(/WAIVE_MISSING/);
  });
});
