/** The format stage across ship's two arms (sc-2524): the committing arm must show the step, the
 *  receipt-authorised arm must not run it. Kept out of the two ship suites at their line ceiling. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGuardBlock } from '../lib/husky/husky-block.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  createPreservedCommit,
  dropWorktree,
  GIT_ENV,
  installHook,
  LEAKING_HOOK,
  publishEnvFor,
  scriptPath,
  seedShipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

describe('ship — the format stage is evidence, not inference', () => {
  // The arm that COMMITS: the report must reach the captured log, so "did it format?" has an answer
  // rather than a silence. `run-gates-with-capture.sh` also scrapes 🎨 as a stage anchor.
  it('captures the format step report in the ship gate log', () => {
    const fragment = buildGuardBlock({ biome: true, guards: [] }).match(
      /# devkit:biome-format[\s\S]*?# \/devkit:biome-format/,
    )?.[0];
    expect(fragment, 'the generator must still emit a format fragment').toBeTruthy();
    const { dir, env, git } = seedShipRepo({
      // The ship worktree is a fresh checkout, so the config and stub bin must both be TRACKED to
      // exist there; `bun pm bin` is absent under the fixture PATH, so point the bin dir directly.
      hookBody: `__dk_package_bin_dir="$PWD/.shipbin"\n${fragment}\nexit 0`,
    });
    mkdirSync(join(dir, '.shipbin'), { recursive: true });
    writeFileSync(join(dir, 'biome.jsonc'), '{}\n');
    writeFileSync(join(dir, '.shipbin', 'biome'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.shipbin', 'biome'), 0o755);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'stub'], { cwd: dir });

    writeFileSync(join(dir, 'note.mts'), 'const a  =  1\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/fmt-log', 't', 'note.mts'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-fmt-log.log'), 'utf8');
    expect(log).toContain('🎨 biome formatted and re-staged 1 staged file(s).');
  });

  // The arm that must NOT: sc-2524 read this absence as a bug and asked for a resume-time
  // re-format, which would have invalidated the receipt it resumes on.
  it('runs no format step on a receipt-authorised resume — the preserved commit is published as-is', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    installHook(dir, LEAKING_HOOK);
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    // No note.txt cleanup: the preserved commit and $ROOT's copy must match for the scope check.
    const branch = 'feat/resume-no-fmt';
    const preserved = createPreservedCommit({
      dir,
      env,
      git,
      branch,
      tempPrefix: 'ship-fmt-resume-',
    });
    // Mint the receipt ship would have written: the variable under test is the precondition.
    git(['update-ref', `refs/devkit/ship-receipts/${branch}`, preserved]);

    const retry = spawnSync(
      '/bin/bash',
      // Default base: createPreservedCommit branches off HEAD, so an explicit --base would fail the
      // parent-is-the-divergence check before the resume arm is ever reached.
      [scriptPath, branch, 'ship it', '--', 'note.txt'],
      { cwd: dir, input: 'pr body\n', encoding: 'utf8', env: publishEnv },
    );

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(
      execFileSync('git', ['-C', bare, 'rev-parse', branch], {
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      }).trim(),
    ).toBe(preserved); // no new commit: the exact gated OID is what ships
    // The hook writes the ledger, so its ABSENCE proves no gate — and no format step — ran.
    expect(existsSync(hookCount)).toBe(false);
    const log = join(dir, `.devkit/last-ship-gates-${branch.replace(/\W/g, '-')}.log`);
    if (existsSync(log)) expect(readFileSync(log, 'utf8')).not.toContain('🎨');
  });
});
