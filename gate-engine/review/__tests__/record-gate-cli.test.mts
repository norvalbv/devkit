/**
 * `guard-review record-gate <gate>` — the row the generated hook writes after a shell gate blocked,
 * so the ship digest can name fallow or a lint overlay. Spawned because the hook spawns it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mts');

function recordGate(gate: string, ...args: string[]) {
  const sink = path.join(mkdtempSync(path.join(tmpdir(), 'record-gate-')), 'gate-events.jsonl');
  const result = spawnSync('node', [CLI, 'record-gate', gate, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVKIT_GATE_EVENTS: sink,
      DEVKIT_SHIP_ID: 'ship-rg',
      DEVKIT_RUN_ORIGIN: undefined,
    },
  });
  const rows = existsSync(sink) ? readFileSync(sink, 'utf8').trim().split('\n') : [];
  return { status: result.status, rows };
}

describe('guard-review record-gate', () => {
  it.each(['fallow', 'eslint-overlay'])(
    'records %s as a family-less gate_result fail on the ship',
    (gate) => {
      const { status, rows } = recordGate(gate);

      expect(status).toBe(0);
      expect(rows).toHaveLength(1);
      const row = JSON.parse(rows[0] ?? '{}');
      expect(row).toMatchObject({
        type: 'gate_result',
        gate,
        status: 'fail',
        ship_id: 'ship-rg',
        run_origin: 'gate',
      });
      expect(row).not.toHaveProperty('family');
    },
  );

  it.each([
    [
      "fallow's JSON error message after the detail",
      ['{"error":true,"message":"failed to read baseline: No such file","exit_code":2}'],
      'fallow exited 2 without a verdict: failed to read baseline: No such file',
    ],
    ['the bare detail without a JSON report', [], 'fallow exited 2 without a verdict'],
    [
      'the bare detail when the report is not JSON',
      ['Error: boom'],
      'fallow exited 2 without a verdict',
    ],
  ])('--could-not-run records a non-blocking advisory with %s', (_, json, detail) => {
    const { status, rows } = recordGate(
      'fallow',
      '--could-not-run',
      'fallow exited 2 without a verdict',
      ...json,
    );

    expect(status).toBe(0);
    expect(rows).toHaveLength(1);
    const row = JSON.parse(rows[0] ?? '{}');
    expect(row).toMatchObject({
      type: 'advisory_result',
      gate: 'fallow',
      status: 'could_not_run',
      detail,
    });
    expect(row).not.toHaveProperty('family');
  });

  it('refuses a gate the hook never blocks through the shell, writing nothing', () => {
    const { status, rows } = recordGate('review');

    expect(status).toBe(2);
    expect(rows).toEqual([]);
  });
});
