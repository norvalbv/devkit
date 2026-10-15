/** attachItems' off-wire `itemsFull` (sc-2493): full issue text for a bench, never on the event, and
 * the 200-char inline copy plus its byte budget unchanged. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { runCascade } from '../cascade/reviewer.mts';
import { attachItems, itemFields, reviewCaptureSchema } from '../evidence/items.mts';
import { REVIEWERS } from '../reviewers.mts';
import { isNamedSkip, type ReviewOutcome } from '../runtime.mts';
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

// sc-3400 / gate-verdict-attribution: an EXISTING empty artifact (a named skip) is zero items, which
// must stay distinguishable on the wire from an absent artifact.
it('records an existing empty artifact as zero items, and an absent one as nothing', () => {
  const skipped = outcome();
  attachItems(skipped, { files: [], skipped: 'deletion-only' }, new Map());
  expect(itemFields(skipped)).toMatchObject({ item_count: 0, item_artifact: 'files', items: [] });
  const absent = outcome();
  attachItems(absent, null, new Map());
  expect(itemFields(absent)).toEqual({});
});

// sc-3400: a named skip buys a judge-less PASS, so `skipped` is parsed, never truthiness-checked.
it.each([
  [{ files: [], skipped: 'deletion-only' }, true],
  [{ files: [], skipped: 1 }, false],
  [{ files: [], skipped: ['x'] }, false],
  [{ files: [], skipped: '' }, false],
  [{ files: [], skipped: ' ' }, false],
  [{ files: [], skipped: '\t\n\u00a0' }, false],
  [{ files: [{ path: 'a.ts' }], skipped: 'x' }, false],
  [{ files: [], skipped: 'x', items: [{ name: 'lens', status: 'fail' }] }, false],
  [{ files: [], skipped: 'x', items: [] }, false],
  [null, false],
])('isNamedSkip(%j) is %s', (state, expected) => {
  // SAFETY: deliberately malformed artifacts — the parse under test is what rejects them.
  expect(isNamedSkip(state as never)).toBe(expected);
});

// The commit-gates skill's finding-search recipe, run against rows built by the real writer: a
// rename of items/issues/disposition, or a recipe that also greps PR bodies, fails here.
describe('commit-gates finding-search recipe', () => {
  const skill = readFileSync(
    new URL('../../../skills/commit-gates/SKILL.md', import.meta.url),
    'utf8',
  );
  const recipe = /```sh\n([\s\S]*?)```/.exec(
    skill.split('## Sizing how often a reviewer finding recurs')[1] ?? '',
  )?.[1];
  const hasJq = spawnSync('jq', ['--version']).status === 0;
  it('finds the recipe under its heading', () => expect(recipe).toContain('review_result'));
  const root = mkdtempSync(join(tmpdir(), 'finding-recipe-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const run = (sink: string) => {
    const cwd = mkdtempSync(join(root, 'cwd-'));
    const out = execFileSync('bash', ['-c', recipe ?? ''], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_GATE_EVENTS: sink },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { out, hits: readFileSync(join(cwd, 'hits.tsv'), 'utf8') };
  };
  const reviewRow = (
    shipId: string,
    reviewer: string,
    issue: string,
    reason = '',
    status = 'fail',
  ) => {
    const res = outcome();
    const lensState = { items: [{ name: 'state-transitions', status: 'fail', issues: [issue] }] };
    // SAFETY: the same minimal ChecklistState shape the cases above use.
    attachItems(res, lensState as never, new Map([['state-transitions', 'blocking']]));
    return JSON.stringify({
      type: 'review_result',
      ts: '2026-08-29T15:41:13Z',
      repo: 'devkit',
      reviewer,
      model: 'm1',
      status,
      reason,
      ship_id: shipId,
      ...itemFields(res),
    });
  };

  it.skipIf(!hasJq)('counts review findings once per ship and never PR bodies or causes', () => {
    const sink = join(root, 'gate-events.jsonl');
    const finding = 'src/a.ts:9 — under bun test the shim leaks';
    writeFileSync(
      sink,
      `${[
        JSON.stringify({ type: 'ship_intent', ts: '2026-08-01T00:00:00Z', body: 'ran bun test' }),
        reviewRow('ship-a', 'correctness-reviewer', finding),
        JSON.stringify({ type: 'judge_exec', outcome: 'outage', outage_detail: 'bun test hung' }),
        reviewRow('ship-a', 'correctness-reviewer', finding),
        reviewRow('ship-b', 'commit-guard', 'unrelated', 'Bun Test output cited'),
        reviewRow('ship-c', 'commit-guard', 'unrelated'),
        reviewRow('ship-d', 'commit-guard', 'unrelated', 'bun test output reviewed', 'pass'),
        reviewRow(
          'ship-e',
          'commit-guard',
          'unrelated',
          'bun test judge timed out',
          'inconclusive',
        ),
      ].join('\n')}\n`,
    );
    const { out, hits } = run(sink);
    const rows = hits
      .trim()
      .split('\n')
      .map((line) => line.split('\t'));
    expect(rows.map((r) => [r[2], r[3], r[5], r[6]])).toEqual([
      ['correctness-reviewer', 'state-transitions', 'blocking', 'ship-a'],
      ['correctness-reviewer', 'state-transitions', 'blocking', 'ship-a'],
      ['commit-guard', '-', 'fail', 'ship-b'],
    ]);
    expect(out).toContain(`${sink}: 2026-08-01T00:00:00Z → 2026-08-29T15:41:13Z`);
    expect(out).toMatch(/^\s*1 commit-guard$/m);
    expect(out).toMatch(/^\s*1 correctness-reviewer$/m);
  });

  it.skipIf(!hasJq)('names a missing sink instead of reading it as zero', () => {
    const missing = join(root, 'absent', 'gate-events.jsonl');
    expect(run(missing).out).toContain(`no sink at ${missing}: telemetry is off here`);
  });
});
