import {
  DECISIONS_ACCEPTANCE,
  selectAlignmentContradiction,
} from '../decisions/eval/acceptance.mts';
import { wilsonScoreInterval } from './statistics.mts';
import type { MetricObservation, ParsedBaseline } from './types.mts';

// biome-ignore lint/suspicious/noExplicitAny: adapters intentionally normalize heterogeneous, suite-owned JSON shapes.
type Json = Record<string, any>;

function ratio(
  id: string,
  label: string,
  numerator: number,
  denominator: number,
  direction: 'higher' | 'lower' = 'higher',
  extra: Partial<MetricObservation> = {},
): MetricObservation {
  return {
    id,
    label,
    numerator,
    denominator,
    value: denominator === 0 ? 0 : numerator / denominator,
    unit: 'ratio',
    direction,
    inferenceUnit: 'row',
    interval: wilson(numerator, denominator),
    ...extra,
  };
}

function scalar(
  id: string,
  label: string,
  value: number,
  direction: 'higher' | 'lower' | 'target',
  unit: MetricObservation['unit'] = 'score',
  extra: Partial<MetricObservation> = {},
): MetricObservation {
  return { id, label, value, direction, unit, inferenceUnit: 'run', ...extra };
}

export function wilson(successes: number, total: number): MetricObservation['interval'] {
  const { lower, upper } = wilsonScoreInterval(successes, total);
  return {
    method: 'wilson-95',
    lower,
    upper,
  };
}

function rows(value: Json): Record<string, unknown> {
  return value.rows && typeof value.rows === 'object' ? value.rows : {};
}

export function parseCritique(input: Json): ParsedBaseline {
  const value = input.critique ?? input;
  const metrics = [
    ratio('recall', 'Gold finding recall', value.recall.hits, value.recall.total, 'higher', {
      floor: 0.75,
    }),
    ratio('clean-rate', 'Clean-plan pass rate', value.cleanRate.clean, value.cleanRate.total),
    ratio(
      'decoy-flag-rate',
      'Decoy flag rate',
      value.decoyFlags.flagged,
      value.decoyFlags.total,
      'lower',
    ),
    ratio(
      'verdict-accuracy',
      'Verdict accuracy',
      value.verdictAccuracy.correct,
      value.verdictAccuracy.total,
    ),
    ratio(
      'frame-accuracy',
      'Frame metadata accuracy',
      value.frameMetaAccuracy.correct,
      value.frameMetaAccuracy.total,
    ),
    ratio(
      'severity-exact',
      'Severity exact match',
      value.severityCalibration.exact,
      value.severityCalibration.total,
    ),
  ];
  const budget = value.contract?.withinTokenBudget;
  if (budget) metrics.push(ratio('token-budget', 'Within token budget', budget.ok, budget.total));
  const accepted = value.outages === 0 && value.runs >= 3 && value.matchRuns >= 3;
  return {
    metrics,
    rows: rows(value),
    acceptance: {
      accepted,
      reason: accepted ? 'K=3 full run with zero outages' : 'Requires K=3 and zero outages',
    },
  };
}

function parseOpenEnded(input: Json, key: 'completeness' | 'conventions'): ParsedBaseline {
  const value = input[key] ?? input;
  const metrics = [
    ratio('gap-recall', 'Gold gap recall', value.gold.hit, value.gold.total, 'higher', {
      floor: 0.7,
    }),
    ratio(
      'false-flag-rate',
      'Decoy false-flag rate',
      value.decoys.flagged,
      value.decoys.total,
      'lower',
      {
        ceiling: 0.25,
      },
    ),
  ];
  if (value.verdicts) {
    metrics.push(
      ratio('verdict-accuracy', 'Verdict accuracy', value.verdicts.correct, value.verdicts.total),
    );
  }
  if (value.severity) {
    metrics.push(
      ratio('severity-exact', 'Severity exact match', value.severity.exact, value.severity.total),
    );
  }
  const accepted = value.outages === 0 && value.matchRuns >= 3;
  return {
    metrics,
    rows: rows(value),
    acceptance: {
      accepted,
      reason: accepted
        ? 'Full matcher tier with K=3 and zero outages'
        : 'Requires K=3 and zero outages',
    },
  };
}

export const parseCompleteness = (input: Json) => parseOpenEnded(input, 'completeness');
export const parseConventions = (input: Json) => parseOpenEnded(input, 'conventions');

