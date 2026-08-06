import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retainNewest } from '../store-retention.mts';

// DEVKIT_SHIP_ID puts every case on the ship path, so the suite-wide DEVKIT_NO_TELEMETRY=1 default
// in vitest.setup never suppresses the emit under test. Same harness as gate-events.test.mts.
const SHIP_ENV = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID'];

describe('retainNewest', () => {
  const saved: Record<string, string | undefined> = {};
  let sink: string;

  beforeEach(() => {
    for (const k of SHIP_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    sink = path.join(mkdtempSync(path.join(tmpdir(), 'store-retention-')), 'gate-events.jsonl');
    process.env.DEVKIT_SHIP_ID = 'ship-retention';
    process.env.DEVKIT_GATE_EVENTS = sink;
  });
  afterEach(() => {
    for (const k of SHIP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const events = () =>
    existsSync(sink)
      ? readFileSync(sink, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  const numbered = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`k-${i}`, { at: String(i).padStart(4, '0') }]),
    );

  it('keeps the newest entries by `at` and drops the oldest', () => {
    const kept = retainNewest(numbered(5), 3);
    expect(Object.keys(kept).sort()).toEqual(['k-2', 'k-3', 'k-4']);
  });

  it('emits one cache_evicted naming the store, the drop count and what survived', () => {
    retainNewest(numbered(105), 100, '/repo/.devkit/review-cache.json');
    const evicted = events().filter((e) => e.type === 'cache_evicted');
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({
      type: 'cache_evicted',
      store: 'review-cache.json',
      dropped: 5,
      retained: 100,
      ship_id: 'ship-retention',
    });
  });

  // The whole point of the event is that a drop is no longer silent — so the quiet case has to stay
  // quiet, or every write would look like an eviction and the signal would be worthless.
  it('stays silent when nothing is dropped, including exactly at the cap', () => {
    retainNewest(numbered(100), 100, '/repo/.devkit/review-cache.json');
    retainNewest(numbered(7), 100, '/repo/.devkit/review-cache.json');
    expect(events().filter((e) => e.type === 'cache_evicted')).toHaveLength(0);
  });

  it('labels the store `unknown` rather than throwing when no file is passed', () => {
    retainNewest(numbered(3), 1);
    expect(events().filter((e) => e.type === 'cache_evicted')[0]).toMatchObject({
      store: 'unknown',
      dropped: 2,
    });
  });

  // Entries missing `at` sort last under the existing comparator (String(undefined ?? '') === '').
  // Pinned because a verdict written by an older devkit has no `at`, and it must be the first thing
  // evicted rather than crashing the sort or displacing a dated PASS.
  it('treats an undated entry as oldest', () => {
    const kept = retainNewest({ dated: { at: '2026-08-05' }, undated: {} }, 1);
    expect(Object.keys(kept)).toEqual(['dated']);
  });
});
