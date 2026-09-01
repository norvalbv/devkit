import { describe, expect, it } from 'vitest';
import { runSlotQuestions, type SlotOutcome, type SlotQuestion } from '../matcher-core.mts';

const slots: SlotQuestion[] = [
  { slotId: 'first', kind: 'gold', prompt: 'first prompt' },
  { slotId: 'saved', kind: 'decoy', prompt: 'saved prompt' },
  { slotId: 'last', kind: 'gold', prompt: 'last prompt' },
];

describe('runSlotQuestions resume support', () => {
  it('reuses an exact safe outcome without executing or notifying, and preserves slot order', async () => {
    const labels: string[] = [];
    const completed: string[] = [];
    const resumed: SlotOutcome = {
      slotId: 'saved',
      kind: 'decoy',
      match: 0,
      stable: false,
      outage: false,
    };

    const outcomes = await runSlotQuestions(slots, 1, {
      runs: 1,
      concurrency: 2,
      resumeOutcomes: [resumed],
      exec: async ({ label }) => {
        labels.push(label);
        if (label.endsWith(':first')) await new Promise((resolve) => setTimeout(resolve, 5));
        return 'SLOT: F1';
      },
      onSlotComplete: (outcome) => completed.push(outcome.slotId),
    });

    expect(labels).toHaveLength(2);
    expect(labels.some((label) => label.endsWith(':saved'))).toBe(false);
    expect(outcomes).toEqual([
      { slotId: 'first', kind: 'gold', match: 1, stable: true, outage: false },
      resumed,
      { slotId: 'last', kind: 'gold', match: 1, stable: true, outage: false },
    ]);
    expect(completed).toHaveLength(2);
    expect(completed).toEqual(expect.arrayContaining(['first', 'last']));
    expect(completed).not.toContain('saved');
  });

  it('reruns mismatched, unsafe, out-of-range, and ambiguous resume values', async () => {
    const invalidSlots: SlotQuestion[] = [
      { slotId: 'wrong-kind', kind: 'gold', prompt: 'p' },
      { slotId: 'outage', kind: 'gold', prompt: 'p' },
      { slotId: 'fractional', kind: 'gold', prompt: 'p' },
      { slotId: 'out-of-range', kind: 'gold', prompt: 'p' },
      { slotId: 'ambiguous', kind: 'gold', prompt: 'p' },
    ];
    const resumeOutcomes: SlotOutcome[] = [
      { slotId: 'wrong-kind', kind: 'decoy', match: 1, stable: true, outage: false },
      { slotId: 'outage', kind: 'gold', match: 1, stable: false, outage: true },
      { slotId: 'fractional', kind: 'gold', match: 0.5, stable: true, outage: false },
      { slotId: 'out-of-range', kind: 'gold', match: 2, stable: true, outage: false },
      { slotId: 'ambiguous', kind: 'gold', match: 0, stable: true, outage: false },
      { slotId: 'ambiguous', kind: 'gold', match: 1, stable: true, outage: false },
    ];
    const labels: string[] = [];
    const completed: string[] = [];

    const outcomes = await runSlotQuestions(invalidSlots, 1, {
      runs: 1,
      resumeOutcomes,
      exec: async ({ label }) => {
        labels.push(label);
        return 'SLOT: F1';
      },
      onSlotComplete: (outcome) => completed.push(outcome.slotId),
    });

    expect(labels).toHaveLength(invalidSlots.length);
    expect(completed).toEqual(invalidSlots.map((slot) => slot.slotId));
    expect(outcomes.map((outcome) => outcome.match)).toEqual([1, 1, 1, 1, 1]);
  });

  it('notifies synchronously when a new slot completes, before a later slot and the run finish', async () => {
    let releaseSlow: (() => void) | undefined;
    let settled = false;
    const completed: string[] = [];
    const running = runSlotQuestions(
      [
        { slotId: 'fast', kind: 'gold', prompt: 'p' },
        { slotId: 'slow', kind: 'decoy', prompt: 'p' },
      ],
      1,
      {
        runs: 1,
        concurrency: 2,
        exec: async ({ label }) => {
          if (label.endsWith(':slow'))
            await new Promise<void>((resolve) => {
              releaseSlow = resolve;
            });
          return 'SLOT: F1';
        },
        onSlotComplete: (outcome) => completed.push(outcome.slotId),
      },
    );
    void running.then(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releaseSlow).toBeTypeOf('function');
    expect(completed).toEqual(['fast']);
    expect(settled).toBe(false);

    releaseSlow?.();
    await running;
    expect(completed).toEqual(['fast', 'slow']);
    expect(settled).toBe(true);
  });

  it('waits for a slot final trial before notifying', async () => {
    let callCount = 0;
    let releaseFinal: (() => void) | undefined;
    let markFinalStarted: (() => void) | undefined;
    const finalStarted = new Promise<void>((resolve) => {
      markFinalStarted = resolve;
    });
    const completed: SlotOutcome[] = [];
    const running = runSlotQuestions([{ slotId: 'voted', kind: 'gold', prompt: 'p' }], 1, {
      runs: 2,
      concurrency: 1,
      exec: async () => {
        callCount += 1;
        if (callCount === 2) {
          markFinalStarted?.();
          await new Promise<void>((resolve) => {
            releaseFinal = resolve;
          });
        }
        return 'SLOT: F1';
      },
      onSlotComplete: (outcome) => completed.push(outcome),
    });

    await finalStarted;
    expect(completed).toEqual([]);
    releaseFinal?.();
    await running;
    expect(completed).toEqual([
      { slotId: 'voted', kind: 'gold', match: 1, stable: true, outage: false },
    ]);
  });

  it('persists newly computed zero-finding slots but does not notify for reused ones', async () => {
    const completed: string[] = [];
    const outcomes = await runSlotQuestions(slots.slice(0, 2), 0, {
      resumeOutcomes: [{ slotId: 'saved', kind: 'decoy', match: 0, stable: false, outage: false }],
      exec: async () => {
        throw new Error('zero-finding slots must not execute a judge');
      },
      onSlotComplete: (outcome) => completed.push(outcome.slotId),
    });

    expect(outcomes).toEqual([
      { slotId: 'first', kind: 'gold', match: 0, stable: true, outage: false },
      { slotId: 'saved', kind: 'decoy', match: 0, stable: false, outage: false },
    ]);
    expect(completed).toEqual(['first']);
  });
});
