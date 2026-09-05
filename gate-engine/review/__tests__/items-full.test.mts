/** attachItems' off-wire `itemsFull` (sc-2493): full issue text for a bench, never on the event, and
 * the 200-char inline copy plus its byte budget unchanged. */
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { runCascade } from '../cascade/reviewer.mts';
import { attachItems, itemFields, reviewCaptureSchema } from '../evidence/items.mts';
import { REVIEWERS } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { cleanupReviewFixtures, consumerRepo, mkExec } from './run-review-fixtures.mts';

const long = `src/a.ts:12 — ${'the queued state is never re-driven by the poller, '.repeat(12)}so it sits forever UNIQUE-TAIL-MARKER`;
const state = { items: [{ name: 'state-transitions', status: 'fail', issues: [long] }] };
// SAFETY: attachItems reads only name/status off the outcome and writes the item fields onto it.
const outcome = (): ReviewOutcome =>
  ({ name: 'correctness-reviewer', status: 'fail' }) as ReviewOutcome;
afterEach(() => {
  cleanupReviewFixtures();
  vi.unstubAllEnvs();
});

it('refuses exact provenance for blank checklist identities and unsupported statuses', () => {
  const cases = [
    { name: '', status: 'fail' },
    { name: '   ', status: 'fail' },
    { name: 'state-transitions', status: '' },
    { name: 'state-transitions', status: 'arbitrary' },
    { path: '', status: 'fail' },
  ];
  for (const item of cases) {
    const res = outcome();
    attachItems(res, { items: [{ ...item, issues: ['claim'] }] }, new Map(), { full: true });
    expect(res.capture?.provenance).toBe('missing-invalid');
    const captured = {
      itemIndex: 0,
      lens: item.name ?? item.path,
      status: item.status,
      issues: ['claim'],
    };
    expect(
      reviewCaptureSchema.safeParse({
        version: 1,
        provenance: 'exact-checklist',
        items: [captured],
      }).success,
    ).toBe(false);
    expect(
      reviewCaptureSchema.safeParse({
        version: 1,
        provenance: 'capped-fallback',
        items: [captured],
      }).success,
    ).toBe(true);
  }
});

it('rejects unsupported capture fields without stripping them into exact evidence', () => {
  const res = outcome();
  const items = [{ name: 'state-transitions', category: 'State', status: 'fail', issues: [long] }];
  attachItems(res, { items }, new Map(), { full: true });
  expect(reviewCaptureSchema.safeParse(res.capture).success).toBe(true);
  expect(reviewCaptureSchema.safeParse({ ...res.capture, truncated: true }).success).toBe(false);
  expect(
    reviewCaptureSchema.safeParse({
      ...res.capture,
      items: [{ ...res.capture!.items[0], truncated: true }],
    }).success,
  ).toBe(false);
  const unsupported = outcome();
  const malformed = items.map((item) => ({ ...item, truncated: true }));
  attachItems(unsupported, { items: malformed }, new Map(), { full: true });
  expect(unsupported.capture?.provenance).toBe('missing-invalid');
});

