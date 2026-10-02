import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockingFields } from '../../../../gate-engine/review/evidence/items.mts';
import { blockingNote } from '../../../../gate-engine/review/overrides.mts';
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

  // sc-2753: a comments-only aggregate publishes blocked_gate='comments' while its row keeps the
  // deterministic family; the gate name must still carry the join, and only for that gate.
  it('attributes a comments-only deterministic failure to blocked_gate comments', () => {
    const comments = (status: string, detail: string) =>
      ev({ type: 'gate_result', gate: 'comments', family: 'deterministic', status, detail });
    for (const row of [
      comments('fail', 'guard-comments'),
      comments('could_not_run', 'guard-comments(unreadable-evidence)'),
    ]) {
      const rows = summarise([row, completenessFail('gap'), shipResult('comments')], SHIP);
      expect(rows.find((r) => r.gate === 'comments')?.blocking).toBe(true);
      expect(rows.find((r) => r.gate === 'completeness')?.blocking).toBe(false);
    }
    const other = summarise(
      [
        ev({ type: 'gate_result', gate: 'size', family: 'deterministic', status: 'fail' }),
        shipResult('comments'),
      ],
      SHIP,
    );
    expect(other[0].blocking).toBe(false);
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

/** sc-3175: a verdict that does not cover the committed diff is named with a bypass's weight. */
describe('unverified verdicts (sc-3175)', () => {
  const degraded = (cause = 'a capture-bearing hunk did not fit the evidence cap') =>
    ev({ type: 'gate_degraded', judge: 'sentry-advisory', cause });
  const intentHit = (diffMatches: boolean) =>
    ev({
      type: 'cache_hit',
      judge: 'review:completeness',
      scope: 'intent',
      diff_matches: diffMatches,
    });
  const green = ev({ type: 'ship_result', exit_code: 0, blocked_gate: null });
  const coverageBypass = ev({
    type: 'gate_result',
    gate: 'coverage',
    status: 'bypassed',
    bypass: 'GUARD_COVERAGE_OK',
    detail: 'coverage(bypassed:GUARD_COVERAGE_OK)',
  });
  const unverifiedLines = (text: string) => text.split('\n').filter((l) => l.startsWith('   · '));

  it('names a self-downgraded judge on a GREEN ship whose sink holds nothing else', () => {
    const text = render(summarise([ev({ type: 'ship_attempt' }), degraded(), green], SHIP));
    expect(text).toContain('Gate findings this run (1)');
    expect(text).toContain(
      '· sentry-advisory — downgraded to advisory: a capture-bearing hunk did not fit the evidence cap — could not block this commit',
    );
  });

  // sc-2317: commit-guard names its own degradation; the sentry wording would misdescribe it.
  it('renders a degraded commit-guard PASS with its own detail as an unverified row', () => {
    const cg = ev({
      type: 'gate_degraded',
      judge: 'commit-guard',
      cause: 'remote embeddings unreachable',
      detail:
        'semantic retrieval unavailable: remote embeddings unreachable — only the deterministic\nmatcher and clone gates checked duplication',
    });
    const text = render(summarise([ev({ type: 'ship_attempt' }), cg, green], SHIP));
    expect(text).toContain('Gate findings this run (1)');
    expect(unverifiedLines(text)).toEqual([
      '   · commit-guard — semantic retrieval unavailable: remote embeddings unreachable — only the deterministic matcher and clone gates checked duplication',
    ]);
    expect(text).not.toContain('could not block this commit');
  });

  it('falls back to the cause wording when a degraded event carries a blank detail', () => {
    const blank = ev({ type: 'gate_degraded', judge: 'commit-guard', cause: 'x', detail: '   ' });
    const text = render(summarise([ev({ type: 'ship_attempt' }), blank, green], SHIP));
    expect(text).toContain(
      '· commit-guard — downgraded to advisory: x — could not block this commit',
    );
  });

  it('moves a PASS judged on an earlier diff out of the ✓ line and names it', () => {
    const text = render(
      summarise(
        [
          ev({ type: 'ship_attempt' }),
          intentHit(false),
          ev({ type: 'cache_hit', judge: 'review:correctness' }),
          green,
        ],
        SHIP,
      ),
    );
    expect(text).toContain('Gate findings this run (1)');
    expect(text).toContain(
      '· completeness — cached PASS judged an earlier diff — this diff was not re-judged',
    );
    expect(text).toContain('✓ 1 verdict(s) served from cache');
  });

  it('keeps an intent hit on a byte-identical diff, and a field-less legacy hit, as honest ✓s', () => {
    const rows = summarise(
      [intentHit(true), ev({ type: 'cache_hit', judge: 'review:completeness' }), green],
      SHIP,
    );
    expect(rows.map((r) => r.state)).toEqual(['cached', 'cached']);
    expect(render(rows)).toBe('');
  });

  it('prints ONE row when pre-commit and commit-msg both replay the same stale verdict', () => {
    const rows = summarise(
      [intentHit(false), intentHit(false), degraded(), degraded(), green],
      SHIP,
    );
    expect(rows.filter((r) => r.state === 'unverified').map((r) => r.gate)).toEqual([
      'completeness',
      'sentry-advisory',
    ]);
  });

  it('closes the sc-2722 run with three unverified entries and one honest ✓ (acceptance)', () => {
    const text = render(
      summarise(
        [
          ev({ type: 'ship_attempt' }),
          coverageBypass,
          degraded(),
          intentHit(false),
          ev({ type: 'cache_hit', judge: 'review:correctness' }),
          green,
        ],
        SHIP,
      ),
      '/x.log',
    );
    expect(text).toContain('Gate findings this run (3)');
    expect(unverifiedLines(text)).toHaveLength(3);
    expect(text).toContain('· coverage — bypassed via GUARD_COVERAGE_OK — verified nothing');
    expect(text).toContain('✓ 1 verdict(s) served from cache');
  });

  it.each(['review', 'sentry', 'unknown'])(
    'is never rendered as the blocker (blocked_gate=%s)',
    (blocked) => {
      const rows = summarise(
        [
          degraded(),
          intentHit(false),
          ev({ type: 'ship_result', exit_code: 1, blocked_gate: blocked }),
        ],
        SHIP,
      );
      expect(rows.map((r) => r.blocking)).toEqual([false, false]);
      expect(render(rows)).not.toContain('BLOCKED');
    },
  );

  it('drops a downgrade from a prior attempt, and one another ship interleaved into the sink', () => {
    const rows = summarise(
      [
        degraded('left by the previous round'),
        ev({ type: 'ship_attempt' }),
        {
          ship_id: 'other-ship',
          type: 'gate_degraded',
          judge: 'sentry-advisory',
          cause: 'foreign',
        },
        green,
      ],
      SHIP,
    );
    expect(rows).toEqual([]);
  });

  it('still names unverified gates when findings overflow the printed cap', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      ev({ type: 'gate_result', gate: `guard-${i}`, status: 'fail', detail: 'failed' }),
    );
    const text = render(
      summarise(
        [
          ev({ type: 'ship_attempt' }),
          ...many,
          degraded(),
          intentHit(false),
          ev({ type: 'ship_result', blocked_gate: 'deterministic', exit_code: 1 }),
        ],
        SHIP,
      ),
    );
    expect(text).toContain('Gate findings this run (12)');
    expect(text).toContain('· sentry-advisory — downgraded to advisory');
    expect(text).toContain('· completeness — cached PASS judged an earlier diff');
  });

  it('renders a wrong-typed or absent cause and judge without throwing', () => {
    // Through the real JSONL boundary: a producer writing a number where a string is declared is
    // exactly the shape parseEvent's SAFETY note promises to survive.
    const sink = sinkWith([
      JSON.stringify({ ship_id: SHIP, type: 'gate_degraded', judge: 'sentry-advisory', cause: 42 }),
      JSON.stringify({ ship_id: SHIP, type: 'gate_degraded' }),
      JSON.stringify({ ship_id: SHIP, type: 'ship_result', exit_code: 0, blocked_gate: null }),
    ]);
    const text = render(summarise(readShipEvents(sink, SHIP), SHIP));
    expect(text).toContain('· sentry-advisory — downgraded to advisory: 42 — could not block');
    expect(text).toContain(
      '· unknown — downgraded to advisory: cause not recorded — could not block',
    );
  });
});