export function parseReviewer(input: Json): ParsedBaseline {
  const entries = Object.entries(input.sections ?? input.reviewers ?? input).filter(
    ([, value]) => value && typeof value === 'object',
  );
  const metrics: MetricObservation[] = [];
  const allRows: Record<string, unknown> = {};
  const cohorts = new Map<
    string,
    {
      model: string;
      cascade: boolean;
      firstFail: { k: number; n: number };
      blockRecall: { k: number; n: number };
      cleanPass: { k: number; n: number };
    }
  >();
  let outages = 0;
  let completeSections = 0;
  for (const [key, raw] of entries) {
    const value = raw as Json;
    const summary = (value.metrics ?? value) as Json;
    const gold = summary.gold ?? summary.blockRecall ?? summary.endToEnd?.gold;
    const decoy = summary.decoys ?? summary.cleanPass ?? summary.endToEnd?.decoys;
    const firstFail = summary.firstFailRecall;
    const firstClean = summary.firstCleanPass;
    const cascade = value.cascade === true || key.endsWith('@cascade-on');
    const model = String(value.model ?? key.split('@').at(-2) ?? 'unknown');
    const cohortKey = `${model}@${cascade ? 'cascade-on' : 'cascade-off'}`;
    const cohort = cohorts.get(cohortKey) ?? {
      model,
      cascade,
      firstFail: { k: 0, n: 0 },
      blockRecall: { k: 0, n: 0 },
      cleanPass: { k: 0, n: 0 },
    };
    let sectionMetrics = 0;
    if (firstFail?.k !== undefined && firstFail?.n !== undefined) {
      metrics.push(
        ratio(
          `${key}:first-fail-recall`,
          `${key} first-pass FAIL recall`,
          firstFail.k,
          firstFail.n,
        ),
      );
      cohort.firstFail.k += Number(firstFail.k);
      cohort.firstFail.n += Number(firstFail.n);
      sectionMetrics += 1;
    }
    if (firstClean?.k !== undefined && firstClean?.n !== undefined) {
      metrics.push(
        ratio(
          `${key}:first-clean-pass`,
          `${key} first-pass clean pass`,
          firstClean.k,
          firstClean.n,
        ),
      );
      sectionMetrics += 1;
    }
    if (gold?.hit !== undefined && gold?.total !== undefined) {
      metrics.push(ratio(`${key}:block-recall`, `${key} block recall`, gold.hit, gold.total));
      cohort.blockRecall.k += Number(gold.hit);
      cohort.blockRecall.n += Number(gold.total);
      sectionMetrics += 1;
    } else if (gold?.k !== undefined && gold?.n !== undefined) {
      metrics.push(ratio(`${key}:block-recall`, `${key} block recall`, gold.k, gold.n));
      cohort.blockRecall.k += Number(gold.k);
      cohort.blockRecall.n += Number(gold.n);
      sectionMetrics += 1;
    }
    if (decoy?.clean !== undefined && decoy?.total !== undefined) {
      metrics.push(ratio(`${key}:clean-pass`, `${key} clean pass`, decoy.clean, decoy.total));
      cohort.cleanPass.k += Number(decoy.clean);
      cohort.cleanPass.n += Number(decoy.total);
      sectionMetrics += 1;
    } else if (decoy?.k !== undefined && decoy?.n !== undefined) {
      metrics.push(ratio(`${key}:clean-pass`, `${key} clean pass`, decoy.k, decoy.n));
      cohort.cleanPass.k += Number(decoy.k);
      cohort.cleanPass.n += Number(decoy.n);
      sectionMetrics += 1;
    }
    cohorts.set(cohortKey, cohort);
    if (sectionMetrics >= 2) completeSections += 1;
    outages +=
      Number(value.outages ?? 0) +
      Number(summary.inconclusive?.outage ?? 0) +
      Number(summary.inconclusive?.['engine-error'] ?? 0);
    for (const [rowId, row] of Object.entries(rows(value))) {
      const native = row as Json;
      const ok = cascade ? native.okFinal : native.okFirst;
      allRows[`${key}:${rowId}`] = typeof ok === 'boolean' ? { ...native, ok } : row;
    }
  }
  const ratioAtLeast = (count: { k: number; n: number }, floor: number) =>
    count.n > 0 && count.k / count.n >= floor;
  const floorsPass = [...cohorts.values()].every(
    (cohort) =>
      (cohort.model !== 'sonnet' || ratioAtLeast(cohort.firstFail, 0.6)) &&
      (!cohort.cascade ||
        (ratioAtLeast(cohort.blockRecall, 0.75) && ratioAtLeast(cohort.cleanPass, 0.85))),
  );
  const accepted =
    entries.length > 0 &&
    completeSections === entries.length &&
    Object.keys(allRows).length > 0 &&
    outages === 0 &&
    floorsPass;
  return {
    metrics,
    rows: allRows,
    acceptance: {
      accepted,
      reason: accepted
        ? 'Complete reviewer cohorts with row evidence, zero outages, and suite floors met'
        : 'Incomplete reviewer cohort, outage, or suite-floor breach',
    },
  };
}

