import { describe, expect, it } from 'vitest';
import {
  assertMinimumNodeVersion,
  balancedSchedule,
  type ExperimentSpec,
  parseExperimentSpec,
  summarize,
} from '../performance/model.mts';

const contender = (id: string) => ({
  id,
  label: id.toUpperCase(),
  command: {
    executable: 'node',
    args: ['-e', 'process.exitCode = 0'],
    versionArgs: ['--version'],
    expectedExit: 0,
    analyzer: 'none' as const,
  },
});

const validSpec = (): ExperimentSpec => ({
  schemaVersion: 1,
  id: 'quality-gates',
  sourceTree: 'HEAD',
  minimumNodeVersion: '22.0.0',
  timeoutMs: 10_000,
  warmupsPerContender: 3,
  measurementsPerContender: 10,
  localPatch: { path: 'gate-engine/config.mts', append: '\n// probe\n' },
  lanes: [
    {
      id: 'lint-local',
      label: 'Lint local',
      scope: 'local-staged',
      cwd: '.',
      inputs: { mode: 'changed', include: ['**/*.mts'], appendToArgs: false },
      contenders: [contender('a'), contender('b')],
    },
  ],
});

describe('performance experiment model', () => {
  it('accepts the required protocol and rejects unbalanced or undersampled comparisons', () => {
    expect(parseExperimentSpec(validSpec()).measurementsPerContender).toBe(10);
    expect(() => parseExperimentSpec({ ...validSpec(), warmupsPerContender: 2 })).toThrow(
      /warmupsPerContender/,
    );
    expect(() => parseExperimentSpec({ ...validSpec(), measurementsPerContender: 11 })).toThrow(
      /must be even/,
    );
  });

  it('uses balanced AB/BA measured rounds and retains the exact order', () => {
    const schedule = balancedSchedule(['a', 'b'], 3, 10);
    const measured = schedule.filter((sample) => sample.phase === 'measured');
    expect(measured).toHaveLength(20);
    expect(measured.slice(0, 8).map((sample) => sample.contenderId)).toEqual([
      'a',
      'b',
      'b',
      'a',
      'a',
      'b',
      'b',
      'a',
    ]);
    const first = measured.filter((_, index) => index % 2 === 0);
    expect(first.filter((sample) => sample.contenderId === 'a')).toHaveLength(5);
    expect(first.filter((sample) => sample.contenderId === 'b')).toHaveLength(5);
  });

  it('labels nearest-rank p95 honestly and retains min, median, max, and count', () => {
    expect(summarize([10, 4, 8, 1, 9, 2, 7, 3, 6, 5])).toEqual({
      count: 10,
      min: 1,
      median: 5.5,
      max: 10,
      p95NearestRank: 10,
    });
  });

  it('rejects runtimes below the pinned Node floor', () => {
    expect(() => assertMinimumNodeVersion('22.20.0', '23.6.0')).toThrow(/Node 23\.6\.0/);
    expect(() => assertMinimumNodeVersion('24.19.0', '23.6.0')).not.toThrow();
  });
});
