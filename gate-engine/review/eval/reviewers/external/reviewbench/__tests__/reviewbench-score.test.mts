import { describe, expect, it } from 'vitest';
import {
  clusterBootstrap,
  flipRate,
  judgeAgreement,
  reduceRun,
  stratumUnits,
  unionRuns,
  type ScoredPr,
} from '../reviewbench-score.mts';

const pr = (over: Partial<ScoredPr>): ScoredPr => ({
  key: 'o_r_1-abc',
  loc: 1500,
  files: 20,
  withheldNoFile: 1,
  withheldFileNoLine: 2,
  withheldFileNoLineStrict: 3,
  crossFile: 1,
  tasks: 4,
  inconclusive: 0,
  scopePaths: ['src/a.ts'],
  fullyShown: true,
  golden: [
    {
      file: 'src/a.ts',
      tp_fp: 'tp',
      category: 'correctness',
      scope: 'introduced-by-pr',
      context_required: 'diff-only',
      producer: 'llm_review:claude-sonnet-4.6',
    },
    {
      file: 'src/a.ts',
      tp_fp: 'tp',
      category: 'reliability',
      scope: 'introduced-by-pr',
      context_required: 'diff-plus-related-files',
    },
    { file: 'README.md', tp_fp: 'tp', category: 'correctness', scope: 'introduced-by-pr' },
    { file: 'src/a.ts', tp_fp: 'tp', category: 'correctness', scope: 'pre-existing' },
    { file: 'src/a.ts', tp_fp: 'tp', category: 'security', scope: 'introduced-by-pr' },
    { file: 'src/a.ts', tp_fp: 'fp', category: 'correctness', scope: 'introduced-by-pr' },
  ],
  candidates: [
    { file: 'src/a.ts', message: 'x', status: 'matched_tp', covered_golden_indices: [0, 3, 4] },
    { file: 'src/a.ts', message: 'x', status: 'matched_fp', covered_golden_indices: [5] },
    {
      file: 'src/b.ts',
      message: 'breaks the reader in src/a.ts',
      status: 'novel_fp',
      covered_golden_indices: [],
    },
  ],
  ...over,
});

describe('reduceRun', () => {
  it('counts only correctness/reliability TPs introduced by the PR, caught when covered', () => {
    const r = reduceRun([pr({})]);
    expect(r.recall.all).toEqual({ caught: 1, labels: 3 });
    expect(r.recall['category:correctness']).toEqual({ caught: 1, labels: 2 });
    expect(r.recall['category:reliability']).toEqual({ caught: 0, labels: 1 });
    expect(r.recall['lines:1000-2999']).toEqual({ caught: 1, labels: 3 });
    expect(r.recall['files:15-39']).toEqual({ caught: 1, labels: 3 });
    expect(r.recall['context:diff-only']).toEqual({ caught: 1, labels: 1 });
    expect(r.recall['evidence:not-in-scope']).toEqual({ caught: 0, labels: 1 });
    expect(r.recall['evidence:shown-in-full']).toEqual({ caught: 1, labels: 2 });
    expect(r.recall['label-load:<=12']).toEqual({ caught: 1, labels: 3 });
    expect(r.namedElsewhere.all).toBe(1);
    expect(r.namedElsewhere['evidence:not-in-scope']).toBe(0);
    expect(r.recall['all|family:claude']).toEqual({ caught: 1, labels: 1 });
    expect(r.recall['all|family:non-claude']).toEqual({ caught: 0, labels: 2 });
    expect(r.recall['mixed-family-prs|family:claude']).toEqual({ caught: 1, labels: 1 });
    expect(r.recall['mixed-family-prs|family:non-claude']).toEqual({ caught: 0, labels: 2 });
    expect(r.findings).toEqual({
      matched_tp: 1,
      matched_fp: 1,
      novel_tp: 0,
      novel_fp: 1,
      withheldNoFile: 1,
      withheldFileNoLine: 2,
      withheldFileNoLineStrict: 3,
      crossFile: 1,
      exported: 3,
    });
  });

  it('fails an arm on protocol above 10% inconclusive lens tasks', () => {
    expect(reduceRun([pr({ tasks: 10, inconclusive: 1 })]).failedOnProtocol).toBe(false);
    expect(reduceRun([pr({ tasks: 10, inconclusive: 2 })]).failedOnProtocol).toBe(true);
  });
});

describe('clusterBootstrap', () => {
  it('is deterministic and brackets the pooled recall', () => {
    const runs = [[pr({ key: 'a' }), pr({ key: 'b', candidates: [] })]];
    const ci = clusterBootstrap(stratumUnits(runs, 'all'));
    expect(ci).toEqual(clusterBootstrap(stratumUnits(runs, 'all')));
    expect(ci!.lo).toBeLessThanOrEqual(1 / 6);
    expect(ci!.hi).toBeGreaterThanOrEqual(1 / 6);
  });

  it('resamples whole clusters, so one all-hit cluster and one all-miss cluster span 0..1', () => {
    const units = [
      { cluster: 'repoA', hits: 3, n: 3 },
      { cluster: 'repoB', hits: 0, n: 3 },
    ];
    expect(clusterBootstrap(units, { iters: 500, seed: 7 })).toEqual({ lo: 0, hi: 1 });
    expect(clusterBootstrap([])).toBeNull();
  });
});

describe('flipRate', () => {
  it('counts labels whose outcome differs between two runs of the same arm', () => {
    const runs = [[pr({})], [pr({ candidates: [] })]];
    expect(flipRate(runs, 'all')).toEqual({ flipped: 1, labels: 3 });
    expect(flipRate([runs[0]], 'all')).toBeNull();
  });
});

describe('unionRuns', () => {
  it('pools two whole-diff runs so a label caught by either counts once', () => {
    const second = pr({
      candidates: [
        { file: 'src/a.ts', message: 'x', status: 'matched_tp', covered_golden_indices: [1] },
      ],
    });
    const union = reduceRun(unionRuns([pr({})], [second]));
    expect(union.recall.all).toEqual({ caught: 2, labels: 3 });
    expect(union.recall['cap:within']).toEqual({ caught: 2, labels: 3 });
    expect(unionRuns([pr({})], [pr({ key: 'other' })])).toEqual([]);
  });
});

describe('judgeAgreement', () => {
  it('cross-tabulates two judges over the same labels', () => {
    expect(judgeAgreement([pr({})], [pr({ candidates: [] })])).toEqual({
      both: 0,
      onlyFirst: 1,
      onlySecond: 0,
      neither: 2,
    });
  });
});
