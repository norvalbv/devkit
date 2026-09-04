import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GateEvent, readShipEvents, render, summarise } from './gate-digest.mts';

const SHIP = 'ship-1';
const ev = (o: GateEvent): GateEvent => ({ ship_id: SHIP, ...o });
const shipResult = (blocked: string | null) => ev({ type: 'ship_result', blocked_gate: blocked });
const reviewFail = (reviewer: string, reason: string) =>
  ev({ type: 'review_result', reviewer, status: 'fail', reason });
/** The parallel judge rides gate_result with the review family, not the fleet's review_result. */
const completenessFail = (detail: string) =>
  ev({ type: 'gate_result', gate: 'completeness', family: 'review', status: 'fail', detail });

const sinkWith = (lines: string[]): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-digest-')), 'gate-events.jsonl');
  writeFileSync(file, lines.join('\n'));
  return file;
};

describe('summarise', () => {
  it('marks the fleet reviewer blocking and the parallel judge NOT blocking — the sc-2488 case', () => {
    const rows = summarise(
      [
        ev({ type: 'ship_attempt' }),
        reviewFail('correctness', 'the retry loop double-charges'),
        completenessFail('the shipped gate is start/start-step'),
        shipResult('review'),
      ],
      SHIP,
    );
    expect(rows.find((r) => r.gate === 'review:correctness')?.blocking).toBe(true);
    expect(rows.find((r) => r.gate === 'completeness')?.blocking).toBe(false);
  });

  it('marks completeness blocking when it is the only failure in the review family', () => {
    const rows = summarise([completenessFail('no migration'), shipResult('review')], SHIP);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocking).toBe(true);
  });

  it('matches a non-review gate on its exact name', () => {
    const rows = summarise(
      [
        ev({ type: 'gate_result', gate: 'deterministic', status: 'fail', detail: 'guard-size' }),
        ev({ type: 'gate_result', gate: 'decisions', status: 'fail', detail: 'decision smells' }),
        shipResult('deterministic'),
      ],
      SHIP,
    );
    expect(rows.find((r) => r.gate === 'deterministic')?.blocking).toBe(true);
    expect(rows.find((r) => r.gate === 'decisions')?.blocking).toBe(false);
  });

  it('attributes a deterministic sub-gate to the family blocked_gate names', () => {
    const rows = summarise(
      [
        ev({
          type: 'gate_result',
          gate: 'fanout',
          family: 'deterministic',
          status: 'fail',
          detail: 'guard-fanout',
        }),
        ev({
          type: 'gate_result',
          gate: 'anti-slop',
          family: 'deterministic',
          status: 'fail',
          detail: 'anti-slop',
        }),
        shipResult('deterministic'),
      ],
      SHIP,
    );
    expect(rows.every((r) => r.blocking === true)).toBe(true);
  });

  it('nothing is blocking when the run did not stop on a gate (timeout, green, clobber)', () => {
    const rows = summarise([completenessFail('gap'), shipResult('timeout')], SHIP);
    expect(rows[0].blocking).toBe(false);
  });

  it('excludes rows belonging to another ship — the default sink is per-machine', () => {
    const rows = summarise(
      [
        reviewFail('correctness', 'mine'),
        { ship_id: 'ship-2', type: 'review_result', reviewer: 'security', status: 'fail' },
        shipResult('review'),
      ],
      SHIP,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].gate).toBe('review:correctness');
  });

  it('classifies bypasses, infra failures and cache hits without calling them findings', () => {
    const rows = summarise(
      [
        ev({
          type: 'gate_result',
          gate: 'qavis-advisory',
          status: 'could_not_run',
          bypass: 'GUARD_QAVIS_OK',
        }),
        ev({ type: 'gate_infra_failure', gate: 'completeness' }),
        ev({ type: 'cache_hit', judge: 'review:correctness' }),
        shipResult(null),
      ],
      SHIP,
    );
    expect(rows.filter((r) => r.state === 'finding')).toHaveLength(0);
    expect(rows.filter((r) => r.state === 'could-not-run')).toHaveLength(2);
    expect(rows.find((r) => r.gate === 'qavis-advisory')?.detail).toContain('verified nothing');
    expect(rows.filter((r) => r.state === 'cached')).toHaveLength(1);
  });

  it('ignores a PRIOR attempt that reused this ship id, including its ship_result', () => {
    const rows = summarise(
      [
        ev({ type: 'ship_attempt' }),
        reviewFail('correctness', 'the previous attempt, already fixed'),
        ev({ type: 'ship_result', blocked_gate: 'review', exit_code: 1 }),
        ev({ type: 'ship_attempt' }),
        completenessFail('this attempt'),
        ev({ type: 'ship_result', blocked_gate: 'deterministic', exit_code: 1 }),
      ],
      SHIP,
    );

    // Stale findings gone, and attribution read off THIS attempt's result (deterministic), not the
    // earlier one — under which completeness would have been the blocker.
    expect(rows.map((r) => r.gate)).toEqual(['completeness']);
    expect(rows[0].blocking).toBe(false);
  });

  it("keeps a non-run gate's CAUSE, which is the field that says what to do about it", () => {
    const rows = summarise(
      [
        ev({ type: 'gate_infra_failure', gate: 'completeness', cause: 'timeout' }),
        ev({ type: 'gate_infra_failure', gate: 'decisions', cause: 'response_contract' }),
        shipResult('review'),
      ],
      SHIP,
    );

    expect(rows.map((r) => r.detail)).toEqual(['timeout', 'response_contract']);
    expect(render(rows)).toContain('· completeness — timeout');
  });

  // gate-opt-out-is-visible-and-detectable: GUARD_DETERMINISTIC_STRICT=1 turns an opt-out into
  // label(could-not-run) and exit 1, so a could-not-run row CAN be the blocker. Assuming otherwise
  // makes the terminus name the wrong gate on exactly the runs strict mode exists to catch.
  it('attributes a could-not-run row that IS the blocker under strict mode', () => {
    const rows = summarise(
      [
        ev({
          type: 'gate_result',
          gate: 'dup',
          family: 'deterministic',
          status: 'could_not_run',
          detail: 'dup(could-not-run)',
        }),
        shipResult('deterministic'),
      ],
      SHIP,
    );

    expect(rows[0]).toMatchObject({ gate: 'dup', state: 'could-not-run', blocking: true });
    expect(render(rows)).toContain('✗ dup — BLOCKED this run');
  });

  it('leaves an advisory bypass non-blocking when another family stopped the run', () => {
    const rows = summarise(
      [
        ev({
          type: 'gate_result',
          gate: 'qavis-advisory',
          status: 'could_not_run',
          bypass: 'GUARD_QAVIS_OK',
        }),
        shipResult('review'),
      ],
      SHIP,
    );

    expect(rows[0].blocking).toBe(false);
    expect(render(rows)).toContain('· qavis-advisory');
  });

  it('returns nothing for an empty stream', () => {
    expect(summarise([], SHIP)).toEqual([]);
  });

  it('lists a gate once when it judged twice in one run', () => {
    const rows = summarise(
      [completenessFail('gap'), completenessFail('gap'), shipResult('review')],
      SHIP,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].gate).toBe('completeness');
  });
});

