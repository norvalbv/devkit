/**
 * Dep-free statistics for the sc-1119 bench + noise audit. Everything here is deterministic and
 * seed-reproducible BY CONSTRUCTION (the pre-registration pins seeds; a rejection sampler whose
 * draw count varies per sample would break bit-reproducibility, so the Beta sampler is an
 * inverse-CDF-on-grid). Node-clean, unit-tested against textbook values in __tests__/stats.test.mts.
 *
 * Contents: mulberry32 PRNG · mean/sd · Cohen's κ · Gwet's AC1 · PABAK · exact McNemar (mid-p) ·
 * Clopper-Pearson interval (via regularized incomplete beta) · Beta inverse-CDF grid sampler ·
 * normal quantile · percentile + BCa bootstrap CIs.
 */

// ── PRNG (same generator kappa.mts uses; the sample must be reproducible) ────────────────────────
export const mulberry32 = (seed) => {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
export const sd = (xs) => {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

// ── inter-rater agreement over paired categorical labels ────────────────────────────────────────
// pairs: array of [labelA, labelB] strings. All three stats share observed agreement Po.

const observedAgreement = (pairs) =>
  pairs.filter(([a, b]) => String(a) === String(b)).length / pairs.length;

/** Cohen's κ. NaN when chance agreement is 1 (single class) — report raw agreement instead. */
export const cohenKappa = (pairs) => {
  if (!pairs.length) return Number.NaN;
  const po = observedAgreement(pairs);
  const cats = [...new Set(pairs.flat().map(String))];
  let pe = 0;
  for (const c of cats) {
    const pa = pairs.filter(([a]) => String(a) === c).length / pairs.length;
    const pb = pairs.filter(([, b]) => String(b) === c).length / pairs.length;
    pe += pa * pb;
  }
  if (1 - pe === 0) return Number.NaN;
  return (po - pe) / (1 - pe);
};

/** Gwet's AC1 — prevalence-robust chance correction (the gate statistic: κ collapses under the
 * corpus's 93/7 verdict skew, the "kappa paradox"). pe = Σ_c π_c(1-π_c)/(Q-1), π_c = mean of the
 * two raters' marginal proportions. Q=1 (single class observed) → chance ≈ 0 → AC1 = Po. */
export const gwetAC1 = (pairs) => {
  if (!pairs.length) return Number.NaN;
  const po = observedAgreement(pairs);
  const cats = [...new Set(pairs.flat().map(String))];
  if (cats.length === 1) return po;
  let pe = 0;
  for (const c of cats) {
    const pi =
      (pairs.filter(([a]) => String(a) === c).length +
        pairs.filter(([, b]) => String(b) === c).length) /
      (2 * pairs.length);
    pe += (pi * (1 - pi)) / (cats.length - 1);
  }
  if (1 - pe === 0) return Number.NaN;
  return (po - pe) / (1 - pe);
};

/** PABAK (Brennan-Prediger with the observed class count): fixed uniform chance = 1/Q. */
export const pabak = (pairs) => {
  if (!pairs.length) return Number.NaN;
  const q = Math.max(2, new Set(pairs.flat().map(String)).size);
  const pe = 1 / q;
  return (observedAgreement(pairs) - pe) / (1 - pe);
};

// ── exact binomial machinery ─────────────────────────────────────────────────────────────────────
const logChoose = (n, k) => {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
};
const binomPmf = (n, k, p) =>
  Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));

/** Exact McNemar on discordant counts (b, c), two-sided mid-p (recommended over the conservative
 * exact test at tiny b+c — and b+c ≤ 7 is structural here, so this is DESCRIPTIVE, never a gate
 * on its own). Returns { b, c, n: b+c, midP }. */
export const mcnemarMidP = (b, c) => {
  const n = b + c;
  if (n === 0) return { b, c, n, midP: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomPmf(n, i, 0.5);
  const midP = Math.min(1, 2 * (tail - 0.5 * binomPmf(n, k, 0.5)));
  return { b, c, n, midP };
};

// ── regularized incomplete beta (continued fraction, Numerical Recipes) ──────────────────────────
const logGamma = (x) => {
  // Lanczos approximation
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
};

const betacf = (a, b, x) => {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
};

/** Regularized incomplete beta I_x(a, b). */
export const betainc = (x, a, b) => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
};

/** Clopper-Pearson two-sided (1-alpha) interval for k successes of n, via bisection on the
 * Beta CDF (Beta(k, n-k+1) / Beta(k+1, n-k) quantiles). */
