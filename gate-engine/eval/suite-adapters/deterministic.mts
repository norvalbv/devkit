import type { MetricObservation, ParsedBaseline } from '../types.mts';

// biome-ignore lint/suspicious/noExplicitAny: adapters intentionally normalize suite-owned JSON.
type Json = Record<string, any>;
type Direction = 'higher' | 'lower';
type Ratio = (
  id: string,
  label: string,
  numerator: number,
  denominator: number,
  direction: Direction,
  extra: Partial<MetricObservation>,
) => MetricObservation;
type Scalar = (
  id: string,
  label: string,
  value: number,
  direction: Direction,
  unit: MetricObservation['unit'],
  extra: Partial<MetricObservation>,
) => MetricObservation;

/**
 * Parse a suite that publishes exact metrics instead of a suite-specific judged result.
 * Acceptance is closed: metrics, per-case evidence, and an explicit true floorsMet are required.
 */
export function parseDeterministic(
  input: Json,
  helpers: { ratio: Ratio; scalar: Scalar },
): ParsedBaseline {
  const declared = Array.isArray(input.metrics) ? (input.metrics as Json[]) : [];
  const metrics: MetricObservation[] = [];
  for (const metric of declared) {
    if (!metric || typeof metric !== 'object' || typeof metric.id !== 'string') continue;
    const label = String(metric.label ?? metric.id);
    const direction = metric.direction === 'lower' ? 'lower' : 'higher';
    const extra: Partial<MetricObservation> = { inferenceUnit: 'case' };
    if (Number.isFinite(metric.noiseFloor)) extra.noiseFloor = metric.noiseFloor;
    if (typeof metric.k === 'number' && typeof metric.n === 'number' && metric.n > 0)
      metrics.push(helpers.ratio(metric.id, label, metric.k, metric.n, direction, extra));
    else if (typeof metric.value === 'number')
      metrics.push(helpers.scalar(metric.id, label, metric.value, direction, 'ratio', extra));
  }
  const rows = input.rows && typeof input.rows === 'object' ? (input.rows as Json) : {};
  const floorsMet = input.floorsMet === true;
  const accepted = metrics.length > 0 && Object.keys(rows).length > 0 && floorsMet;
  return {
    metrics,
    rows,
    acceptance: {
      accepted,
      reason: accepted
        ? 'Deterministic suite: declared floors met, with per-case evidence'
        : metrics.length === 0
          ? 'No metrics published — an empty run is not a pass'
          : floorsMet
            ? 'No per-case evidence recorded'
            : 'A declared floor was not met',
    },
  };
}