describe('attachItems itemsFull', () => {
  it('preserves the actual incomplete artifact when final recovery deletes it before capture', async () => {
    const cwd = consumerRepo({ backend: true });
    const reviewer = REVIEWERS.find((r) => r.name === 'correctness-reviewer')!;
    const stateFile = join(cwd, reviewer.stateFile!);
    const text = `${'unresolved detail '.repeat(400)}INCONCLUSIVE-TAIL`;
    const exec = mkExec(async () => {
      writeFileSync(
        stateFile,
        JSON.stringify({
          items: [
            { name: 'state-transitions', status: 'fail', issues: [text] },
            { name: 'concurrency-races', status: 'pending' },
          ],
        }),
      );
      return 'VERDICT: PASS';
    });
    const res = await runCascade(
      { reviewer, files: ['src/main/db.ts'] },
      {
        cwd,
        cfg: resolveGuardConfig(cwd),
        exec,
        recovery: 'final',
        fullItems: true,
      },
    );
    expect(res.status).toBe('inconclusive');
    expect(res.capture?.provenance).toBe('exact-checklist');
    expect(res.capture?.items[0].issues).toEqual([text]);
    expect(res.capture?.items[1].status).toBe('pending');
    expect(existsSync(stateFile)).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
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
    expect(res.capture).toBeUndefined();
    expect(res.items?.[0].issues?.[0]).toHaveLength(200);
  });
  it('retains exact tails, original indices, full names and every disclosed issue beyond wire caps', () => {
    vi.stubEnv('GUARD_REVIEW_MAX_ISSUES_PER_LENS', '1');
    const text = `${'the failure needs this context '.repeat(200)}EXACT-TAIL`;
    const lens = `path/${'deep/'.repeat(45)}state-transitions`;
    const items = [
      { name: 'pending-first', status: 'pending', issues: [] },
      { name: lens, status: 'fail', issues: [text, 'second', 'third'] },
      ...Array.from({ length: 41 }, (_, i) => ({ name: `pass-${i}`, status: 'pass' })),
    ];
    const res = outcome();
    attachItems(res, { items }, new Map([[lens, 'blocking']]), { full: true });
    expect(res.capture?.provenance).toBe('exact-checklist');
    expect(res.capture?.items).toHaveLength(43);
    expect(res.capture?.items[1]).toEqual({
      itemIndex: 1,
      lens,
      status: 'fail',
      disposition: 'blocking',
      issues: [text, 'second', 'third'],
    });
    const captured = res.itemsFull?.[1].issues[0] ?? '';
    expect(captured.endsWith('EXACT-TAIL')).toBe(true);
    expect(createHash('sha256').update(captured).digest('hex')).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
    expect(JSON.stringify(itemFields(res))).not.toContain('EXACT-TAIL');
    expect(JSON.stringify(itemFields(res))).not.toContain('capture');
    expect(res.itemCount).toBe(43);
  });
  it('keeps post-valve dispositions and pass/pending statuses in their artifact order', () => {
    const res = { ...outcome(), status: 'pass' as const };
    attachItems(
      res,
      {
        items: [
          { name: 'passed', status: 'pass' },
          { name: 'waived', status: 'fail', issues: ['waived claim'] },
          { name: 'dropped', status: 'fail', issues: ['out of charter claim'] },
        ],
      },
      new Map([
        ['waived', 'waived'],
        ['dropped', 'dropped_out_of_charter'],
      ]),
      { full: true },
    );
    expect(
      res.capture?.items.map((item) => [item.itemIndex, item.lens, item.status, item.disposition]),
    ).toEqual([
      [0, 'passed', 'pass', undefined],
      [1, 'waived', 'fail', 'waived'],
      [2, 'dropped', 'fail', 'dropped_out_of_charter'],
    ]);
  });
  it('distinguishes a named empty skip, an exact empty vector, all-pass, and missing or invalid artifacts', () => {
    const capture = (
      value: null | {
        files?: [];
        items?: Array<null | {
          name: string | number;
          status: string;
          issues?: string | Array<string | { bad: string }>;
        }>;
        skipped?: string;
      },
    ) => {
      const res = outcome();
      // SAFETY: deliberately exercises unreadable/malformed persisted artifact shapes.
      attachItems(res, value as never, new Map(), { full: true });
      return res.capture;
    };
    expect(capture({ files: [], skipped: 'no in-scope files' })).toEqual({
      version: 1,
      provenance: 'exact-checklist',
      artifact: 'files',
      skipped: 'no in-scope files',
      items: [],
    });
    expect(capture({ items: [] })).toEqual({
      version: 1,
      provenance: 'exact-checklist',
      artifact: 'items',
      items: [],
    });
    expect(capture({ items: [{ name: 'one', status: 'pass' }] })?.items[0].issues).toEqual([]);
    expect(capture(null)).toEqual({ version: 1, provenance: 'missing-invalid', items: [] });
    expect(
      capture({ items: [{ name: 'one', status: 'fail', issues: [{ bad: 'value' }] }] }),
    ).toEqual({
      version: 1,
      provenance: 'missing-invalid',
      artifact: 'items',
      items: [],
    });
    for (const items of [
      [null],
      [{ name: 12, status: 'fail', issues: ['claim'] }],
      [{ name: 'one', status: 'fail', issues: 'not-an-array' }],
    ])
      expect(capture({ items })?.provenance).toBe('missing-invalid');
  });
});
