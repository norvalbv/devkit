/** attachItems' off-wire `itemsFull` (sc-2493): full issue text for a bench, never on the event, and
 * the 200-char inline copy plus its byte budget unchanged. */
import { describe, expect, it } from 'vitest';
import { attachItems, itemFields } from '../evidence/items.mts';
import type { ReviewOutcome } from '../runtime.mts';

const long = `src/a.ts:12 — ${'the queued state is never re-driven by the poller, '.repeat(12)}so it sits forever UNIQUE-TAIL-MARKER`;
const state = { items: [{ name: 'state-transitions', status: 'fail', issues: [long] }] };
// SAFETY: attachItems reads only name/status off the outcome and writes the item fields onto it.
const outcome = (): ReviewOutcome =>
  ({ name: 'correctness-reviewer', status: 'fail' }) as ReviewOutcome;

describe('attachItems itemsFull', () => {
  it('keeps the wire copy at 200 chars and carries the full text only on itemsFull when asked', () => {
    const res = outcome();
    // SAFETY: a minimal ChecklistState — attachItems reads items[].{name,status,issues} only.
    attachItems(res, state as never, new Map(), { full: true });
    expect(res.items?.[0].issues?.[0]).toHaveLength(200);
    expect(res.itemsFull?.[0].issues[0]).toBe(long);
    expect(res.itemsFull?.[0].lens).toBe('state-transitions');
    expect(Object.keys(itemFields(res))).not.toContain('itemsFull');
    expect(JSON.stringify(itemFields(res))).not.toContain('UNIQUE-TAIL-MARKER');
  });
  it('attaches nothing extra by default', () => {
    const res = outcome();
    // SAFETY: same minimal ChecklistState as above.
    attachItems(res, state as never, new Map());
    expect(res.itemsFull).toBeUndefined();
    expect(res.items?.[0].issues?.[0]).toHaveLength(200);
  });
});
