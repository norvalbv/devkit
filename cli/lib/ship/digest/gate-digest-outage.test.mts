import { describe, expect, it } from 'vitest';
import { type GateEvent, render, summarise } from './gate-digest.mts';

const SHIP = 'ship-1';
const ev = (o: GateEvent): GateEvent => ({ ship_id: SHIP, ...o });
const shipResult = (blocked: string | null) => ev({ type: 'ship_result', blocked_gate: blocked });
const inconclusive = (reviewer: string, cause = 'outage', reason = 'judge outage') =>
  ev({
    type: 'review_result',
    reviewer,
    status: 'inconclusive',
    reason,
    inconclusive_cause: cause,
  });
const completenessNoRun = (cause: string) =>
  ev({ type: 'gate_infra_failure', gate: 'completeness', family: 'review', cause });
const judgeFailed = (judge: string, detail: string, outcome = 'transient') =>
  ev({ type: 'judge_exec', judge, outcome, outage_detail: detail });
const digest = (events: GateEvent[]): string => render(summarise(events, SHIP));

const QUOTA = "You've hit your usage limit. Try again in 29 days.";
const REVIEWERS = ['api-security', 'correctness-a', 'correctness-b', 'correctness-c'];
const FLEET = [...REVIEWERS, 'correctness-d', 'conventions'];

describe('a judge outage in the ship digest', () => {
  it('names every fail-closed reviewer as BLOCKED, uncapped, and never says "transient"', () => {
    const text = digest([
      ev({ type: 'ship_attempt' }),
      ...FLEET.map((r) => inconclusive(r)),
      completenessNoRun('transient'),
      shipResult('review'),
    ]);
    for (const r of FLEET) expect(text).toContain(`✗ review:${r} — BLOCKED this run`);
    expect(text).not.toContain('more gate(s)');
    expect(text).not.toContain('transient');
    expect(text).toContain('· completeness — judge failed, cause unclassified');
  });

  it("shows the provider's own words, unwrapping codex's JSON error envelope", () => {
    const envelope = JSON.stringify({ type: 'error', status: 429, error: { message: QUOTA } });
    const text = digest([
      judgeFailed('review:correctness', `${envelope}\nReading additional input from stdin…`),
      judgeFailed('review:completeness', QUOTA, 'rate-limited'),
      inconclusive('correctness'),
      completenessNoRun('rate-limited'),
      shipResult('review'),
    ]);
    expect(text).toContain(`✗ review:correctness — BLOCKED this run — ${QUOTA}`);
    expect(text).toContain(`· completeness — ${QUOTA}`);
  });

  it('attributes an escalation-pass outage to its reviewer', () => {
    const rows = summarise(
      [
        judgeFailed('review:x:escalate', QUOTA),
        inconclusive('x', 'rate-limited'),
        shipResult('review'),
      ],
      SHIP,
    );
    expect(rows).toEqual([expect.objectContaining({ gate: 'review:x', detail: QUOTA })]);
  });

  it('keeps the latest failed spawn, and ignores an earlier attempt in the same ship', () => {
    const rows = summarise(
      [
        judgeFailed('review:x', 'stale words from the previous attempt'),
        ev({ type: 'ship_attempt' }),
        judgeFailed('review:x', 'first spawn'),
        judgeFailed('review:x', QUOTA),
        inconclusive('x'),
        shipResult('review'),
      ],
      SHIP,
    );
    expect(rows[0].detail).toBe(QUOTA);
  });

  it("keeps a response-contract reviewer's own reason over an earlier spawn's outage words", () => {
    const rows = summarise(
      [
        judgeFailed('review:x', QUOTA),
        inconclusive('x', 'response-contract', 'judge returned no VERDICT line'),
        shipResult('review'),
      ],
      SHIP,
    );
    expect(rows[0].detail).toBe('judge returned no VERDICT line');
  });

  it("keeps completeness's own cause when its judge answered but broke the response contract", () => {
    const rows = summarise(
      [judgeFailed('review:completeness', QUOTA), completenessNoRun('response_contract')],
      SHIP,
    );
    expect(rows[0].detail).toBe('response_contract');
  });

  it('collapses a hook replay of one inconclusive reviewer to one row', () => {
    const rows = summarise([inconclusive('x'), inconclusive('x'), shipResult('review')], SHIP);
    expect(rows).toHaveLength(1);
  });

  it('still caps could-not-run rows that did not block', () => {
    const text = digest([
      ...REVIEWERS.map((r) => inconclusive(r)),
      ev({ type: 'gate_result', gate: 'fanout', family: 'deterministic', status: 'fail' }),
      shipResult('deterministic'),
    ]);
    expect(text).toContain('… 1 more gate(s) that could not run');
  });
});
