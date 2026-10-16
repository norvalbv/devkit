import { describe, expect, it } from 'vitest';
import { shipEventRow } from './ship-intent-event.mts';

describe('shipEventRow', () => {
  it('types the ship_pr number, and nulls a missing one', () => {
    expect(shipEventRow('pr', { pr_url: 'https://x/pull/42', pr_number: '42' })).toEqual({
      type: 'ship_pr',
      pr_url: 'https://x/pull/42',
      pr_number: 42,
    });
    expect(shipEventRow('pr', { pr_url: '', pr_number: '' })).toMatchObject({ pr_number: null });
  });

  it("reads the shell's bare null as no blocked gate", () => {
    expect(shipEventRow('result', { blocked_gate: 'null', exit_code: '0' })).toMatchObject({
      blocked_gate: null,
      exit_code: 0,
      timed_out: false,
    });
    expect(shipEventRow('result', { blocked_gate: 'review', exit_code: '1' })).toMatchObject({
      blocked_gate: 'review',
      exit_code: 1,
    });
  });

  // No spawned test reaches the 124/137 arm: a string 'true' would read as a non-timeout downstream.
  it('records a supervisor timeout as a boolean timed_out', () => {
    expect(
      shipEventRow('result', { exit_code: '124', timed_out: 'true', blocked_gate: 'timeout' }),
    ).toMatchObject({ exit_code: 124, timed_out: true, blocked_gate: 'timeout' });
  });

  it('writes nothing for an unknown row kind', () => {
    expect(shipEventRow('bogus', {})).toBeNull();
  });
});
