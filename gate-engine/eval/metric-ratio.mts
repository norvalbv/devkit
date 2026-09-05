/**
 * Ratio metric construction shared by the suite adapters (split out of adapters.mts, which
 * sits at its size ratchet). Also home of the reviewer-suite label-noise floor.
 */
import { wilsonScoreInterval } from './statistics.mts';
import type { MetricObservation } from './types.mts';

/** Reviewer-suite label-noise floor (sc-2496): the Wilson-95 UPPER bound of the 2/48 blind relabel,
 * chosen because n=48 makes the 4.2% point estimate no bound. Why: docs/decisions/corpus-rows-admitted-by-coverage-cell.md */
export const REVIEWER_LABEL_NOISE_FLOOR = 0.139;

export function wilson(successes: number, total: number): MetricObservation['interval'] {
  const { lower, upper } = wilsonScoreInterval(successes, total);
  return { method: 'wilson-95', lower, upper };
}

export function ratio(
  id: string,
  label: string,
  numerator: number,
  denominator: number,
  direction: 'higher' | 'lower' = 'higher',
  extra: Partial<MetricObservation> = {},
): MetricObservation {
  if (!Number.isFinite(denominator) || denominator <= 0)
    throw new Error(`Metric ${id} requires a positive denominator`);
  return {
    id,
    label,
    numerator,
    denominator,
    value: numerator / denominator,
    unit: 'ratio',
    direction,
    inferenceUnit: 'row',
    interval: wilson(numerator, denominator),
    ...extra,
  };
}

/** Repair edges sharing context are descriptive; uncertainty belongs to whole paired families. */
export function reviewerPairMetrics(
  key: string,
  pairs: { k: number; n: number; families?: number; familyK?: number },
): MetricObservation[] {
  const clustered = pairs.families !== undefined && pairs.families < pairs.n;
  const noise = { noiseFloor: REVIEWER_LABEL_NOISE_FLOOR };
  const result = [
    ratio(`${key}:pair-consistency`, `${key} pair consistency`, pairs.k, pairs.n, 'higher', {
      ...noise,
      inferenceUnit: 'repair-edge',
    }),
  ];
  if (clustered) delete result[0].interval;
  if (pairs.families && pairs.familyK !== undefined)
    result.push(
      ratio(
        `${key}:family-consistency`,
        `${key} paired families entirely correct`,
        pairs.familyK,
        pairs.families,
        'higher',
        { ...noise, inferenceUnit: 'family' },
      ),
    );
  return result;
}
