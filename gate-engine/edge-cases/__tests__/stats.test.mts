/**
 * Textbook-value tests for lib/stats.mts. The bench's decision rule and the noise-audit gate run
 * on these functions — a wrong κ/AC1/CI here silently corrupts the pre-registered analysis, so
 * each is pinned to published/known values, and the Beta sampler to its bit-reproducibility
 * contract (one uniform draw per sample, grid inverse-CDF).
 */

import { describe, expect, it } from 'vitest';
import {
  bcaCI,
  betainc,
  betaSamplerGrid,
  clopperPearson,
  cohenKappa,
  gwetAC1,
  mcnemarMidP,
  mean,
  mulberry32,
  normQuantile,
  pabak,
  percentileCI,
  sd,
} from '../eval/lib/stats.mts';

/** Expand a 2×2 confusion table into label pairs: [bothYes, aYesBNo, aNoBYes, bothNo]. */
const tableToPairs = (yy, yn, ny, nn) => [
  ...Array.from({ length: yy }, () => ['yes', 'yes']),
  ...Array.from({ length: yn }, () => ['yes', 'no']),
  ...Array.from({ length: ny }, () => ['no', 'yes']),
  ...Array.from({ length: nn }, () => ['no', 'no']),
];

describe('agreement statistics', () => {
  // classic worked example (e.g. Gwet 2008): 118 items, Po=0.915, high prevalence skew
  const skewed = tableToPairs(100, 5, 5, 8);

  it("Cohen's κ matches hand computation on a textbook table", () => {
    // Po = 108/118; Pe = (105/118)(105/118) + (13/118)(13/118)
    const po = 108 / 118;
    const pe = (105 / 118) ** 2 + (13 / 118) ** 2;
    expect(cohenKappa(skewed)).toBeCloseTo((po - pe) / (1 - pe), 10);
  });

  it('κ paradox: AC1 stays high under prevalence skew where κ collapses', () => {
    const k = cohenKappa(skewed);
    const ac1 = gwetAC1(skewed);
    expect(ac1).toBeGreaterThan(k); // the reason AC1 is the gate statistic
    expect(ac1).toBeGreaterThan(0.85);
  });

  it('single-class pairs: κ is NaN (undefined), AC1 = raw agreement', () => {
    const pairs = tableToPairs(10, 0, 0, 0);
    expect(Number.isNaN(cohenKappa(pairs))).toBe(true);
    expect(gwetAC1(pairs)).toBe(1);
  });

  it('PABAK is 2·Po − 1 for two classes', () => {
    expect(pabak(skewed)).toBeCloseTo(2 * (108 / 118) - 1, 10);
  });

  it('perfect disagreement bounds', () => {
    const pairs = tableToPairs(0, 5, 5, 0);
    expect(pabak(pairs)).toBe(-1);
    expect(gwetAC1(pairs)).toBeLessThan(0);
  });
});

describe('exact binomial machinery', () => {
  it('McNemar mid-p on known discordant counts', () => {
    // b=1, c=8: exact two-sided p = 2·Σ_{i≤1} C(9,i)(.5)^9 = 0.0390625; mid-p subtracts half of P(X=1)
    const exact = 2 * ((1 + 9) / 512);
    const midP = exact - binom(9, 1);
    expect(mcnemarMidP(1, 8).midP).toBeCloseTo(midP, 10);
    expect(mcnemarMidP(0, 0).midP).toBe(1);
    // b+c=4 floor: even perfect asymmetry cannot reach 0.05 (why this is descriptive-only)
    expect(mcnemarMidP(0, 4).midP).toBeGreaterThan(0.05);
  });

  const binom = (n, k) => {
    let c = 1;
    for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
    return c * 0.5 ** n;
  };

  it('betainc matches known values', () => {
    expect(betainc(0.5, 1, 1)).toBeCloseTo(0.5, 12); // uniform CDF
    expect(betainc(0.25, 2, 2)).toBeCloseTo(3 * 0.25 ** 2 - 2 * 0.25 ** 3, 10); // I_x(2,2)=3x²−2x³
  });

  it('Clopper-Pearson matches published intervals', () => {
    // 0 of 10: upper = 1 − 0.025^(1/10) ≈ 0.3085
    const z = clopperPearson(0, 10);
    expect(z.lower).toBe(0);
    expect(z.upper).toBeCloseTo(1 - 0.025 ** (1 / 10), 4);
    // 10 of 10 mirrors
    const full = clopperPearson(10, 10);
    expect(full.upper).toBe(1);
    expect(full.lower).toBeCloseTo(0.025 ** (1 / 10), 4);
  });
});