describe('render', () => {
  it('names the blocker and flags the non-blocking finding as worth reading', () => {
    const text = render(
      summarise(
        [
          reviewFail('correctness', 'the retry loop double-charges'),
          completenessFail('the shipped gate is start/start-step'),
          shipResult('review'),
        ],
        SHIP,
      ),
      '/repo/.devkit/last-ship-gates-br.log',
    );
    expect(text).toContain('✗ review:correctness — BLOCKED this run');
    expect(text).toContain('⚠ completeness — finding recorded, did NOT block this run');
    expect(text).toContain('the shipped gate is start/start-step');
    expect(text).toContain('Full log: /repo/.devkit/last-ship-gates-br.log');
  });

  it('is silent when there is nothing to report — a clean green ship gains no line', () => {
    expect(render([], '/x.log')).toBe('');
    expect(render(summarise([ev({ type: 'cache_hit', judge: 'r' }), shipResult(null)], SHIP))).toBe(
      '',
    );
  });

  it('collapses cache hits to one line so a --resume digest stays scannable', () => {
    const rows = summarise(
      [
        completenessFail('gap'),
        ...['a', 'b', 'c', 'd'].map((j) => ev({ type: 'cache_hit', judge: `review:${j}` })),
        shipResult('review'),
      ],
      SHIP,
    );
    const text = render(rows);
    expect(text).toContain('4 verdict(s) served from cache');
    expect(text.split('\n').filter((l) => l.includes('cache'))).toHaveLength(1);
  });

  // blocked_gate is 'unknown' whenever the run failed and none of the shell's prose greps matched
  // (sc-2520), and it is absent entirely on a --dry-gates rehearsal, which emits no ship_result.
  // Claiming "did NOT block this run" there states something the digest cannot know.
  it('never claims a finding was non-blocking when attribution is unavailable', () => {
    const unknown = render(
      summarise(
        [
          reviewFail('correctness', 'a real block'),
          ev({ type: 'ship_result', blocked_gate: 'unknown', exit_code: 1 }),
        ],
        SHIP,
      ),
    );
    expect(unknown).not.toContain('did NOT block');
    expect(unknown).toContain('review:correctness');

    const noResult = render(summarise([reviewFail('correctness', 'dry-gates rehearsal')], SHIP));
    expect(noResult).not.toContain('did NOT block');
    expect(noResult).toContain('review:correctness');
  });

  // Reviewer reasons are PROSE and routinely span lines. One newline through untouched turns the
  // digest into the wall of text it exists to replace.
  it('collapses a multi-line reviewer reason onto one line', () => {
    const text = render(
      summarise(
        [reviewFail('correctness', 'line one\nline two\n   line three'), shipResult('review')],
        SHIP,
      ),
    );
    expect(text.split('\n')).toHaveLength(2); // header + exactly one row
    expect(text).toContain('line one line two line three');
  });

  // The deterministic gate emits one row per failing gate and AGGREGATES, so a bad run can produce
  // a dozen at once. Below the remediation that is a second wall of text.
  it('caps the finding list and says how many it withheld', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      ev({ type: 'gate_result', gate: `guard-${i}`, status: 'fail', detail: 'failed' }),
    );
    const skipped = Array.from({ length: 5 }, (_, i) =>
      ev({ type: 'gate_result', gate: `opt-${i}`, status: 'could_not_run', detail: 'opted out' }),
    );
    const text = render(summarise([...many, ...skipped, shipResult('deterministic')], SHIP));

    expect(text.split('\n').length).toBeLessThan(15);
    expect(text).toContain('6 more finding(s)');
    expect(text).toContain('2 more gate(s) that could not run');
    // The header still states the TRUE total — the caps trim the list, never the count.
    expect(text).toContain('(19)');
  });

  it('truncates a long reason instead of pasting a paragraph under the remediation', () => {
    const text = render(summarise([reviewFail('x', 'y'.repeat(400)), shipResult('review')], SHIP));
    expect(text.split('\n')[1].length).toBeLessThan(220);
    expect(text).toContain('…');
  });
});

