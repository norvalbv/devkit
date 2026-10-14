import { describe, expect, it } from 'vitest';
import { DETAIL_CHARS } from './fields.mts';
import { type GateEvent, render, summarise } from './gate-digest.mts';

const SHIP = 'ship-1';
const GATE = 'review:correctness-reviewer';
const RATE = 'gate-engine/judge/codex/rate-limits.mts';
const JUDGE = 'cli/lib/ship/preflight/judge.mts';

const ev = (o: GateEvent): GateEvent => ({ ship_id: SHIP, ...o });
const advisory = (detail: string, gate = GATE): GateEvent =>
  ev({ type: 'advisory_result', gate, status: 'finding', detail });
const digest = (rows: GateEvent[]): string =>
  render(summarise([ev({ type: 'ship_attempt' }), ...rows, ev({ type: 'ship_result' })], SHIP));
const rowOf = (text: string): string =>
  text.split('\n').find((l) => l.includes('correctness-reviewer')) ?? '';

// The incident: three lenses restated one ordering finding, and the distinct defect came third.
const ORDERING = `requests are written without waiting for the initialize reply, so codex_version can be missing from the row`;
const INCIDENT = [
  `${RATE}:300 — ${ORDERING}`,
  `${RATE}:280-313 — ${ORDERING}, seen from the state-transition lens`,
  `${JUDGE}:264 — clip calls .slice on a value usableText passes through unconverted, so a wire planType: 5 throws and the telemetry row is lost`,
  `${RATE}:280 — ${ORDERING}, a third time`,
];

describe('a PASS reviewer with several advisories', () => {
  it('names every cited location ahead of the cut, so the distinct finding is visible', () => {
    const text = digest(INCIDENT.map((d) => advisory(d)));
    expect(text).toContain('Gate findings this run (1 gate(s) / 4 finding(s))');
    const row = rowOf(text);
    const detail = row.slice(row.indexOf('this run: ') + 'this run: '.length);
    expect(detail.length).toBeLessThanOrEqual(DETAIL_CHARS);
    expect(detail.startsWith(`4 advisories at ${RATE}:300,280; ${JUDGE}:264 — `)).toBe(true);
  });

  it('falls back to the count alone when no advisory cites a location', () => {
    const row = rowOf(
      digest(['LOW: gap one', 'LOW: gap two', 'LOW: gap three'].map((d) => advisory(d))),
    );
    expect(row).toContain('this run: 3 advisories — LOW: gap one');
  });

  it('renders a lone advisory exactly as before', () => {
    expect(rowOf(digest([advisory(INCIDENT[2])]))).toBe(
      `   ⚠ ${GATE} — advisory, did NOT block this run: ${INCIDENT[2].slice(0, DETAIL_CHARS - 1)}…`,
    );
  });

  it('counts a replayed identical row once', () => {
    const text = digest([advisory(INCIDENT[0]), advisory(INCIDENT[0]), advisory(INCIDENT[2])]);
    expect(text).toContain('(1 gate(s) / 2 finding(s))');
    expect(rowOf(text)).toContain(`2 advisories at ${RATE}:300; ${JUDGE}:264`);
  });

  it('lists a location an advisory cites past the one-line cut', () => {
    const late = `The ordering note restated at length ${'again '.repeat(25)}is about ${JUDGE}:264`;
    expect(late.indexOf(JUDGE)).toBeGreaterThan(DETAIL_CHARS);
    expect(rowOf(digest([advisory(INCIDENT[0]), advisory(late)]))).toContain(
      `2 advisories at ${RATE}:300; ${JUDGE}:264`,
    );
  });

  it('counts two advisories that differ only past the one-line cut as two', () => {
    const shared = `${RATE}:300 — ${ORDERING}, ${'and more '.repeat(10)}`;
    const text = digest([advisory(`${shared}first`), advisory(`${shared}second`)]);
    expect(text).toContain('(1 gate(s) / 2 finding(s))');
  });

  it("folds a cached lens part's suffixed label into its reviewer's row", () => {
    const text = digest([
      advisory(INCIDENT[0]),
      advisory(INCIDENT[2], `${GATE} [error-and-edge-classification #c1]`),
    ]);
    expect(text).not.toContain('[error-and-edge-classification');
    expect(rowOf(text)).toContain(`⚠ ${GATE} — advisory, did NOT block this run: 2 advisories`);
  });
});
