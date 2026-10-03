/** Probability a random positive outscores a random negative; ties count half. */
export function auroc(positives: number[], negatives: number[]): number {
  if (positives.length === 0 || negatives.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

function mean(values: number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export interface ScoredItem {
  id: string;
  label: string;
  score: number;
  /** The top-1 label, for choice questions only. */
  choice?: string;
}

interface Bands {
  blockAt: number;
  passAt: number;
}

function scoresFor(list: ScoredItem[], positive: string, want: boolean): number[] {
  return list.filter((item) => (item.label === positive) === want).map((item) => item.score);
}

export function summarizeVariant(
  variant: string,
  items: ScoredItem[],
  base: ScoredItem[],
  positive: string,
  bands: Bands,
  flipOption = positive,
) {
  const negatives = items.filter((item) => item.label !== positive);
  const baseScore = new Map(base.map((item) => [item.id, item.score]));
  const shifts = negatives
    .filter((item) => baseScore.has(item.id))
    .map((item) => item.score - (baseScore.get(item.id) ?? 0));
  const passingNegatives = negatives.filter((item) => item.score >= bands.passAt).length;
  const passing = items.filter((item) => item.score >= bands.passAt).length;
  const isBase = variant === 'base';
  return {
    variant,
    n: items.length,
    auroc: auroc(scoresFor(items, positive, true), scoresFor(items, positive, false)),
    /** Variant negatives against base positives: the padding attack's own separation. */
    paddedAuroc: isBase
      ? null
      : auroc(scoresFor(base, positive, true), scoresFor(items, positive, false)),
    /** Mean per-item score change of negatives versus base. */
    negativeShift: isBase ? null : mean(shifts),
    /** Negatives whose top-1 choice is the positive label; null for non-choice questions. */
    flipped: items.some((item) => item.choice !== undefined)
      ? negatives.filter((item) => item.choice === flipOption).length
      : null,
    block: items.filter((item) => item.score <= bands.blockAt),
    pass: { positives: passing - passingNegatives, negatives: passingNegatives },
  };
}