export function parseDecisions(input: Json): ParsedBaseline {
  const root = input.decisions ?? input;
  const metrics: MetricObservation[] = [];
  const detect = root.detect ?? root.detection;
  const alignment = root.alignment;
  const depth = root.depth;
  if (detect?.correct !== undefined) {
    metrics.push(
      ratio('detect-accuracy', 'Decision detection accuracy', detect.correct, detect.total),
    );
  }
  if (detect?.decision?.hit !== undefined) {
    metrics.push(
      ratio(
        'decision-recall',
        'DECISION recall',
        detect.decision.hit,
        detect.decision.total,
        'higher',
        { floor: DECISIONS_ACCEPTANCE.floors.decisionRecall },
      ),
    );
  } else if (detect?.decision?.tp !== undefined && detect?.decision?.fn !== undefined) {
    metrics.push(
      ratio(
        'decision-recall',
        'DECISION recall',
        detect.decision.tp,
        detect.decision.tp + detect.decision.fn,
        'higher',
        { floor: DECISIONS_ACCEPTANCE.floors.decisionRecall },
      ),
    );
  }
  const nativeContradiction = selectAlignmentContradiction<Json>(alignment ?? {});
  if (alignment?.contradiction?.correct !== undefined) {
    metrics.push(
      ratio(
        'contradiction-precision',
        'CONTRADICT precision',
        alignment.contradiction.correct,
        alignment.contradiction.total,
        'higher',
        { floor: DECISIONS_ACCEPTANCE.floors.contradictionPrecision },
      ),
    );
  } else if (nativeContradiction?.tp !== undefined && nativeContradiction?.fp !== undefined) {
    metrics.push(
      ratio(
        'contradiction-precision',
        'CONTRADICT precision',
        nativeContradiction.tp,
        nativeContradiction.tp + nativeContradiction.fp,
        'higher',
        { floor: DECISIONS_ACCEPTANCE.floors.contradictionPrecision },
      ),
    );
  }
  if (depth?.correct !== undefined) {
    metrics.push(
      ratio('depth-accuracy', 'Depth accuracy', depth.correct, depth.total, 'higher', {
        floor: DECISIONS_ACCEPTANCE.floors.depthAccuracy,
      }),
    );
  }
  const outages =
    Number(root.outages ?? detect?.outages ?? 0) +
    Number(alignment?.outages ?? 0) +
    Number(depth?.outages ?? 0);
  const detectRows = rows(detect ?? {});
  const alignmentRows = rows(alignment ?? {});
  const depthRows = rows(depth ?? {});
  const nativeRows = Object.fromEntries(
    [
      ['detect', detectRows],
      ['alignment', alignmentRows],
      ['depth', depthRows],
    ].flatMap(([tier, tierRows]) =>
      Object.entries(tierRows as Record<string, unknown>).map(([id, row]) => [
        `${tier}:${id}`,
        row,
      ]),
    ),
  );
  const complete =
    metrics.some((metric) => metric.id === 'detect-accuracy') &&
    metrics.some((metric) => metric.id === 'decision-recall') &&
    metrics.some((metric) => metric.id === 'contradiction-precision') &&
    metrics.some((metric) => metric.id === 'depth-accuracy') &&
    Object.keys(detectRows).length > 0 &&
    Object.keys(alignmentRows).length > 0 &&
    Object.keys(depthRows).length > 0;
  const runsPass =
    Number(detect?.runs ?? 0) >= DECISIONS_ACCEPTANCE.runs.detect &&
    Number(alignment?.runs ?? 0) === DECISIONS_ACCEPTANCE.runs.alignment &&
    Number(depth?.runs ?? 0) >= DECISIONS_ACCEPTANCE.runs.depth;
  const alignmentStable = Object.values(alignmentRows).every(
    (row) => row !== null && typeof row === 'object' && (row as Json).stable === true,
  );
  const floorsPass = metrics
    .filter((metric) =>
      ['decision-recall', 'contradiction-precision', 'depth-accuracy'].includes(metric.id),
    )
    .every((metric) => metric.value >= (metric.floor ?? 0));
  const accepted = complete && outages === 0 && runsPass && alignmentStable && floorsPass;
  return {
    metrics,
    rows: nativeRows,
    acceptance: {
      accepted,
      reason: accepted
        ? 'Detect/depth completed at K>=3 and alignment at K=1 with confirmed stable rows, zero outages, and floors met'
        : 'Incomplete decision run, invalid tier K, unstable alignment row, outage, or suite-floor breach',
    },
  };
}