describe('samplers and quantiles', () => {
  it('Beta(1,1) inverse-CDF grid is the identity (uniform)', () => {
    const sample = betaSamplerGrid(1, 1);
    for (const u of [0.1, 0.25, 0.5, 0.9]) expect(sample(u)).toBeCloseTo(u, 3);
  });

  it('Beta sampler is bit-reproducible from the same PRNG seed', () => {
    const draw = () => {
      const rng = mulberry32(1119);
      const sample = betaSamplerGrid(3, 9);
      return Array.from({ length: 5 }, () => sample(rng()));
    };
    expect(draw()).toEqual(draw());
  });

  it('Beta(3,9) samples center near the mean 0.25', () => {
    const rng = mulberry32(7);
    const sample = betaSamplerGrid(3, 9);
    const xs = Array.from({ length: 4000 }, () => sample(rng()));
    expect(mean(xs)).toBeGreaterThan(0.23);
    expect(mean(xs)).toBeLessThan(0.27);
  });

  it('normal quantile matches known points', () => {
    expect(normQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normQuantile(0.025)).toBeCloseTo(-1.959964, 4);
  });
});

describe('wilcoxon signed-rank', () => {
  it('is symmetric and null on zero diffs', async () => {
    const { wilcoxonSignedRank } = await import('../eval/lib/stats.mts');
    const d = [0.3, -0.1, 0.2, 0.4, -0.05, 0.15];
    const pos = wilcoxonSignedRank(d);
    const neg = wilcoxonSignedRank(d.map((x) => -x));
    expect(pos.p).toBeCloseTo(neg.p, 10);
    expect(wilcoxonSignedRank([0, 0, 0]).p).toBe(1);
  });

  it('one-sided dominance yields small p at n=10', async () => {
    const { wilcoxonSignedRank } = await import('../eval/lib/stats.mts');
    const r = wilcoxonSignedRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => x / 10));
    expect(r.w).toBe(55);
    expect(r.p).toBeLessThan(0.01);
  });
});

describe('bootstrap CIs', () => {
  it('percentile CI brackets the replicate distribution', () => {
    const rng = mulberry32(42);
    const reps = Array.from({ length: 2000 }, () => rng());
    const ci = percentileCI(reps);
    expect(ci.lower).toBeCloseTo(0.025, 1);
    expect(ci.upper).toBeCloseTo(0.975, 1);
  });

  it('BCa reduces to a sane interval and degrades gracefully', () => {
    const rng = mulberry32(43);
    const data = Array.from({ length: 19 }, () => rng());
    const observed = mean(data);
    const reps = Array.from({ length: 2000 }, () => {
      const re = Array.from({ length: data.length }, () => data[Math.floor(rng() * data.length)]);
      return mean(re);
    });
    const jack = data.map((_, i) => mean(data.filter((_, j) => j !== i)));
    const ci = bcaCI(reps, observed, jack);
    expect(ci.lower).toBeLessThan(observed);
    expect(ci.upper).toBeGreaterThan(observed);
    // degenerate replicates → percentile fallback, no NaN
    const flat = bcaCI([1, 1, 1, 1], 1, [1, 1, 1]);
    expect(Number.isNaN(flat.lower)).toBe(false);
  });

  it('sd matches a hand example', () => {
    expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });
});