// sc-3468: a review PASS replayed across a rebase. Demotion keys on PATH OVERLAP between the judged
// base and this run's — sha inequality alone stays a ✓ (base-drift-surfaced-at-read-time (b)).
describe('summarise — review PASS judged against an earlier base', () => {
  const SHA_A = 'aaaaaaaaaaaa1111111111111111111111111111';
  const baseHit = (base_state: string, judged: string | null = SHA_A) =>
    ev({
      type: 'cache_hit',
      judge: 'review:correctness-reviewer',
      base_state,
      judged_base_sha: judged,
    });
  const green = ev({ type: 'ship_result', exit_code: 0, blocked_gate: null });

  it('demotes a hit whose reviewed paths changed on the base, naming the judged base', () => {
    const text = render(
      summarise([ev({ type: 'ship_attempt' }), baseHit('moved-overlap'), green], SHIP),
    );
    expect(text).toContain('Gate findings this run (1)');
    expect(text).toContain(
      '· review:correctness-reviewer — cached PASS judged against aaaaaaaaaaaa — reviewed paths changed on the base since; not re-judged',
    );
  });

  it('demotes a hit whose judged base is unknown', () => {
    const rows = summarise([baseHit('unknown', null), green], SHIP);
    expect(rows).toEqual([
      expect.objectContaining({
        state: 'unverified',
        blocking: false,
        detail: 'cached PASS whose judged base is unknown — not re-judged against this base',
      }),
    ]);
  });

  it.each(['moved-clear', 'current'])('keeps a %s hit on the ✓ cache line', (state) => {
    const rows = summarise([baseHit(state), green], SHIP);
    expect(rows.map((r) => r.state)).toEqual(['cached']);
  });

  it('keeps a hit with no base_state (every non-review emitter) on the ✓ cache line', () => {
    const rows = summarise([ev({ type: 'cache_hit', judge: 'decision-alignment' }), green], SHIP);
    expect(rows.map((r) => r.state)).toEqual(['cached']);
  });

  it('never throws on a wrong-typed judged_base_sha read from the sink', () => {
    const sink = sinkWith([
      JSON.stringify({
        ship_id: SHIP,
        type: 'cache_hit',
        judge: 'review:correctness-reviewer',
        base_state: 'moved-overlap',
        judged_base_sha: 12345,
      }),
    ]);
    const rows = summarise(readShipEvents(sink, SHIP), SHIP);
    expect(rows[0]).toMatchObject({ state: 'unverified' });
    expect(rows[0].detail).toContain('judged against an earlier base');
  });

  it('never invokes a row-supplied toString (a malformed object judged_base_sha)', () => {
    const row = {
      ship_id: SHIP,
      type: 'cache_hit',
      judge: 'review:correctness-reviewer',
      base_state: 'moved-overlap',
      judged_base_sha: { toString: 1 },
    };
    const rows = summarise(readShipEvents(sinkWith([JSON.stringify(row)]), SHIP), SHIP);
    expect(rows[0].detail).toContain('judged against an earlier base');
    expect(() => render(rows)).not.toThrow();
  });

  it('shortens a SHA-256 judged base like a SHA-1 one', () => {
    const rows = summarise([baseHit('moved-overlap', 'c'.repeat(64)), green], SHIP);
    expect(rows[0].detail).toContain(`judged against ${'c'.repeat(12)} —`);
  });

  it('names "an earlier base" when the sink row carries no judged sha', () => {
    const rows = summarise([baseHit('moved-overlap', null), green], SHIP);
    expect(rows[0].detail).toContain('judged against an earlier base');
  });

  it('prints ONE row when pre-commit and a re-run both replay the same stale verdict', () => {
    const rows = summarise([baseHit('moved-overlap'), baseHit('moved-overlap'), green], SHIP);
    expect(rows.filter((r) => r.state === 'unverified')).toHaveLength(1);
  });
});

