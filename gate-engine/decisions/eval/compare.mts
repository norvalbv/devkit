/**
 * decisions-eval regression gate: small-n statistics + the baseline comparison.
 *
 * Split out of bench.mts so the run/report machinery and the gate that decides pass/fail are
 * separately readable and separately testable — `compare` is pure (summary + baseline in, verdict +
 * lines out) and needs no fixtures, no git, and no claude.
 *
 * See docs/decisions/bench-gates-on-flips-not-deltas.md for why this gates on a per-row flip table
 * rather than aggregate deltas.
 */

import { wilsonScoreInterval } from '../../eval/statistics.mts';
import { DECISIONS_ACCEPTANCE, selectAlignmentContradiction } from './acceptance.mts';

// ─── Small-n statistics (pure, dep-free) ────────────────────────────────────────
// At this corpus size the bench is a LARGE-EFFECT TRIPWIRE, not a 5pp regression detector:
// Wilson 95% on 14/16 is ~[64%, 96%], and detecting a 5pp drop with power would need ~630 rows.
// So every metric ships its interval, and the --fail gate runs on the per-row FLIP TABLE with a
// paired mid-p McNemar test — never on raw aggregate deltas (two runs with identical accuracy can
// disagree on a third of rows; the aggregate hides it). Wilson over bootstrap/Wald: closed-form and
// correctly covered below n=100 (Brown/Cai/DasGupta 2001; Miller arXiv:2411.00640).

/** Wilson 95% score interval for k successes of n. */
export function wilson(k, n, z = 1.96) {
  const { lower, upper } = wilsonScoreInterval(k, n, z);
  return { lo: lower, hi: upper };
}

/**
 * Two-sided mid-p McNemar on a paired flip table: b = baseline-right→now-wrong, c = the reverse.
 * Exact binomial on the discordant pairs (X ~ Bin(b+c, ½)); mid-p halves the observed-point mass
 * (Fagerland 2013 — better calibrated than the exact test at tiny counts). p < 0.05 needs ~5+ net
 * one-directional flips at these corpus sizes — fewer is indistinguishable from judge noise.
 */
export function mcnemarMidP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // Bin(n, ½) pmf built iteratively — n is a flip count, always tiny.
  let pmf = 0.5 ** n; // P(X = 0)
  let cdf = 0;
  let atK = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) pmf = (pmf * (n - i + 1)) / i;
    cdf += pmf;
    if (i === k) atK = pmf;
  }
  return Math.min(1, 2 * cdf - atK);
}

// ─── Baseline + regression ────────────────────────────────────────────────────────

/** Informational metric deltas printed per sub-bench (headline first). NEVER gate on these:
 * aggregate deltas hide compensating per-row flips; the gate runs on the flip table below. */
const COMPARED = {
  detect: [
    ['DECISION recall', (s) => s.decision.recall],
    ['accuracy (scored rows)', (s) => s.accuracyScored],
  ],
  alignment: [
    ['CONTRADICT precision', (s) => selectAlignmentContradiction(s).precision],
    ['macro-F1', (s) => (s.cascade ? s.final : s.firstPass).macroF1],
  ],
  depth: [['accuracy', (s) => s.accuracy]],
};

const CONFIG_KEYS = {
  detect: ['model'],
  alignment: ['model', 'escalateModel', 'cascade'],
  depth: ['model'],
};

// Hard floors on the safety metrics: catastrophic breakage (truncated prompt, broken parser)
// fails immediately regardless of flip statistics. Point estimates, not Wilson bounds — the lower
// bound is uselessly wide at this n.
const FLOORS = {
  detect: ['DECISION recall', (s) => s.decision.recall, DECISIONS_ACCEPTANCE.floors.decisionRecall],
  alignment: [
    'CONTRADICT precision',
    (s) => selectAlignmentContradiction(s).precision,
    DECISIONS_ACCEPTANCE.floors.contradictionPrecision,
  ],
  depth: ['accuracy', (s) => s.accuracy / 100, DECISIONS_ACCEPTANCE.floors.depthAccuracy],
};