describe('readShipEvents', () => {
  it('reads this ship rows back off a real sink and ignores foreign ones', () => {
    const file = sinkWith([
      JSON.stringify({ ship_id: 'other', type: 'ship_attempt' }),
      JSON.stringify(ev({ type: 'ship_attempt' })),
      JSON.stringify(completenessFail('gap')),
      JSON.stringify(shipResult('review')),
    ]);
    const events = readShipEvents(file, SHIP);
    expect(events).toHaveLength(3);
    expect(summarise(events, SHIP)[0]).toMatchObject({ gate: 'completeness' });
  });

  it('survives a torn trailing line — the sink is appended to by concurrent judges', () => {
    const file = sinkWith([
      JSON.stringify(ev({ type: 'ship_attempt' })),
      JSON.stringify(completenessFail('gap')),
      '{"ship_id":"ship-1","type":"revi',
    ]);
    expect(readShipEvents(file, SHIP)).toHaveLength(2);
  });

  it('returns [] for an absent sink, an empty path, or an empty ship id', () => {
    expect(readShipEvents('/nonexistent/gate-events.jsonl', SHIP)).toEqual([]);
    expect(readShipEvents('', SHIP)).toEqual([]);
    expect(readShipEvents(sinkWith(['{}']), '')).toEqual([]);
  });

  it('returns [] for a zero-byte sink', () => {
    expect(readShipEvents(sinkWith([]), SHIP)).toEqual([]);
  });

  // The default sink is per-MACHINE, so two Frink panes shipping different repos interleave in it.
  // A backward scan must stop at MY ship_attempt — stopping at whichever attempt it meets first
  // silently truncates this run's findings to whatever sat after a stranger's row.
  it("scans past ANOTHER ship's attempt to reach its own — an interleaved per-machine sink", () => {
    const foreign = (i: number) =>
      JSON.stringify({ ship_id: 'ship-2', type: 'review_result', reason: `${i}`.padEnd(250, 'x') });
    const file = sinkWith([
      JSON.stringify(ev({ type: 'ship_attempt' })),
      JSON.stringify(reviewFail('correctness', 'the EARLY finding, written before the stranger')),
      ...Array.from({ length: 600 }, (_, i) => foreign(i)),
      JSON.stringify({ ship_id: 'ship-2', type: 'ship_attempt' }),
      ...Array.from({ length: 600 }, (_, i) => foreign(i)),
      JSON.stringify(completenessFail('the LATE finding')),
      JSON.stringify(shipResult('review')),
    ]);

    const gates = summarise(readShipEvents(file, SHIP), SHIP)
      .map((r) => r.gate)
      .sort();
    expect(gates).toEqual(['completeness', 'review:correctness']);
  });

  // A single row can exceed the 256 KiB chunk (a reason field is unbounded prose), so a whole read
  // pass can contain no newline at all. The carry must survive that pass intact or the row is lost.
  it('reassembles a single row longer than one read chunk', () => {
    const file = sinkWith([
      JSON.stringify(ev({ type: 'ship_attempt' })),
      JSON.stringify(reviewFail('correctness', 'y'.repeat(700 * 1024))),
      JSON.stringify(shipResult('review')),
    ]);

    const rows = summarise(readShipEvents(file, SHIP), SHIP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gate: 'review:correctness', blocking: true });
  });

  it('finds this attempt at the tail of a sink far larger than one chunk', () => {
    const filler = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ ship_id: `old-${i}`, type: 'review_result', reason: 'x'.repeat(200) }),
    );
    const file = sinkWith([
      ...filler,
      JSON.stringify(ev({ type: 'ship_attempt' })),
      JSON.stringify(completenessFail('gap')),
      JSON.stringify(shipResult('review')),
    ]);
    expect(readShipEvents(file, SHIP)).toHaveLength(3);
  });
});

