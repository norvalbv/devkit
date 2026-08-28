import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runQavisAdvisory } from '../../qavis-advisory/check.mts';
import { runCompleteness } from '../../review/completeness.mts';
import { skipReason } from '../../sentry/check-sentry.mts';
import { emitGateBypass } from '../gate-events.mts';

// Sink env matches judge-exec-telemetry.test.mts: vitest.setup holds DEVKIT_NO_TELEMETRY=1
// suite-wide; an explicit DEVKIT_GATE_EVENTS + DEVKIT_SHIP_ID opts these tests back in.
const ENV_KEYS = [
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'GUARD_QAVIS_OK',
  'GUARD_NO_QAVIS_ADVISORY',
  'GUARD_NO_COMPLETENESS',
  'GUARD_NO_SENTRY_JUDGE',
];
const saved: Record<string, string | undefined> = {};
let dir: string;
let sink: string;

function events() {
  try {
    return readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(path.join(tmpdir(), 'gate-bypass-'));
  sink = path.join(dir, 'gate-events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-bypass';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('gate bypass telemetry', () => {
  it('emitGateBypass emits a could_not_run gate_result carrying the flag', () => {
    emitGateBypass('structure-lint', 'GUARD_STRUCTURE_OK');
    const [ev] = events();
    expect(ev).toMatchObject({
      type: 'gate_result',
      gate: 'structure-lint',
      status: 'could_not_run',
      bypass: 'GUARD_STRUCTURE_OK',
      detail: 'structure-lint(bypassed:GUARD_STRUCTURE_OK)',
      ship_id: 'ship-bypass',
    });
  });

  it('qavis-advisory records GUARD_QAVIS_OK and GUARD_NO_QAVIS_ADVISORY under their own names', () => {
    // The recipe makes this a qavis repo — a flag in a NON-qavis repo must record nothing (below).
    mkdirSync(path.join(dir, '.qavis'), { recursive: true });
    writeFileSync(path.join(dir, '.qavis', 'recipe.json'), '{}\n');
    process.env.GUARD_QAVIS_OK = '1';
    expect(runQavisAdvisory(dir)).toBe(0);
    delete process.env.GUARD_QAVIS_OK;
    process.env.GUARD_NO_QAVIS_ADVISORY = '1';
    expect(runQavisAdvisory(dir)).toBe(0);
    expect(events().map((e) => e.bypass)).toEqual(['GUARD_QAVIS_OK', 'GUARD_NO_QAVIS_ADVISORY']);
  });

  it('a qavis flag in a repo WITHOUT a recipe records no phantom bypass', () => {
    process.env.GUARD_QAVIS_OK = '1';
    expect(runQavisAdvisory(dir)).toBe(0);
    expect(events()).toEqual([]);
  });

  it('completeness records GUARD_NO_COMPLETENESS at its skip', async () => {
    process.env.GUARD_NO_COMPLETENESS = '1';
    const msgFile = path.join(dir, 'msg');
    writeFileSync(msgFile, 'feat: x\n');
    expect(await runCompleteness(msgFile, dir)).toBe(0);
    const bypass = events().find((e) => e.bypass === 'GUARD_NO_COMPLETENESS');
    expect(bypass).toMatchObject({ gate: 'completeness', status: 'could_not_run' });
  });

  it('sentry records GUARD_NO_SENTRY_JUDGE at its skip', () => {
    process.env.GUARD_NO_SENTRY_JUDGE = '1';
    expect(skipReason('feat: adds a network call')).toContain('GUARD_NO_SENTRY_JUDGE');
    const bypass = events().find((e) => e.bypass === 'GUARD_NO_SENTRY_JUDGE');
    expect(bypass).toMatchObject({ gate: 'sentry', status: 'could_not_run' });
  });
});
