import type { MetricObservation, ParsedBaseline } from '../types.mts';

// biome-ignore lint/suspicious/noExplicitAny: adapters intentionally normalize suite-owned JSON.
type Json = Record<string, any>;
type Ratio = (
  id: string,
  label: string,
  numerator: number,
  denominator: number,
  direction?: 'higher' | 'lower',
  extra?: Partial<MetricObservation>,
) => MetricObservation;

/**
 * Parse the prior-art suite's baseline (gate-engine/prior-art/eval/bench.mts output). Split from
 * adapters.mts for the size cap; the ADAPTERS registration stays there.
 */
export function parsePriorArtBaseline(
  input: Json,
  helpers: { ratio: Ratio; rows: (value: Json) => Record<string, unknown> },
): ParsedBaseline {
  if (input.priorArtWorkflow) return parsePriorArtWorkflow(input.priorArtWorkflow, helpers);
  const { ratio, rows } = helpers;
  const value = input.priorArt ?? input;
  const metrics = [
    ratio(
      'verdict-accuracy',
      'Verdict accuracy',
      value.verdictAccuracy.correct,
      value.verdictAccuracy.total,
    ),
  ];
  // A partial run (bench --only over a contract-only row) legitimately writes zero denominators
  // for the slot/framing metrics — omit those metrics rather than let ratio() throw and break
  // every baseline reader (the same guard deterministic.mts applies).
  if (value.framingAccuracy.total > 0)
    metrics.push(
      ratio(
        'framing-accuracy',
        'Frame-challenge accuracy',
        value.framingAccuracy.correct,
        value.framingAccuracy.total,
      ),
    );
  if (value.goldRecall.total > 0)
    metrics.push(
      ratio('gold-recall', 'Gold evidence recall', value.goldRecall.hits, value.goldRecall.total),
    );
  if (value.decoyEndorsements.total > 0)
    metrics.push(
      ratio(
        'decoy-endorsement-rate',
        'Decoy endorsement rate',
        value.decoyEndorsements.endorsed,
        value.decoyEndorsements.total,
        'lower',
      ),
    );
  // The anti-"cry solved" floor. UNDERPOWERED at seed size (n=5 control rows) — reported with
  // its Wilson interval and no hard floor until Phase-5 mined rows give it resolution.
  if (value.genuineControls.total > 0)
    metrics.push(
      ratio(
        'genuine-clean-rate',
        'Genuine-control clean rate',
        value.genuineControls.clean,
        value.genuineControls.total,
      ),
    );
  const response = value.contract?.responseValid;
  if (response?.total > 0)
    metrics.push(
      ratio('response-contract', 'Valid response contract', response.ok, response.total),
    );
  // Acceptance needs the FULL corpus attested, not just K and outages: `bench.mts --only <rowId>`
  // over a contract-only row legitimately reports runs=3, matchRuns=3, outages=0 and zero slots,
  // which would otherwise read as a clean full run. Absent (pre-corpus-field) baselines fail this
  // by construction — `undefined > 0` is false — so the check is fail-closed, never grandfathered.
  const fullCorpus = value.corpus?.total > 0 && value.corpus?.executed === value.corpus?.total;
  const accepted = value.outages === 0 && value.runs >= 3 && value.matchRuns >= 3 && fullCorpus;
  return {
    metrics,
    rows: rows(value),
    acceptance: {
      accepted,
      reason: accepted
        ? 'K=3 full-corpus run with zero outages'
        : 'Requires K=3, zero outages, and every corpus row executed',
    },
  };
}

/** [metric suffix, label, block key, direction] for each per-condition `{ ok, total }` count. */
const WORKFLOW_METRICS: [string, string, string, ('higher' | 'lower')?][] = [
  ['valid', 'valid response', 'valid'],
  ['verdict', 'verdict accuracy', 'verdict'],
  ['framing', 'framing accuracy', 'framing'],
  ['leg-honesty', 'local-leg attestation honest', 'legHonesty'],
  ['recall-own', 'own-repo evidence recall', 'recallOwn'],
  ['recall-ref', 'reference-checkout evidence recall', 'recallRef'],
  ['spans-read', 'required spans read', 'spansRead'],
  ['spans-located', 'required spans located', 'spansLocated'],
  ['decoy-endorsement', 'decoy endorsement rate', 'decoyEndorsements', 'lower'],
  ['genuine-accepted', 'genuine work not dissolved', 'genuineAccepted'],
  ['insufficient-natural', 'insufficient-evidence calibration (natural)', 'insufficientNatural'],
  [
    'insufficient-artificial',
    'insufficient-evidence calibration (broken tool)',
    'insufficientArtificial',
  ],
  ['families-both-sides', 'families with every member correct', 'familiesBothSides'],
];

/** The frozen retrieval tier (gate-engine/prior-art/eval/workflow/): every measure per condition,
 *  never blended, plus the paired retrieval-vs-interpretation failure split. */
function conditionObservations(ratio: Ratio, condition: string, block: Json): MetricObservation[] {
  const observations = WORKFLOW_METRICS.filter(([, , key]) => block[key]?.total > 0).map(
    ([suffix, label, key, direction]) =>
      ratio(
        `${condition}-${suffix}`,
        `${label} (${condition})`,
        block[key].ok,
        block[key].total,
        direction,
      ),
  );
  const claims = block.claims ?? {};
  const local = ['supported', 'decoy', 'unjudged', 'unverifiable'].reduce(
    (sum, key) => sum + (claims[key] ?? 0),
    0,
  );
  if (local > 0)
    observations.push(
      ratio(
        `${condition}-claims-supported`,
        `local claims inside a gold span (${condition})`,
        claims.supported,
        local,
      ),
      ratio(
        `${condition}-claims-unjudged`,
        `local claims about unlabelled files (${condition})`,
        claims.unjudged,
        local,
        'lower',
      ),
    );
  return observations;
}

function pairedObservations(ratio: Ratio, paired: Json): MetricObservation[] {
  if (!(paired?.total > 0)) return [];
  return [
    ratio(
      'retrieval-failure',
      'Retrieval failures (supplied ✓, search ✗)',
      paired.retrievalFailure,
      paired.total,
      'lower',
    ),
    ratio(
      'interpretation-failure',
      'Interpretation failures (both ✗)',
      paired.interpretationFailure,
      paired.total,
      'lower',
    ),
  ];
}

function parsePriorArtWorkflow(
  value: Json,
  helpers: Parameters<typeof parsePriorArtBaseline>[1],
): ParsedBaseline {
  const { ratio, rows } = helpers;
  const metrics = [
    ...['search', 'supplied'].flatMap((condition) =>
      conditionObservations(ratio, condition, value.conditions?.[condition] ?? {}),
    ),
    ...pairedObservations(ratio, value.paired),
  ];
  const fullCorpus = value.cases?.total > 0 && value.cases?.executed === value.cases?.total;
  const clean = value.outages === 0 && value.faults === 0;
  const accepted = clean && value.runs >= 3 && value.matchRuns >= 3 && fullCorpus;
  return {
    metrics,
    rows: rows(value),
    acceptance: {
      accepted,
      reason: accepted
        ? 'K=3 full workflow tier with zero outages and zero harness faults'
        : 'Requires K=3, zero outages, zero harness faults, and every case executed',
    },
  };
}