describe('a reviewer blocking on several fingerprints (sc-3212)', () => {
  const REASON =
    'correctness-reviewer: 1 un-overridden finding(s) block this commit. • state-transitions …';
  const blockingFail = (blocking: GateEvent['blocking'], extra: Partial<GateEvent> = {}) =>
    ev({
      type: 'review_result',
      reviewer: 'correctness-reviewer',
      status: 'fail',
      reason: REASON,
      blocking,
      ...extra,
    });
  /** Through the real JSONL boundary, so a hostile `blocking` reaches the reader as it would live. */
  const hostile = (blocking: string): GateEvent[] =>
    readShipEvents(
      sinkWith([
        `{"ship_id":"${SHIP}","type":"review_result","reviewer":"correctness-reviewer","status":"fail","reason":"${REASON}","blocking":${blocking}}`,
        JSON.stringify(shipResult('review')),
      ]),
      SHIP,
    );
  const THREE = [
    { lens: 'state-transitions', fp: 'f5e7af930a7e' },
    { lens: 'error-and-edge-classification', fp: 'a5421e88403c' },
    { lens: 'writer-reader-contracts', fp: '30d8dce61eb3' },
  ];

  it('lists every blocking ID with its lens, and counts findings as well as gates', () => {
    const text = render(
      summarise([ev({ type: 'ship_attempt' }), blockingFail(THREE), shipResult('review')], SHIP),
    );
    expect(text).toContain('Gate findings this run (1 gate(s) / 3 finding(s))');
    for (const { lens, fp } of THREE) {
      expect(text).toContain(
        `✗ review:correctness-reviewer — BLOCKED this run: ${lens} [${fp}] — fix it, or: guard-review waive correctness-reviewer:${lens} ${fp} "why this is not a real defect"`,
      );
    }
  });

  it('prints the exact waive command blockingNote prints, judged base included', () => {
    const base = '5c8482e8fa4e80899f2cd48bdfcd317bb082444f';
    const lens = "docs/it's here.ts@CLAUDE.md:12";
    const blocking = [{ lens, fp: '0123456789ab' }];
    const note = blockingNote('correctness-reviewer', blocking, base);
    const command = /guard-review waive .*"why this is not a real defect"/.exec(note)?.[0];
    expect(command).toContain('--base 5c8482e8fa4e');
    const fields = blockingFields({ blocking: [{ ...blocking[0], base: '5c8482e8fa4e' }] });
    const text = render(
      summarise([blockingFail(fields.blocking, fields), shipResult('review')], SHIP),
    );
    expect(text).toContain(`${command}`);
  });

  it('keeps the ID when the lens is too long for the waive hint', () => {
    const lens = `src/${'nested dir/'.repeat(20)}flows.ts@CLAUDE.md:20`;
    const text = render(
      summarise([blockingFail([{ lens, fp: '0123456789ab' }]), shipResult('review')], SHIP),
    );
    expect(text).toContain('[0123456789ab] — the waive command is in the log');
    expect(text).not.toContain('guard-review waive');
  });

  it('quotes a lens holding spaces or shell metacharacters, as blockingNote does', () => {
    const lens = "docs/my file's.ts@CLAUDE.md:12";
    const text = render(
      summarise([blockingFail([{ lens, fp: '0123456789ab' }]), shipResult('review')], SHIP),
    );
    expect(text).toContain(
      `guard-review waive 'correctness-reviewer:docs/my file'\\''s.ts@CLAUDE.md:12' 0123456789ab`,
    );
  });

  it('decodes a lens holding quotes and backslashes back to the exact finding label', () => {
    const lens = 'docs/a"b\\c.ts@CLAUDE.md:1';
    const rows = summarise(hostile(JSON.stringify([{ lens, fp: '0123456789ab' }])), SHIP);
    expect(rows[0].detail).toContain(`waive 'correctness-reviewer:${lens}' 0123456789ab`);
  });

  it('builds no waive command from a lens the display had to reshape', () => {
    const rows = summarise(
      [blockingFail([{ lens: 'a  b\tc', fp: '0123456789ab' }]), shipResult('review')],
      SHIP,
    );
    expect(rows[0].detail).toBe('a b c [0123456789ab] — the waive command is in the log');
  });

  it('strips terminal control bytes a staged path can smuggle into a lens', () => {
    const lens = 'src/\u001b[2K\u001b[31mok\u0007\u009b.ts@CLAUDE.md:1';
    const rows = summarise(
      [blockingFail([{ lens, fp: '0123456789ab' }]), shipResult('review')],
      SHIP,
    );
    const text = render(rows);
    const controls = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code !== 10 && (code < 32 || (code >= 127 && code < 160));
    });
    expect(controls).toEqual([]);
    expect(rows[0].detail).toMatch(/\[0123456789ab\] — the waive command is in the log$/);
  });

  it('builds no waive command from a lens the emitter had to cut', () => {
    // Through the emitter's own serialization: a 130-char lens fits the digest's line, so only the
    // emitter's `…` marker can tell the reader the label no longer matches the finding.
    const lens = `src/${'a'.repeat(110)}.ts@CLAUDE.md:1`;
    const { blocking } = blockingFields({ blocking: [{ lens, fp: '0123456789ab' }] });
    expect(blocking?.[0].lens.endsWith('…')).toBe(true);
    const text = render(summarise([blockingFail(blocking), shipResult('review')], SHIP));
    expect(text).toContain('[0123456789ab] — the waive command is in the log');
    expect(text).not.toContain('guard-review waive');
  });

  it('drops malformed entries without throwing, and falls back to the prose row when none survive', () => {
    const junk =
      '[null,"x",{"lens":"a","fp":42},{"lens":"b","fp":"0123456789a"},{"lens":{"toString":1},"fp":{"toString":1}}';
    const rows = summarise(hostile(`${junk}]`), SHIP);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toContain('un-overridden finding(s)');
    expect(summarise(hostile('"not-an-array"'), SHIP)).toHaveLength(1);
    const mixed = summarise(hostile(`${junk},{"lens":{"toString":1},"fp":"abcdefabcdef"}]`), SHIP);
    expect(mixed.map((r) => r.fp)).toEqual(['abcdefabcdef']);
    expect(mixed[0].detail).toMatch(/^\(finding\) \[abcdefabcdef\]/);
  });

  it('never caps a blocking ID away, only the non-blocking findings', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      lens: `lens-${i}`,
      fp: i.toString(16).padStart(12, '0'),
    }));
    const advisories = Array.from({ length: 10 }, (_, i) => completenessFail(`note ${i}`));
    const text = render(summarise([blockingFail(ten), ...advisories, shipResult('review')], SHIP));
    for (const { fp } of ten) expect(text).toContain(`[${fp}]`);
    expect(text).toContain('Gate findings this run (2 gate(s) / 11 finding(s))');
  });

  it('never caps a fingerprint away when the run failed unattributably', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      lens: `lens-${i}`,
      fp: i.toString(16).padStart(12, '0'),
    }));
    const advisories = Array.from({ length: 10 }, (_, i) => completenessFail(`note ${i}`));
    for (const blocked of [null, 'unknown']) {
      const result = ev({ type: 'ship_result', blocked_gate: blocked, exit_code: 1 });
      const text = render(summarise([blockingFail(ten), ...advisories, result], SHIP));
      for (const { fp } of ten) expect(text).toContain(`[${fp}]`);
      expect(text).toContain('Gate findings this run (2 gate(s) / 11 finding(s))');
    }
  });

  it('says how many blocking IDs the event had to drop for its byte budget', () => {
    const text = render(
      summarise([blockingFail(THREE, { blocking_omitted: 4 }), shipResult('review')], SHIP),
    );
    expect(text).toContain('+4 more blocking finding(s) — every ID is in the log');
    expect(text).toContain('Gate findings this run (1 gate(s) / 7 finding(s))');
  });

  it('lists the same fingerprints once when the reviewer judged twice in one run', () => {
    const rows = summarise([blockingFail(THREE), blockingFail(THREE), shipResult('review')], SHIP);
    expect(rows.map((r) => r.fp)).toEqual(THREE.map((b) => b.fp));
  });
});
