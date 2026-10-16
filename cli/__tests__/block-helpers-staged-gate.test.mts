/**
 * A shell gate's block (fallow, the eslint/biome overlays) names itself: a gate_result row through
 * `guard-review record-gate`, and on commit/ship the line ship's blocked_gate classifier reads.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DK_GATE_BLOCK_HELPERS } from '../lib/husky/gate-policy/block-helpers.mts';
import { DK_NO_GIT_ENV_HELPER } from '../lib/husky/review-fragments.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const SHELLS = ['sh', 'dash'].filter(
  (shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0,
);
const SENTINEL = '✗ staged gate blocked: fallow (its report is above)';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A bin dir whose guard-review records its argv, then exits with `rc`; `null` = no guard-review. */
function binDir(rc: number | null) {
  const dir = mkdtempSync(join(tmpdir(), 'dk-block-'));
  dirs.push(dir);
  const calls = join(dir, 'calls');
  if (rc !== null) {
    const bin = join(dir, 'guard-review');
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$*" >> '${calls}'\necho noise; echo noise >&2\nexit ${rc}\n`,
    );
    chmodSync(bin, 0o755);
  }
  return { dir, calls };
}

function block(shell: string, gate: string, mode: string, rc: number | null = 0) {
  const { dir, calls } = binDir(rc);
  const script = [
    DK_NO_GIT_ENV_HELPER,
    `__dk_package_bin_dir='${dir}'`,
    DK_GATE_BLOCK_HELPERS,
    `__dk_block_deterministic ${gate}`,
    'echo "deferred:$dk_review_failed_gates"',
  ].join('\n');
  const result = spawnSync(shell, ['-e', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_RUN_MODE: mode },
  });
  return { ...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

describe.each(SHELLS)('__dk_block_deterministic under %s', (shell) => {
  it.each(['commit', 'ship'])('a %s block names the shell gate and records its row', (mode) => {
    const r = block(shell, 'fallow', mode);

    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(SENTINEL);
    expect(r.stdout).toBe('');
    expect(r.calls).toBe('record-gate fallow\n');
  });

  it('a dry-gates rehearsal records the row and defers, printing no sentinel', () => {
    const r = block(shell, 'eslint-overlay', 'dry-gates');

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('deferred: eslint-overlay');
    expect(r.calls).toBe('record-gate eslint-overlay\n');
  });

  it('leaves guard-deterministic to name itself', () => {
    const r = block(shell, 'deterministic-gates', 'commit');

    expect(r.status).toBe(1);
    expect(r.stderr).toBe('');
    expect(r.calls).toBe('');
  });

  it.each([
    ['a failing', 2],
    ['a missing', null],
  ])('%s guard-review changes neither the verdict nor the output', (_label, rc) => {
    const r = block(shell, 'fallow', 'commit', rc);

    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(SENTINEL);
    expect(r.stdout).toBe('');
  });
});