export const clopperPearson = (k, n, alpha = 0.05) => {
  const quantile = (a, b, p) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (betainc(mid, a, b) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const lower = k === 0 ? 0 : quantile(k, n - k + 1, alpha / 2);
  const upper = k === n ? 1 : quantile(k + 1, n - k, 1 - alpha / 2);
  return { lower, upper };
};

// ── Beta inverse-CDF-on-grid sampler (bit-reproducible: exactly ONE uniform draw per sample) ─────
/** Build a Beta(a,b) inverse-CDF lookup; sample(u) maps one uniform to one Beta draw. */
export const betaSamplerGrid = (a, b, gridN = 4096) => {
  const cdf = new Float64Array(gridN + 1);
  for (let i = 0; i <= gridN; i++) cdf[i] = betainc(i / gridN, a, b);
  return (u) => {
    // binary search for the first grid point with CDF ≥ u, then linear interpolation
    let lo = 0;
    let hi = gridN;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    const c0 = cdf[lo - 1];
    const c1 = cdf[lo];
    const frac = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
    return (lo - 1 + frac) / gridN;
  };
};

// ── normal quantile (Acklam approximation) — needed by BCa ───────────────────────────────────────
export const normQuantile = (p) => {
  if (p <= 0 || p >= 1) return Number.NaN;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - plow) return -normQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
};
export const normCdf = (x) => {
  // Abramowitz-Stegun via erf approximation — adequate for BCa's z0
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const dNorm = Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - dNorm * poly;
  return x >= 0 ? p : 1 - p;
};

// ── Wilcoxon signed-rank (normal approximation with tie correction) — the pre-registered
// cross-check on paired per-case deltas; descriptive at n=19, never a gate ──────────────────────
export const wilcoxonSignedRank = (diffs) => {
  const nz = diffs.filter((d) => d !== 0);
  const n = nz.length;
  if (n === 0) return { n, w: 0, z: 0, p: 1 };
  const ranked = nz
    .map((d) => ({ d, abs: Math.abs(d) }))
    .sort((a, b) => a.abs - b.abs)
    .map((x, i) => ({ ...x, rank: i + 1 }));
  // average ranks over ties
  for (let i = 0; i < ranked.length; ) {
    let j = i;
    while (j < ranked.length && ranked[j].abs === ranked[i].abs) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranked[k].rank = avg;
    i = j;
  }
  const wPlus = ranked.filter((x) => x.d > 0).reduce((s, x) => s + x.rank, 0);
  const mu = (n * (n + 1)) / 4;
  // tie correction on the variance
  const tieGroups = new Map();
  for (const x of ranked) tieGroups.set(x.abs, (tieGroups.get(x.abs) ?? 0) + 1);
  const tieTerm = [...tieGroups.values()].reduce((s, t) => s + t ** 3 - t, 0);
  const varW = (n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48;
  if (varW <= 0) return { n, w: wPlus, z: 0, p: 1 };
  const z = (wPlus - mu) / Math.sqrt(varW);
  const p = Math.min(1, 2 * (1 - normCdf(Math.abs(z))));
  return { n, w: wPlus, z, p };
};

// ── bootstrap CIs ────────────────────────────────────────────────────────────────────────────────
/** Percentile CI from a replicate array. */
export const percentileCI = (reps, alpha = 0.05) => {
  const sorted = [...reps].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  return { lower: at(alpha / 2), upper: at(1 - alpha / 2) };
};

/** BCa CI: replicates + the observed statistic + jackknife values over the cases. */
export const bcaCI = (reps, observed, jackknife, alpha = 0.05) => {
  const n = reps.length;
  if (!n || jackknife.length < 2) return percentileCI(reps, alpha);
  const below = reps.filter((r) => r < observed).length / n;
  if (below === 0 || below === 1) return percentileCI(reps, alpha); // degenerate — fall back
  const z0 = normQuantile(below);
  const jm = mean(jackknife);
  const num = jackknife.reduce((s, j) => s + (jm - j) ** 3, 0);
  const den = jackknife.reduce((s, j) => s + (jm - j) ** 2, 0) ** 1.5;
  const a = den === 0 ? 0 : num / (6 * den);
  const zlo = normQuantile(alpha / 2);
  const zhi = normQuantile(1 - alpha / 2);
  const adj = (z) => normCdf(z0 + (z0 + z) / (1 - a * (z0 + z)));
  const sorted = [...reps].sort((x, y) => x - y);
  const at = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * n)))];
  return { lower: at(adj(zlo)), upper: at(adj(zhi)) };
};
