import { describe, expect, it } from 'vitest';
import { type KillMatrixReport, redundancy } from './report.mts';

const report: KillMatrixReport = {
  kill_matrix: {
    candidates: ['a.test.mts::sum > adds again', 'b.test.mts::cut short'],
    coverage_without_kills: ['a.test.mts::sum > has a name'],
    targets: [
      {
        target: 'a.test.mts',
        status: 'complete',
        reasons: [],
        test_ids: [
          'a.test.mts::sum > adds',
          'a.test.mts::sum > adds again',
          'a.test.mts::sum > has a name',
        ],
      },
      {
        target: 'b.test.mts',
        status: 'incomplete',
        reasons: ['incomplete-mutant-results'],
        test_ids: ['b.test.mts::cut short'],
      },
    ],
  },
};

describe('redundancy', () => {
  it('flags only tests whose target has complete evidence', () => {
    const { flagged, judged } = redundancy(report);
    expect(judged).toBe(3);
    expect(flagged).toEqual([
      {
        testId: 'a.test.mts::sum > adds again',
        verdict: 'redundant',
      },
      {
        testId: 'a.test.mts::sum > has a name',
        verdict: 'kills nothing',
      },
    ]);
  });

  it('reports an incomplete target as not judged, with the reasons fallow gave', () => {
    expect(redundancy(report).unjudged).toEqual([
      { target: 'b.test.mts', tests: 1, reasons: ['incomplete-mutant-results'] },
    ]);
  });
});
