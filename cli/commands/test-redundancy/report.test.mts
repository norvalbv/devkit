import { describe, expect, it } from 'vitest';
import { changedLines, type KillMatrixReport, redundancy } from './report.mts';

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

describe('changedLines', () => {
  it('lists surviving and unreached planted bugs on changed lines only, and counts what ran', () => {
    const change = { from: '<', to: '<=' };
    const mutants = [
      { file: 'a.mts', line: 2, status: 'survived', operator: 'relational-operator', change },
      { file: 'a.mts', line: 3, status: 'no_coverage' },
      { file: 'a.mts', line: 3, status: 'killed' },
      { file: 'a.mts', line: 4, status: 'pending' },
      { file: 'a.mts', line: 9, status: 'survived', operator: 'relational-operator', change },
    ];

    expect(changedLines({ mutants }, (_file, line) => line < 9)).toEqual({
      uncaught: [
        { file: 'a.mts', line: 2, what: 'relational-operator: < → <=' },
        { file: 'a.mts', line: 3, what: 'no test runs this line' },
      ],
      planned: 4,
      ran: 3,
    });
  });
});
