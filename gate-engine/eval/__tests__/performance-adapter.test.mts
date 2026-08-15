import { describe, expect, it } from 'vitest';
import { parseBaseline } from '../adapters.mts';
import { checkpointErrors } from '../schema.mts';

const stats = { count: 10, min: 1, median: 2, max: 3, p95NearestRank: 3 };
const sample = (round: number) => ({ phase: 'measured', round });

const baseline = () => ({
  schemaVersion: 1,
  experimentId: 'quality-gates',
  protocol: { warmupsPerContender: 3, measurementsPerContender: 10 },
  acceptance: { accepted: true },
  lanes: [
    {
      id: 'lint',
      label: 'Lint',
      parity: { comparable: true },
      contenders: [
        {
          id: 'tool',
          label: 'Tool',
          samples: Array.from({ length: 10 }, (_, index) => sample(index)),
          summary: {
            wallSeconds: stats,
            cpuTotalSeconds: stats,
            maxResidentSetBytes: stats,
          },
        },
      ],
    },
  ],
});

describe('performance evidence adapter', () => {
  it('publishes seconds and bytes through the existing tracker schema', () => {
    const parsed = parseBaseline('performance', baseline());
    expect(parsed.acceptance.accepted).toBe(true);
    expect(parsed.metrics).toHaveLength(6);
    expect(parsed.metrics.find((metric) => metric.unit === 'bytes')).toMatchObject({
      value: 2,
      direction: 'lower',
    });
    const checkpoint = {
      schemaVersion: 1,
      suiteId: 'quality-gates',
      capturedAt: '2026-08-15T00:00:00.000Z',
      sourceCommit: 'a'.repeat(40),
      adapter: 'performance',
      hashes: {
        implementation: `sha256:${'a'.repeat(64)}`,
        corpus: `sha256:${'b'.repeat(64)}`,
        scorer: `sha256:${'c'.repeat(64)}`,
        runner: `sha256:${'d'.repeat(64)}`,
      },
      metrics: parsed.metrics,
      comparisons: [],
      rows: parsed.rows,
      acceptance: parsed.acceptance,
    };
    expect(checkpointErrors(checkpoint, 'checkpoint')).not.toContain(
      'checkpoint.metrics[4]: invalid metric unit',
    );
  });

  it('rejects incomplete samples or failed diagnostic parity', () => {
    const incomplete = baseline();
    const incompleteLane = incomplete.lanes[0];
    const incompleteContender = incompleteLane?.contenders[0];
    if (!incompleteContender) throw new Error('fixture contender missing');
    incompleteContender.samples.pop();
    expect(parseBaseline('performance', incomplete).acceptance.accepted).toBe(false);
    const mismatch = baseline();
    const mismatchLane = mismatch.lanes[0];
    if (!mismatchLane) throw new Error('fixture lane missing');
    mismatchLane.parity.comparable = false;
    expect(parseBaseline('performance', mismatch).acceptance.accepted).toBe(false);
  });
});