/**
 * sc-2526. These assert the RENDERED line, not merely that a row was emitted: a row this digest
 * silently dropped would satisfy an emission-only test while the finding stayed just as invisible.
 */
describe('advisory_result', () => {
  const advisory = (gate: string, status: string, detail: string) =>
    ev({ type: 'advisory_result', gate, status, detail });

  it('names a finding below the banner on a GREEN ship, marked non-blocking', () => {
    const rows = summarise(
      [
        ev({ type: 'ship_attempt' }),
        advisory('fallow-advisory', 'finding', 'verdict=warn · 1 duplication introduced'),
        ev({ type: 'ship_result', exit_code: 0, blocked_gate: null }),
      ],
      SHIP,
    );
    expect(rows).toEqual([
      {
        gate: 'fallow-advisory',
        state: 'finding',
        blocking: false,
        detail: 'verdict=warn · 1 duplication introduced',
      },
    ]);
    expect(render(rows)).toContain('⚠ fallow-advisory — finding recorded, did NOT block this run');
  });

  it('can never be rendered as the blocker, even when the run failed unattributably', () => {
    // 'unknown' blocked_gate is the arm that turns every ATTRIBUTABLE row's blocking to null
    // ("finding recorded" with no claim either way). An advisory is knowable on every run.
    const rows = summarise(
      [
        ev({ type: 'ship_attempt' }),
        ev({ type: 'gate_result', gate: 'deterministic', status: 'fail', detail: 'guard-size' }),
        advisory('fallow-advisory', 'finding', 'verdict=fail · 3 complexity introduced'),
        ev({ type: 'ship_result', exit_code: 1, blocked_gate: 'unknown' }),
      ],
      SHIP,
    );
    expect(rows.find((r) => r.gate === 'deterministic')?.blocking).toBeNull();
    expect(rows.find((r) => r.gate === 'fallow-advisory')?.blocking).toBe(false);
    const text = render(rows);
    expect(text).toContain('⚠ fallow-advisory');
    expect(text).not.toContain('fallow-advisory — BLOCKED');
  });

  it('renders a could_not_run advisory as a gate that verified nothing', () => {
    const rows = summarise(
      [advisory('fallow-advisory', 'could_not_run', 'fallow is not on PATH'), shipResult(null)],
      SHIP,
    );
    expect(rows[0].state).toBe('could-not-run');
    expect(render(rows)).toContain('· fallow-advisory — fallow is not on PATH');
  });

  it('stays silent when the advisories had nothing to say — sc-2488s rule', () => {
    expect(render(summarise([ev({ type: 'ship_attempt' }), shipResult(null)], SHIP))).toBe('');
  });

  it('dedupes a repeated advisory but keeps a second, different one', () => {
    const rows = summarise(
      [
        advisory('fallow-advisory', 'finding', 'first'),
        advisory('fallow-advisory', 'finding', 'again'),
        advisory('skill-projection', 'finding', '2 projection drift finding(s)'),
        shipResult(null),
      ],
      SHIP,
    );
    expect(rows.map((r) => r.gate)).toEqual(['fallow-advisory', 'skill-projection']);
  });
});

