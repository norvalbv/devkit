/** Boundary between checkpoint rows and Martian's judge: an outage exported as [] would score as
 * a total miss, and a wrong key name would make their step 2 skip the tool. */
import { describe, expect, it } from 'vitest';
import type { CheckpointRow } from '../../scale/lens-run.mts';
import { exportFragment, type Golden, mergeFragment } from '../martian-export.mts';

const golden: Golden = {
  pr_title: 't',
  url: 'https://github.com/calcom/cal.com/pull/1',
  comments: [{ comment: 'a null deref', severity: 'High', category: 'bug' }],
};
const row = (over: Partial<CheckpointRow>): CheckpointRow => ({
  key: 'k',
  diff: 'd',
  arm: 'whole',
  chunk: -1,
  group: 'state-transitions',
  status: 'fail',
  reason: '',
  issues: [],
  ms: 1,
  at: '2026-09-02T00:00:00Z',
  identity: 'id',
  ...over,
});
const base = {
  pr: 1,
  url: golden.url,
  slug: 'calcom/cal.com',
  diffSha: 'abc',
  base: 'sha',
  mergedAt: '2023-08-31T00:00:00Z',
  scopeFiles: ['packages/lib/a.ts'],
  staged: ['packages/lib/a.ts', 'apps/web/b.tsx'],
  evidence: { evidence_bytes_shown: 10, omitted_files: 0, truncated_files: 0 },
};
const opts = {
  goldens: [golden],
  tool: 'devkit-correctness',
  goldenSourceFile: 'cal_dot_com.json',
  model: 'sonnet',
};

describe('exportFragment', () => {
  it('emits one review comment per lens issue with the Martian key set and a resolved location', () => {
    const rows = [
      row({ issues: [{ lens: 'state-transitions', text: 'a.ts:12 flag cleared before use' }] }),
      row({
        key: 'k2',
        group: 'concurrency-races',
        issues: [{ lens: 'concurrency-races', text: 'unawaited write' }],
      }),
    ];
    const out = exportFragment({ ...opts, runs: [{ ...base, rows }] });
    const entry = out.benchmarkData[golden.url];
    expect(entry.golden_source_file).toBe('cal_dot_com.json');
    expect(entry.reviews).toHaveLength(1);
    expect(entry.reviews[0]).toMatchObject({
      tool: 'devkit-correctness',
      repo_name: 'cal_dot_com',
      pr_url: golden.url,
    });
    expect(entry.reviews[0].review_comments).toEqual([
      {
        path: 'packages/lib/a.ts',
        line: 12,
        body: '[state-transitions] a.ts:12 flag cleared before use',
        created_at: '2026-09-02T00:00:00Z',
      },
      {
        path: null,
        line: null,
        body: '[concurrency-races] unawaited write',
        created_at: '2026-09-02T00:00:00Z',
      },
    ]);
    expect(out.contexts[golden.url]).toMatchObject({
      scopeFiles: ['packages/lib/a.ts'],
      shownFiles: ['packages/lib/a.ts'],
    });
    expect(out.contexts[golden.url].issues).toHaveLength(2);
  });
  it('exports [] for a PR with terminal verdicts and no issues (a real miss)', () => {
    const out = exportFragment({ ...opts, runs: [{ ...base, rows: [row({ status: 'pass' })] }] });
    expect(out.benchmarkData[golden.url].reviews[0].review_comments).toEqual([]);
    expect(out.omitted).toEqual([]);
  });
  it('omits a PR whose every task errored, and reports it', () => {
    const out = exportFragment({ ...opts, runs: [{ ...base, rows: [row({ status: 'error' })] }] });
    expect(out.benchmarkData[golden.url]).toBeUndefined();
    expect(out.omitted).toEqual([1]);
    expect(out.contexts[golden.url]).toBeDefined();
  });
  it('marks every scoped file uncertain when the evidence cap omitted or truncated anything', () => {
    const out = exportFragment({
      ...opts,
      runs: [
        {
          ...base,
          evidence: { evidence_bytes_shown: 60000, omitted_files: 2, truncated_files: 0 },
          rows: [row({})],
        },
      ],
    });
    expect(out.contexts[golden.url].shownFiles).toEqual([]);
  });
  it('refuses a run with no golden entry', () => {
    expect(() =>
      exportFragment({
        ...opts,
        runs: [{ ...base, url: 'https://github.com/x/y/pull/9', rows: [] }],
      }),
    ).toThrow(/no golden/);
  });
});

describe('mergeFragment', () => {
  it('replaces only this tool on a PR the target already has and keeps other tools', () => {
    const target = {
      [golden.url]: {
        golden_comments: golden.comments,
        golden_source_file: 'cal_dot_com.json',
        reviews: [
          { tool: 'coderabbit', repo_name: 'cal_dot_com', pr_url: golden.url, review_comments: [] },
          {
            tool: 'devkit-correctness',
            repo_name: 'cal_dot_com',
            pr_url: golden.url,
            review_comments: [],
          },
        ],
      },
    };
    const fragment = exportFragment({
      ...opts,
      runs: [{ ...base, rows: [row({ issues: [{ lens: 'x', text: 'y' }] })] }],
    }).benchmarkData;
    const { merged, fragmentPrs, totalPrs } = mergeFragment(target, fragment);
    expect(merged[golden.url].reviews.map((r) => r.tool)).toEqual([
      'coderabbit',
      'devkit-correctness',
    ]);
    expect(merged[golden.url].reviews[1].review_comments).toHaveLength(1);
    expect({ fragmentPrs, totalPrs }).toEqual({ fragmentPrs: 1, totalPrs: 1 });
  });
});