export function parseSentry(input: Json): ParsedBaseline {
  const value = input.sentry ?? input.best ?? input;
  const metrics: MetricObservation[] = [];
  const resultRows: Json[] = Array.isArray(value.results)
    ? value.results.filter((row: unknown): row is Json => Boolean(row && typeof row === 'object'))
    : [];
  const sentryRows = Object.fromEntries(
    resultRows
      .filter((row) => row && typeof row === 'object' && typeof row.id === 'string')
      .map((row) => [row.id, { expected: row.expected, got: row.got, ok: row.ok }]),
  );
  const tp = resultRows.filter((row) => row.expected === 'MONITOR' && row.got === 'MONITOR').length;
  const fp = resultRows.filter((row) => row.expected === 'SKIP' && row.got === 'MONITOR').length;
  const fn = resultRows.filter((row) => row.expected === 'MONITOR' && row.got !== 'MONITOR').length;
  if (resultRows.length > 0) {
    metrics.push(ratio('precision', 'Precision', tp, tp + fp));
    metrics.push(ratio('recall', 'Recall', tp, tp + fn));
  } else {
    if (value.precision !== undefined)
      metrics.push(scalar('precision', 'Precision', value.precision, 'higher', 'ratio'));
    if (value.recall !== undefined)
      metrics.push(scalar('recall', 'Recall', value.recall, 'higher', 'ratio'));
  }
  if (value.f1 !== undefined) metrics.push(scalar('f1', 'F1', value.f1, 'higher', 'ratio'));
  const accepted =
    metrics.length >= 3 && Object.keys(sentryRows).length > 0 && Number(value.outages ?? 0) === 0;
  return {
    metrics,
    rows: Object.keys(sentryRows).length > 0 ? sentryRows : rows(value),
    acceptance: {
      accepted,
      reason: accepted
        ? 'Complete row-backed precision/recall/F1 cell'
        : 'Reported summary lacks complete persisted row evidence',
    },
  };
}

export function parseEdgeCases(input: Json): ParsedBaseline {
  const best = input.metrics?.[input.best] ?? {};
  const metrics = [
    scalar('ceiling', 'Judge-free ceiling', input.C, 'higher', 'ratio'),
    scalar('target', 'Pre-registered target', input.T, 'target', 'ratio'),
    scalar(
      'best-admissible-recall',
      'Best guard-passing macro recall',
      best.macroRecall ?? 0,
      'higher',
      'ratio',
      { floor: input.T },
    ),
    scalar('guard-fire-rate', 'Guard false-fire rate', best.guardFireRate ?? 0, 'lower', 'ratio', {
      ceiling: 0.2,
    }),
    scalar('receipts', 'Receipts recovered', best.receiptsHit ?? 0, 'higher', 'count', {
      floor: 4,
    }),
  ];
  return {
    metrics,
    rows: input.winnerPerCaseBinary ?? input.winnerGuardFired ?? {},
    acceptance: {
      accepted: input.noConfigShips === true,
      reason:
        input.noConfigShips === true
          ? 'Pre-registered no-ship analysis completed'
          : 'No locked no-ship verdict',
    },
  };
}

const ADAPTERS: Record<string, (input: Json) => ParsedBaseline> = {
  critique: parseCritique,
  completeness: parseCompleteness,
  conventions: parseConventions,
  reviewer: parseReviewer,
  decisions: parseDecisions,
  sentry: parseSentry,
  'edge-cases': parseEdgeCases,
};

export function parseBaseline(adapter: string, input: unknown): ParsedBaseline {
  const fn = ADAPTERS[adapter];
  if (!fn) throw new Error(`Unknown benchmark adapter: ${adapter}`);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${adapter} baseline must be a JSON object`);
  return fn(input as Json);
}
