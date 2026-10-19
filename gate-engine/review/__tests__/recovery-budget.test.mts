import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewTask } from '../lens/split.mts';
import { runDeferredRecoveries, type SettleCtx } from '../recovery/settle.mts';

// The recovery budget becomes a judge's child_process `timeout`, which Node rejects unless it is
// an integer; a fractional SHIP_COMMIT_TIMEOUT would turn the retry into a misattributed outage.
const STOP = new Error('budget captured');

async function capturedBudget(): Promise<number> {
  let budget = Number.NaN;
  const runOne = async (_t: ReviewTask, _r: string, budgetMs: number) => {
    budget = budgetMs;
    throw STOP;
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // SAFETY: before runOne, the recovery loop reads only the reviewer name, for its log line.
  const task = { sel: { reviewer: { name: 'correctness' } } } as ReviewTask;
  const parked = [{ task, reason: 'checklist skipped', index: 0 }];
  // SAFETY: runOne throws before any settle, so the context is never read.
  const ctx = {} as SettleCtx;
  await expect(runDeferredRecoveries(parked, [], ctx, runOne, Date.now())).rejects.toBe(STOP);
  return budget;
}

describe('deferred recovery budget', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is a whole millisecond count under a fractional supervisor deadline', async () => {
    vi.stubEnv('DEVKIT_GATE_DEADLINE_MS', String(Date.now() + 120_000.5));
    expect(Number.isInteger(await capturedBudget())).toBe(true);
  });

  it('is a whole millisecond count under a fractional SHIP_COMMIT_TIMEOUT', async () => {
    vi.stubEnv('DEVKIT_GATE_DEADLINE_MS', undefined);
    vi.stubEnv('SHIP_COMMIT_TIMEOUT', '120.0005');
    expect(Number.isInteger(await capturedBudget())).toBe(true);
  });
});
