import type { MetricObservation, ParsedBaseline } from '../types.mts';

// biome-ignore lint/suspicious/noExplicitAny: adapters normalize suite-owned JSON shapes.
type Json = Record<string, any>;

function finite(value: unknown, location: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${location} must be a non-negative finite number`);
  return value;
}

function metric(
  id: string,
  label: string,
  value: number,
  unit: MetricObservation['unit'],
): MetricObservation {
  return {
    id,
    label,
    value,
    unit,
    direction: 'lower',
    inferenceUnit: 'command run',
  };
}

/** Parse the sanitized output of the quality-gate performance harness. */
export function parsePerformanceBaseline(input: Json): ParsedBaseline {
  if (input.schemaVersion !== 1 || !Array.isArray(input.lanes))
    throw new Error('performance baseline must use schemaVersion 1 with lanes[]');
  const warmups = finite(input.protocol?.warmupsPerContender, 'protocol.warmupsPerContender');
  const measurements = finite(
    input.protocol?.measurementsPerContender,
    'protocol.measurementsPerContender',
  );
  const metrics: MetricObservation[] = [];
  let complete = warmups >= 3 && measurements >= 10;
  for (const lane of input.lanes as Json[]) {
    if (!lane || typeof lane.id !== 'string' || !Array.isArray(lane.contenders)) {
      complete = false;
      continue;
    }
    if (lane.parity?.comparable !== true) complete = false;
    for (const contender of lane.contenders as Json[]) {
      if (!contender || typeof contender.id !== 'string') {
        complete = false;
        continue;
      }
      const measured = Array.isArray(contender.samples)
        ? contender.samples.filter((sample: Json) => sample?.phase === 'measured')
        : [];
      if (measured.length !== measurements) complete = false;
      const prefix = `${lane.id}.${contender.id}`;
      const label = `${String(lane.label ?? lane.id)} · ${String(contender.label ?? contender.id)}`;
      const summary = contender.summary as Json | undefined;
      for (const [field, unit, title] of [
        ['wallSeconds', 'seconds', 'wall'],
        ['cpuTotalSeconds', 'seconds', 'CPU'],
        ['maxResidentSetBytes', 'bytes', 'max RSS'],
      ] as const) {
        const values = summary?.[field] as Json | undefined;
        const median = finite(values?.median, `${prefix}.${field}.median`);
        const p95 = finite(values?.p95NearestRank, `${prefix}.${field}.p95NearestRank`);
        metrics.push(metric(`${prefix}.${field}.median`, `${label} median ${title}`, median, unit));
        metrics.push(
          metric(`${prefix}.${field}.p95`, `${label} nearest-rank p95 ${title}`, p95, unit),
        );
      }
    }
  }
  const accepted = input.acceptance?.accepted === true && complete && metrics.length > 0;
  return {
    metrics,
    rows: { experiment: input },
    acceptance: {
      accepted,
      reason: accepted
        ? 'Performance experiment completed with stable manifests, samples, and diagnostic parity'
        : 'Performance experiment is incomplete or failed its parity/protocol contract',
    },
  };
}
