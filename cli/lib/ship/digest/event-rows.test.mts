import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Buckets, classify } from './event-rows.mts';
import { type GateEvent, readShipEvents } from './gate-digest.mts';

const SHIP = 'ship-1';
/** The fields a malformed sink row carries here; values are untyped, as the JSONL sink is. */
interface SinkRow {
  type?: unknown;
  status?: string;
  reviewer?: unknown;
}

/** Through the real JSONL boundary, so a malformed value reaches classify as it would live. */
const fromSink = (row: SinkRow): GateEvent => {
  const file = join(mkdtempSync(join(tmpdir(), 'event-rows-')), 'gate-events.jsonl');
  writeFileSync(file, JSON.stringify({ ship_id: SHIP, ...row }));
  const events = readShipEvents(file, SHIP);
  expect(events).toHaveLength(1);
  return events[0];
};

const buckets = (): Buckets => ({
  attributable: [],
  advisory: [],
  unverified: [],
  cached: [],
  outageWords: new Map(),
});

/** One event through classify, returning every bucket it could have landed in. */
const sorted = (e: GateEvent) => {
  const b = buckets();
  classify(e, b);
  const { outageWords: _, ...rows } = b;
  return rows;
};

const EMPTY = { attributable: [], advisory: [], unverified: [], cached: [] };

describe('classify dispatch', () => {
  it.each([['__proto__'], ['__defineGetter__'], ['constructor'], [{ toString: 1 }]])(
    'adds nothing and never throws for a sink row typed %j',
    (type) => {
      expect(sorted(fromSink({ type }))).toEqual(EMPTY);
    },
  );

  it.each([['pass'], ['running'], [undefined]])(
    'never stringifies a malformed reviewer on a review_result that adds no row (status %j)',
    (status) => {
      const e = fromSink({ type: 'review_result', status, reviewer: { toString: 1 } });
      expect(sorted(e)).toEqual(EMPTY);
    },
  );

  it('adds no row for a clean review PASS', () => {
    expect(sorted({ type: 'review_result', reviewer: 'correctness', status: 'pass' })).toEqual(
      EMPTY,
    );
  });
});

describe('completeness cache_hit labels', () => {
  const hit: GateEvent = {
    type: 'cache_hit',
    judge: 'review:completeness',
    base_state: 'moved-overlap',
    judged_base_sha: 'a'.repeat(40),
  };

  it("keeps the judge's own label for a base-drift-only hit", () => {
    expect(sorted(hit).unverified).toEqual([
      expect.objectContaining({
        gate: 'review:completeness',
        state: 'unverified',
        blocking: false,
      }),
    ]);
  });

  it('reports a partial-packet hit under the gate name, naming every reason in one row', () => {
    const { unverified } = sorted({ ...hit, diff_matches: false, evidence_omitted_files: 2 });
    expect(unverified).toHaveLength(1);
    expect(unverified[0].gate).toBe('completeness');
    expect(unverified[0].detail).toMatch(
      /^cached PASS over an incomplete packet: .*; cached PASS judged an earlier diff .*; cached PASS judged against aaaaaaaaaaaa /,
    );
  });
});
