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
