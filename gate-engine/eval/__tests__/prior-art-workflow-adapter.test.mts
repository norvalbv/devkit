import { describe, expect, it } from 'vitest';
import { member, response, stream } from '../../prior-art/__tests__/workflow-fixtures.mts';
import { scoreRun } from '../../prior-art/eval/workflow/score.mts';
import {
  aggregateCase,
  type CaseResult,
  type CaseRows,
  summarise,
} from '../../prior-art/eval/workflow/summary.mts';
import { parsePriorArt } from '../adapters.mts';

const read = () => null;

function workflowBlock(runs: number, outages = 0) {
  const genuine = member();
  const result = (verdict: 'GENUINE_NEW_WORK' | 'DISSOLVE_FRAME'): CaseResult =>
    aggregateCase(
      genuine,
      [
        {
          score: scoreRun(
            genuine,
            'search',
            stream({ result: response({ verdict, resolved: 1 }) }),
            '/ws',
            read,
          ),
          endorsed: {},
        },
      ],
      outages,
    );
  const rows: CaseRows = {
    m1: { supplied: result('GENUINE_NEW_WORK'), search: result('DISSOLVE_FRAME') },
  };
  return summarise([genuine], rows, {
    model: 'opus',
    claudeVersion: '2',
    scorerHash: 'h',
    runs,
    matchRuns: 3,
    total: 2,
  });
}

describe('prior-art adapter: workflow tier', () => {
  it('reports each measure per condition and the paired retrieval/interpretation split', () => {
    const parsed = parsePriorArt(workflowBlock(3));
    const byId = Object.fromEntries(parsed.metrics.map((metric) => [metric.id, metric]));
    expect(byId['search-verdict']).toMatchObject({ numerator: 0, denominator: 1 });
    expect(byId['supplied-verdict']).toMatchObject({ numerator: 1, denominator: 1 });
    expect(byId['search-genuine-accepted']).toMatchObject({ numerator: 0, denominator: 1 });
    expect(byId['retrieval-failure']).toMatchObject({
      numerator: 1,
      denominator: 1,
      direction: 'lower',
    });
    expect(byId['interpretation-failure']).toMatchObject({ numerator: 0, denominator: 1 });
    expect(byId['supplied-spans-read']).toBeUndefined();
    expect(parsed.acceptance.accepted).toBe(true);
  });

  it('is never accepted below K=3 or with an outage', () => {
    expect(parsePriorArt(workflowBlock(1)).acceptance).toMatchObject({ accepted: false });
    expect(parsePriorArt(workflowBlock(3, 1)).acceptance.reason).toMatch(/zero outages/);
  });
});
