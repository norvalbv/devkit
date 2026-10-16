import { describe, expect, it } from 'vitest';
import { type GateEvent, render, summarise } from './gate-digest.mts';

const SHIP = 'ship-1';
const ev = (o: GateEvent): GateEvent => ({ ship_id: SHIP, ...o });
const digest = (events: GateEvent[]): string =>
  render(summarise([ev({ type: 'ship_attempt' }), ...events], SHIP));
/** The row `guard-review record-gate` writes when the hook's fallow audit blocked. */
const FALLOW = ev({
  type: 'gate_result',
  gate: 'fallow',
  status: 'fail',
  detail: 'its report is above in the log',
});

describe('a shell gate that blocked the run', () => {
  it('is the only BLOCKED row, beside a deterministic gate that opted out', () => {
    const text = digest([
      ev({
        type: 'gate_result',
        gate: 'dup',
        family: 'deterministic',
        status: 'could_not_run',
        detail: 'guard-dup(opted-out)',
      }),
      FALLOW,
      ev({ type: 'ship_result', blocked_gate: 'fallow', exit_code: 1 }),
    ]);

    expect(text).toContain('Gate findings this run (2):');
    expect(text).toContain('✗ fallow — BLOCKED this run: its report is above in the log');
    expect(text).toContain('· dup — guard-dup(opted-out)');
    expect(text).not.toContain('dup — BLOCKED');
  });

  it('is counted in a dry-gates rehearsal beside the deterministic findings', () => {
    const text = digest([
      ev({ type: 'gate_result', gate: 'comments', family: 'deterministic', status: 'fail' }),
      FALLOW,
    ]);

    expect(text).toContain('Gate findings this run (2):');
    expect(text).toContain('⚠ fallow — finding recorded');
  });
});
