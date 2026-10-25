import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inconclusive } from './outcome.mts';
import { phaseTimes, recordEvidenceEvent } from './run.mts';

describe('phaseTimes', () => {
  it('times a lone setup phase until now', () => {
    expect(phaseTimes([{ name: 'setup', at: 1_000 }], 7_400)).toBe('setup 6s');
  });

  it('ends each phase where the next begins, the last at now, in whole seconds', () => {
    const marks = [
      { name: 'setup', at: 0 },
      { name: 'red', at: 6_200 },
      { name: 'green', at: 218_700 },
      { name: 'cleanup', at: 259_900 },
    ];
    expect(phaseTimes(marks, 260_300)).toBe('setup 6s, red 213s, green 41s, cleanup 0s');
  });
});

describe('recordEvidenceEvent', () => {
  it('clips a long detail so the row stays one atomic append beside concurrent judges', () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'evidence-row-')), 'gate-events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    vi.stubEnv('DEVKIT_SHIP_ID', 'ship-1');
    const outcome = inconclusive(
      `evidence could not be produced: ${'é'.repeat(5_000)}`,
      'a1',
      null,
    );
    const published = { outcome, tests: 2, publish: 'written' as const, verdict: null };
    const run = { pr: '42', head: 'a1', startedMs: 1_000, failed: false };
    try {
      recordEvidenceEvent(published, run, 6_400);
    } finally {
      vi.unstubAllEnvs();
    }
    const line = readFileSync(sink, 'utf8');
    expect(Buffer.byteLength(line)).toBeLessThan(2048);
    expect(JSON.parse(line)).toMatchObject({ ship_id: 'ship-1', duration_s: 5, test_files: 2 });
  });
});
