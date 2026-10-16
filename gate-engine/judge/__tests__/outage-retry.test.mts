/** The one outage retry policy both fail-closed judge gates share (cascade first pass, completeness). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeOutage } from '../outage/classify.mts';
import { RETRY_FLOOR_MS, spawnWithRetry } from '../outage/retry.mts';

const CAPACITY: JudgeOutage = {
  kind: 'transient',
  permanent: false,
  detail: 'Selected model is at capacity. Please try a different model.',
};

/** A spawn that plays back one scripted attempt per call: an outage, or `null` for a PASS. */
function scripted(attempts: (JudgeOutage | null)[]) {
  return vi.fn(async (_timeout: number, onOutage: (o: JudgeOutage) => void) => {
    const next = attempts.shift();
    if (next === undefined) throw new Error('spawned more often than scripted');
    if (next === null) return 'VERDICT: PASS';
    onOutage(next);
    return null;
  });
}

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const opts = { retry: true, label: 'completeness', capMs: 1_800_000 };

describe('spawnWithRetry', () => {
  it('re-spawns once after an outage a re-spawn can clear, and returns the retry verdict', async () => {
    const spawn = scripted([CAPACITY, null]);
    const beforeRetry = vi.fn();
    const run = await spawnWithRetry(spawn, { ...opts, beforeRetry });
    expect(run).toEqual({ result: 'VERDICT: PASS', outage: undefined, retried: true });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'guard-review: completeness: judge run failed (transient), retrying once…',
    );
  });

  it('never re-spawns a permanent outage', async () => {
    const locked: JudgeOutage = { kind: 'rate-limited', permanent: true };
    const spawn = scripted([locked]);
    const run = await spawnWithRetry(spawn, opts);
    expect(run).toEqual({ result: null, outage: locked, retried: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('never re-spawns when retry is off (a fail-open gate)', async () => {
    const spawn = scripted([CAPACITY]);
    expect((await spawnWithRetry(spawn, { ...opts, retry: false })).retried).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('lets the outage stand when too little budget remains for a real judgement', async () => {
    const spawn = scripted([CAPACITY]);
    const run = await spawnWithRetry(spawn, { ...opts, capMs: RETRY_FLOOR_MS - 1 });
    expect(run).toEqual({ result: null, outage: CAPACITY, retried: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('caps the retry by the budget that REMAINS, not a fresh full cap', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const spawn = vi
      .fn()
      .mockImplementationOnce(async (_t: number, onOutage: (o: JudgeOutage) => void) => {
        now += 300_000; // a late failure: five minutes in
        onOutage(CAPACITY);
        return null;
      })
      .mockResolvedValueOnce('VERDICT: PASS');
    await spawnWithRetry(spawn, opts);
    expect(spawn.mock.calls.map(([timeout]) => timeout)).toEqual([1_800_000, 1_500_000]);
  });

  // Both gates pin their first pass to exactly the shared cap; a clock tick between reading the
  // deadline and spawning must not shave it (that made the cap assertions flaky under load).
  it('hands the first spawn exactly capMs, however the clock moves before it spawns', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const spawn = scripted([null]);
    await spawnWithRetry(spawn, opts);
    expect(spawn.mock.calls[0][0]).toBe(1_800_000);
  });

  it("reports the LAST attempt's outage, never a stale one from the first", async () => {
    const locked: JudgeOutage = { kind: 'rate-limited', permanent: true };
    expect((await spawnWithRetry(scripted([CAPACITY, locked]), opts)).outage).toBe(locked);
    // A retry that fails without classifying anything must not inherit the first cause either.
    const silent = vi
      .fn()
      .mockImplementationOnce(async (_t: number, onOutage: (o: JudgeOutage) => void) => {
        onOutage(CAPACITY);
        return null;
      })
      .mockResolvedValueOnce(null);
    expect((await spawnWithRetry(silent, opts)).outage).toBeUndefined();
  });
});