describe('advisory_result — attempt scoping and crowding', () => {
  const advisory = (gate: string, status: string, detail: string) =>
    ev({ type: 'advisory_result', gate, status, detail });

  it('drops an advisory left by a PRIOR attempt that reused this ship id', () => {
    // DEVKIT_SHIP_ID is inherited across --resume attempts, so one id spans runs in a per-machine
    // sink. Replaying a previous round's finding would send an agent to re-fix what it just fixed.
    const rows = summarise(
      [
        ev({ type: 'ship_attempt' }),
        advisory('fallow-advisory', 'finding', 'the round already fixed'),
        ev({ type: 'ship_result', blocked_gate: 'review', exit_code: 1 }),
        ev({ type: 'ship_attempt' }),
        advisory('fallow-advisory', 'finding', 'this round'),
        ev({ type: 'ship_result', exit_code: 0, blocked_gate: null }),
      ],
      SHIP,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBe('this round');
  });

  it('keeps a finding and a could_not_run for the SAME gate — they are different facts', () => {
    // fallow can report on one advisory while the skill-projection check cannot run, and a single
    // gate can legitimately do both across a retried stage. Collapsing them would hide the weaker.
    const rows = summarise(
      [
        advisory('fallow-advisory', 'finding', 'verdict=fail'),
        advisory('fallow-advisory', 'could_not_run', 'report unreadable'),
        shipResult(null),
      ],
      SHIP,
    );
    expect(rows.map((r) => r.state)).toEqual(['finding', 'could-not-run']);
  });

  it('tells the reader when a crowded run pushed the advisory past the printed cap', () => {
    // Advisories render after the attributable rows, so past the cap the advisory is cut first.
    // Acceptable ONLY because the overflow line says so; silently dropping it restores the bug.
    const many = Array.from({ length: 10 }, (_, i) =>
      ev({ type: 'gate_result', gate: `guard-${i}`, status: 'fail', detail: 'failed' }),
    );
    const text = render(
      summarise(
        [
          ev({ type: 'ship_attempt' }),
          ...many,
          advisory('fallow-advisory', 'finding', 'verdict=fail · 3 complexity introduced'),
          ev({ type: 'ship_result', blocked_gate: 'deterministic', exit_code: 1 }),
        ],
        SHIP,
      ),
    );
    expect(text).toContain('more finding(s) — all of them are in the log');
    expect(text).toContain('Gate findings this run (11)');
  });
});
