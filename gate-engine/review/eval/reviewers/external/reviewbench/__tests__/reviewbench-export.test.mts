/** Boundary between checkpoint rows and ReviewBench's judge: a finding without a file and line must
 * be withheld and counted, never sent, and an all-outage PR must be omitted rather than scored. */
import { describe, expect, it } from 'vitest';
import type { CheckpointRow } from '../../../scale/lens-run.mts';
import { exportReviewBench } from '../reviewbench-export.mts';

const row = (over: Partial<CheckpointRow>): CheckpointRow => ({
  key: 'k',
  diff: 'd',
  arm: 'whole',
  chunk: -1,
  group: 'state-transitions',
  status: 'fail',
  reason: '',
  issues: [],
  ms: 5,
  at: '2026-10-11T00:00:00Z',
  identity: 'id',
  ...over,
});
const base = {
  pr: { repo: 'https://github.com/o/r', pr_number: 1, base: 'b'.repeat(40), head: 'h'.repeat(40) },
  agent: 'devkit',
  staged: ['src/a.ts', 'src/b.ts'],
};

describe('exportReviewBench', () => {
  it('locates on the first staged mention that carries a line, keeps its range, counts what it withholds', () => {
    const out = exportReviewBench({
      ...base,
      rows: [
        row({
          issues: [
            { lens: 'state-transitions', text: 'src/b.ts is read but a.ts:12-14 clears the flag' },
            { lens: 'state-transitions', text: 'a.ts mutates shared state' },
            { lens: 'state-transitions', text: 'unawaited write somewhere' },
          ],
        }),
      ],
    });
    expect(out.file?.findings).toEqual([
      {
        producer: 'devkit',
        file: 'src/a.ts',
        start_line: 12,
        end_line: 14,
        message: '[state-transitions] src/b.ts is read but a.ts:12-14 clears the flag',
      },
    ]);
    expect(out).toMatchObject({
      withheldFileNoLine: 1,
      withheldFileNoLineStrict: 1,
      withheldNoFile: 1,
      crossFile: 1,
    });
    expect(out.file?.usage.time_in_ms).toBe(5);
  });

  it('omits a PR whose every lens task errored, and exports [] for a clean pass', () => {
    expect(exportReviewBench({ ...base, rows: [row({ status: 'error' })] }).file).toBeNull();
    expect(exportReviewBench({ ...base, rows: [row({ status: 'pass' })] }).file?.findings).toEqual(
      [],
    );
  });
});