/**
 * Compare one sub-bench vs its baseline section — statistically honest at small n.
 *
 * Order of evaluation: (1) the hard FLOOR on the safety metric — absolute, so it fails even with no
 * baseline or an incomparable one; (2) comparability preconditions — config, gate-code hash, corpus
 * hash and alignment outages skip the COMPARISON rather than lie; (3) the paired FLIP TABLE: b =
 * rows the baseline got right and this run got wrong (counted only when the flip is STABLE —
 * unanimous across K trials, or retry-confirmed for alignment), c = the reverse; fail iff
 * mcnemarMidP(b, c) < 0.05 (~5+ net one-directional flips at this n); (4) warn tier: any b > 0
 * prints the regressed row ids + the mid-p + an MDE line stating what this bench cannot distinguish
 * from noise. Humans act on warns; CI acts on fails. Expected-NULL rows stay excluded.
 */
export function compare(name, summary, base) {
  // The floor is absolute — a property of THIS run, not a comparison — so it precedes every early
  // return. Ordered after them it was unreachable exactly when it mattered most (no baseline yet).
  const [floorLabel, floorPick, floor] = FLOORS[name];
  const breached = floorPick(summary) < floor;
  const floorLine = `  ${name}: FLOOR BREACH — ${floorLabel} ${floorPick(summary).toFixed(2)} < ${floor} (catastrophic; fails regardless of flip statistics)`;
  const bail = (why) => ({
    regressed: breached,
    lines: [...(breached ? [floorLine] : []), `  ${name}: ${why}`],
  });
  if (!base) return bail('no baseline section — flip comparison skipped');
  const skip = (why) => bail(`${why} — regenerate with --baseline; comparison skipped`);
  const mismatch = CONFIG_KEYS[name].filter((k) => summary[k] !== base[k]);
  if (mismatch.length) return skip(`baseline config differs (${mismatch.join(', ')})`);
  if (base.gateHash && summary.gateHash && base.gateHash !== summary.gateHash)
    return skip('gate code changed since the baseline');
  if (base.corpusHash && summary.corpusHash && base.corpusHash !== summary.corpusHash)
    return skip('corpus changed since the baseline');
  if (name === 'alignment' && summary.outages > 0)
    return skip(`${summary.outages} outage(s) this run — score is suspect`);

  const arrow = (n) => (n > 0 ? '↑' : n < 0 ? '↓' : '=');
  const signed = (n) => `${n > 0 ? '+' : ''}${n.toFixed(3)}`;
  const lines = [];
  let regressed = breached;

  for (const [label, pick] of COMPARED[name]) {
    const d = pick(summary) - pick(base);
    lines.push(`  ${name}: ${label} ${arrow(d)} ${signed(d)}  (informational)`);
  }

  if (breached) lines.push(floorLine);

  if (summary.rows && base.rows) {
    const bIds = [];
    const cIds = [];
    const unstableIds = [];
    for (const [id, cur] of Object.entries(summary.rows)) {
      const prev = base.rows[id];
      if (!prev || cur.expected === 'NULL') continue;
      if (prev.ok && !cur.ok) (cur.stable ? bIds : unstableIds).push(id);
      else if (!prev.ok && cur.ok) cIds.push(id);
    }
    const midP = mcnemarMidP(bIds.length, cIds.length);
    if (bIds.length + cIds.length > 0) {
      const n = Object.keys(summary.rows).length;
      const mde = 2.802 * Math.sqrt((bIds.length + cIds.length) / n / n);
      lines.push(
        `  ${name}: flips vs baseline — regressed [${bIds.join(', ') || '—'}] improved [${cIds.join(', ') || '—'}] (mid-p ${midP.toFixed(3)})`,
      );
      lines.push(
        `  ${name}: this bench cannot distinguish metric deltas below ~${(mde * 100).toFixed(0)}pp from judge noise at n=${n}`,
      );
    }
    if (unstableIds.length)
      lines.push(
        `  ${name}: unstable rows (non-unanimous/unconfirmed — instability, not regression): [${unstableIds.join(', ')}]`,
      );
    if (midP < 0.05 && bIds.length > cIds.length) {
      regressed = true;
      lines.push(
        `  ${name}: REGRESSION — one-directional flips are significant (mid-p ${midP.toFixed(3)} < 0.05)`,
      );
    }
  }

  return { regressed, lines };
}
