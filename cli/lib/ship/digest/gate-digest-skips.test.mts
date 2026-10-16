import { describe, expect, it } from 'vitest';
import { type GateEvent, render, summarise } from './gate-digest.mts';

const SHIP = 'ship-1';
const ev = (o: GateEvent): GateEvent => ({ ship_id: SHIP, ...o });
const attempt = ev({ type: 'ship_attempt' });
const passed = ev({ type: 'ship_result', blocked_gate: null, exit_code: 0 });
const skipped = (reviewer: string | null, reason: string): GateEvent =>
  // SAFETY: the emitter writes `reviewer: null` for a fleet-wide skip; GateEvent types it optional.
  ev({ type: 'review_skipped', reviewer: reviewer as string, reason });
const digest = (events: GateEvent[]): string => render(summarise(events, SHIP));

describe('env-authorized skips in the ship digest', () => {
  it('names a GUARD_REVIEW_SKIP reviewer on a green ship', () => {
    const text = digest([attempt, skipped('conventions-reviewer', 'GUARD_REVIEW_SKIP'), passed]);
    expect(text).toContain(
      '· review:conventions-reviewer — bypassed via GUARD_REVIEW_SKIP — verified nothing',
    );
  });

  it('never marks a skipped reviewer BLOCKED when another reviewer blocks the review family', () => {
    const rows = summarise(
      [
        attempt,
        skipped('conventions-reviewer', 'GUARD_REVIEW_SKIP'),
        ev({ type: 'review_result', reviewer: 'correctness-reviewer', status: 'fail' }),
        ev({ type: 'ship_result', blocked_gate: 'review', exit_code: 1 }),
      ],
      SHIP,
    );
    const skip = rows.find((r) => r.gate === 'review:conventions-reviewer');
    expect(skip?.blocking).toBe(false);
    expect(rows.find((r) => r.gate === 'review:correctness-reviewer')?.blocking).toBe(true);
  });

  it('keeps a skip non-blocking when the run cannot be attributed', () => {
    const rows = summarise([attempt, skipped('x', 'GUARD_REVIEW_SKIP')], SHIP);
    expect(rows).toEqual([expect.objectContaining({ gate: 'review:x', blocking: false })]);
  });

  it('labels GUARD_NO_REVIEW as the whole review gate, never review:null', () => {
    const text = digest([attempt, skipped(null, 'gate_disabled'), passed]);
    expect(text).toContain('· review — bypassed via GUARD_NO_REVIEW — verified nothing');
    expect(text).not.toContain('review:null');
  });

  it('names a fleet skipped by no-LLM mode, which an env flag or the repo config can set', () => {
    expect(digest([attempt, skipped(null, 'no_llm'), passed])).toContain(
      '· review — bypassed via GUARD_DECISION_NO_LLM or noLlm config — verified nothing',
    );
  });

  it('never hides a skip behind the cap on gates that could not run', () => {
    const outages = ['a', 'b', 'c'].map((gate) =>
      ev({ type: 'gate_infra_failure', gate, cause: 'timeout' }),
    );
    const skips = ['x', 'y'].map((r) => skipped(r, 'GUARD_REVIEW_SKIP'));
    const text = digest([attempt, ...outages, ...skips, passed]);
    expect(text).toContain('· review:x — bypassed via GUARD_REVIEW_SKIP');
    expect(text).toContain('· review:y — bypassed via GUARD_REVIEW_SKIP');
  });

  it('names a decisions PASS that GUARD_NO_LOG produced', () => {
    const noLog = ev({
      type: 'gate_result',
      gate: 'decisions',
      status: 'pass',
      detail: 'bypassed (GUARD_NO_LOG)',
      bypass: 'GUARD_NO_LOG',
    });
    expect(digest([attempt, noLog, passed])).toContain(
      '· decisions — bypassed via GUARD_NO_LOG — verified nothing',
    );
  });

  it('prints one line for a skip both hooks recorded', () => {
    const row = skipped('x', 'GUARD_REVIEW_SKIP');
    const text = digest([attempt, row, row, passed]);
    expect(text.match(/review:x/g)).toHaveLength(1);
  });

  it('stays silent for skips no env flag caused, and for a clean run', () => {
    const events = [
      attempt,
      skipped('x', 'not_selected'),
      skipped('y', 'empty_roots'),
      skipped('z', 'recheck'),
      skipped('w', 'mass_deletion'),
      ev({ type: 'gate_result', gate: 'decisions', status: 'pass', detail: 'routine ✓' }),
      passed,
    ];
    expect(digest(events)).toBe('');
  });
});
