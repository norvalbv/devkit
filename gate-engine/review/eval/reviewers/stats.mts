// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * Pure flip-table statistics for compareReviewer (split out of bench.mts to keep it within its
 * size ratchet). Everything here takes plain `{id, wasOk, isOk, expected, caseId}` pairs — no fs,
 * no baseline-file shape knowledge — so it is trivially unit-testable.
 */

import { mcnemarMidP, wilson } from '../../../decisions/eval/bench.mts';
import { groupByPair } from './corpus/twins.mts';

export const fmtCi = (k, n) => {
  const { lo, hi } = wilson(k, n);
  return `${k}/${n}${n ? ` = ${(k / n).toFixed(2)}` : ''} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
};

/** Naive per-row McNemar discordant counts: b = was-ok→now-wrong, c = the reverse. */
export function flipCounts(pairs) {
  let b = 0;
  let c = 0;
  const flips = [];
  for (const { id, wasOk, isOk } of pairs) {
    if (wasOk && !isOk) {
      b += 1;
      flips.push(`${id} ↓`);
    } else if (!wasOk && isOk) {
      c += 1;
      flips.push(`${id} ↑`);
    }
  }
  return { b, c, flips };
}

/**
 * Cluster shared rows by caseId (fallback: the row's own id — an unclustered row is its own
 * one-row case). Per case: net direction = sign(rows flipped up − rows flipped down); a case with
 * a nonzero net direction counts ONCE toward b or c, so a caseId whose rows all flip together
 * (a minimal-pair set, a mined finding split across two lenses) is one discordant unit instead of
 * inflating the pooled McNemar count.
 */
export function clusteredFlipCounts(pairs) {
  const byCase = new Map();
  for (const { wasOk, isOk, caseId, id } of pairs) {
    const key = caseId ?? id;
    if (!byCase.has(key)) byCase.set(key, { up: 0, down: 0 });
    const entry = byCase.get(key);
    if (wasOk && !isOk) entry.down += 1;
    else if (!wasOk && isOk) entry.up += 1;
  }
  let b = 0;
  let c = 0;
  for (const { up, down } of byCase.values()) {
    const net = up - down;
    if (net > 0) c += 1;
    else if (net < 0) b += 1;
  }
  return { b, c, p: mcnemarMidP(b, c) };
}

/**
 * Full compareReviewer report: pooled + gold-only + decoy-only naive flip tables, plus the
 * clustered-by-case count, from a pre-built list of paired rows. `pairs` must already exclude
 * unstable and rowHash-changed rows — this function only does the arithmetic + formatting.
 */
export function buildCompareReport({
  pairs,
  crossGate,
  shared,
  changed,
  unstable = 0,
  added,
  removed,
  hasRowHash,
}) {
  const naive = flipCounts(pairs);
  const gold = flipCounts(pairs.filter((p) => p.expected === 'FAIL'));
  const decoy = flipCounts(pairs.filter((p) => p.expected === 'PASS'));
  const clustered = clusteredFlipCounts(pairs);
  const p = mcnemarMidP(naive.b, naive.c);
  const regressed = naive.b > naive.c && p < 0.05;
  const improved = naive.c > naive.b && p < 0.05;
  const warn =
    !hasRowHash && shared > 0
      ? ' — WARNING: baseline predates rowHash, row-level drift detection unavailable'
      : '';
  const lines = [
    `${crossGate ? 'A/B (directional, not a regression gate) ' : ''}rows: shared ${shared} (${changed} changed, excluded), added ${added}, removed ${removed}, unstable ${unstable} (excluded)${warn}`,
    `  flips ↓${naive.b} ↑${naive.c} (mid-p ${p.toFixed(3)})${naive.flips.length ? ` — ${naive.flips.join(', ')}` : ''}`,
    `  gold  ↓${gold.b} ↑${gold.c} (mid-p ${mcnemarMidP(gold.b, gold.c).toFixed(3)})`,
    `  decoy ↓${decoy.b} ↑${decoy.c} (mid-p ${mcnemarMidP(decoy.b, decoy.c).toFixed(3)})`,
    `  clustered by case ↓${clustered.b} ↑${clustered.c} (mid-p ${clustered.p.toFixed(3)})`,
  ];
  return { regressed, improved, detail: lines.join('\n') };
}

/** Console report for one summarize() scope (a reviewer, or pooled). */
export function printSummary(name, s, { cascade }) {
  console.log(`\n${name} (${s.rows} rows: ${s.gold} gold / ${s.decoys} decoys)`);
  console.log(`  first-pass FAIL-recall   ${fmtCi(s.firstFailRecall.k, s.firstFailRecall.n)}`);
  console.log(`  first-pass clean-pass    ${fmtCi(s.firstCleanPass.k, s.firstCleanPass.n)}`);
  if (cascade) {
    console.log(`  end-to-end block recall  ${fmtCi(s.blockRecall.k, s.blockRecall.n)}`);
    console.log(`  end-to-end clean-pass    ${fmtCi(s.cleanPass.k, s.cleanPass.n)}`);
    console.log(`  overturn rate            ${fmtCi(s.overturnRate.k, s.overturnRate.n)}`);
    console.log(`  rescue rate              ${fmtCi(s.rescueRate.k, s.rescueRate.n)}`);
  }
  const reasons =
    Object.entries(s.reasons)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ') || '—';
  console.log(`  right-reason split       ${reasons}`);
  console.log(
    `  live escalations         ${s.escalations}${s.escalations ? ` (mean ${s.escalateMeanSecs}s)` : ''}`,
  );
  const inc = Object.entries(s.inconclusive)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  if (inc) console.log(`  inconclusive             ${inc}`);
}

// Comment-leakage heuristics (non-fatal — see validateRow docstring in bench.mts): a mined/adapted
// row can accidentally carry the tell in a `//` or `/* */` comment left in the fixture text, which
// would let the row pass for a reason no real judge output could reproduce. Best-effort text scan,
// not a parser — a `//` inside a string literal is an acceptable false comment given the two
// callers only ever WARN, never fail, on what it finds.
const COMMENT_STAR_PREFIX_RE = /^\s*\*/;

export function extractCommentLines(files) {
  const lines = [];
  for (const content of Object.values(files)) {
    if (!content) continue;
    for (const m of content.matchAll(/\/\/(.*)$/gm)) lines.push(m[1].trim());
    for (const m of content.matchAll(/\/\*([\s\S]*?)\*\//g))
      for (const l of m[1].split('\n')) {
        const clean = l.replace(COMMENT_STAR_PREFIX_RE, '').trim();
        if (clean) lines.push(clean);
      }
  }
  return lines.filter(Boolean);
}

export const wordsOf = (text) =>
  new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 3));

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// Row-scoring text classifiers (pure, no fs) — subcause buckets an inconclusive cascade reason;
// VERDICT_INJECTION_RE flags staged fixture content that could spoof a judge verdict.
const OUTAGE_RE = /outage/i;
const NO_VERDICT_RE = /no VERDICT/i;
const CHECKLIST_RE = /checklist/i;
export const VERDICT_INJECTION_RE = /VERDICT:/i;

export function subcause(reason) {
  if (OUTAGE_RE.test(reason)) return 'outage';
  if (NO_VERDICT_RE.test(reason)) return 'no-verdict';
  if (CHECKLIST_RE.test(reason)) return 'checklist-void';
  return 'other';
}

/** True when a baseline row and a current row's content hash can be paired for a same-row
 * comparison (stability rerun, salvage). Old-format baselines / rows without a rowHash can't
 * express drift, so they're treated as unchanged (matches compareReviewer's fallback for
 * hash-less baselines) — the only "changed" verdict is an explicit hash mismatch on both sides. */
export function rowUnchanged(baseRow, current) {
  if (!baseRow) return false;
  // Prefer the behavior hash when both sides carry one: documentation-only edits pair fine.
  if (baseRow.behaviorHash !== undefined && current?.behaviorHash !== undefined)
    return baseRow.behaviorHash === current.behaviorHash;
  const currentRowHash =
    typeof current === 'object' && current !== null ? current.rowHash : current;
  if (baseRow.rowHash === undefined || currentRowHash === undefined) return true;
  return baseRow.rowHash === currentRowHash;
}

/** Strict-precondition variant for compareReviewer: caller has verified row.rowHash exists. */
export function rowChanged(baseRow, row) {
  if (baseRow.behaviorHash !== undefined && row.behaviorHash !== undefined)
    return row.behaviorHash !== baseRow.behaviorHash;
  return row.rowHash !== baseRow.rowHash;
}

// ─── Summary (moved from bench.mts) ──────────────────────────────────────────────────────────────────────

const count = (rows, pred) => rows.filter(pred).length;

/** Aggregate scored rows → the metric block for one scope (a reviewer, or pooled). */
export function summarize(results, { cascade } = {}) {
  const gold = results.filter((r) => r.expected === 'FAIL');
  const decoys = results.filter((r) => r.expected === 'PASS');
  const blocked = gold.filter((r) => r.okFinal);
  const reasons = {};
  for (const r of blocked)
    if (r.reasonClass) reasons[r.reasonClass] = (reasons[r.reasonClass] ?? 0) + 1;
  const inconclusive = {};
  for (const r of results)
    if (r.subcause) inconclusive[r.subcause] = (inconclusive[r.subcause] ?? 0) + 1;
  const liveEscalations = results.filter((r) => r.escalateLive);
  // overturns: escalation took back a correct first FAIL; rescues: escalation fixed a first-pass
  // false-block. Both are cascade-only, like blockRecall/cleanPass.
  const goldFirstFail = gold.filter((r) => r.firstVerdict === 'FAIL');
  const decoyFirstFail = decoys.filter((r) => r.firstVerdict === 'FAIL');
  // Cascade-only metrics mean nothing when no cascade ran; absent, not zeroed.
  const cascadeMetrics = cascade
    ? {
        blockRecall: { k: blocked.length, n: gold.length },
        cleanPass: { k: count(decoys, (r) => r.okFinal), n: decoys.length },
        overturnRate: {
          k: count(goldFirstFail, (r) => !r.okFinal && r.escalateLive),
          n: goldFirstFail.length,
        },
        rescueRate: { k: count(decoyFirstFail, (r) => r.okFinal), n: decoyFirstFail.length },
      }
    : {};
  return {
    rows: results.length,
    gold: gold.length,
    decoys: decoys.length,
    firstFailRecall: { k: count(gold, (r) => r.firstVerdict === 'FAIL'), n: gold.length },
    firstCleanPass: { k: count(decoys, (r) => r.firstVerdict === 'PASS'), n: decoys.length },
    ...cascadeMetrics,
    // sc-2498: a caseId pair (one gold, one decoy) is consistent only when BOTH are correct;
    // always ≤ the marginal, and the gap is what the marginal hides.
    pairConsistency: pairConsistency(results, { cascade }),
    escalations: liveEscalations.length,
    escalateMeanSecs: liveEscalations.length
      ? Math.round(
          liveEscalations.reduce((s, r) => s + r.ms.escalate, 0) / liveEscalations.length / 1000,
        )
      : 0,
    reasons,
    inconclusive,
  };
}

/** Pair-level contrast consistency over the same pair relation holdout uses (groupByPair): a gold+decoy
 * group is consistent when both are ok (okFinal under a cascade). Singletons/malformed reported. */
export function pairConsistency(results, { cascade } = {}) {
  const ok = (r) => (cascade ? r.okFinal : r.okFirst);
  // Grouping is keyed on row id (a variantOf target has no link of its own), so only rows that
  // carry one are grouped; an id-less record is a singleton by definition.
  const withId = results.filter((r) => !!r.id);
  let k = 0;
  let n = 0;
  let singletons = results.length - withId.length;
  let malformed = 0;
  for (const g of groupByPair(withId).values()) {
    if (g.length === 1) {
      singletons += 1;
      continue;
    }
    const gold = g.filter((r) => r.expected === 'FAIL');
    const decoy = g.filter((r) => r.expected === 'PASS');
    if (g.length !== 2 || gold.length !== 1 || decoy.length !== 1) {
      malformed += 1;
      continue;
    }
    n += 1;
    if (ok(gold[0]) && ok(decoy[0])) k += 1;
  }
  return { k, n, singletons, malformedGroups: malformed };
}

/** Budget for the run banner, priced per EFFECTIVE model. A model with no table entry is returned
 * under `unpriced` (its rows excluded) rather than silently costed as the default. */
export function estimateMinutes(
  plan,
  { estEscalations = 0, escalateSecs = 0, concurrency = 1, table },
) {
  const unpriced = new Set();
  let secs = 0;
  let unpricedRows = 0;
  for (const { model, rows } of plan) {
    const per = table[model];
    if (per === undefined) {
      unpriced.add(model);
      unpricedRows += rows;
      continue;
    }
    secs += rows * per;
  }
  secs += estEscalations * escalateSecs;
  return {
    minutes: Math.round(secs / 60 / Math.max(1, concurrency)),
    unpriced: [...unpriced].sort(),
    unpricedRows,
  };
}

/** Measured mean first-pass seconds per effective model over rows that actually ran (ms.first > 0):
 * the number a probe yields for a model the budget table does not price. */
export function firstPassMeanSecs(perModel) {
  const acc = new Map();
  for (const { model, results } of perModel)
    for (const r of results) {
      const ms = r?.ms?.first ?? 0;
      if (ms <= 0) continue;
      const a = acc.get(model) ?? { sum: 0, n: 0 };
      a.sum += ms;
      a.n += 1;
      acc.set(model, a);
    }
  return new Map([...acc].map(([model, a]) => [model, Math.round(a.sum / a.n / 1000)]));
}

/** One banner line per effective model with its measured first-pass mean, flagged when the model
 * is missing from the budget table (the number to add to it). */
export function firstPassMeanLines(perModel, table) {
  return [...firstPassMeanSecs(perModel)].map(
    ([model, secs]) =>
      `measured first-pass mean ${model}: ${secs}s${table[model] === undefined ? ' (unpriced in EST_FIRST_SECS — add it)' : ''}`,
  );
}

/** Only NON-pinned reviewers escalate (and only under a cascade): a pinned reviewer runs single-pass. */
export function estimateEscalations(plan, cascade) {
  if (!cascade) return 0;
  return plan.reduce(
    (s, p) =>
      s +
      (p.reviewer.model
        ? 0
        : p.rows.filter((r) => r.expected === 'FAIL').length +
          Math.round(p.rows.filter((r) => r.expected === 'PASS').length * 0.15)),
    0,
  );
}

/** The run banner: rows, model, cascade, and a budget priced per EFFECTIVE model — a pin with no
 * table entry is named as unpriced rather than silently costed as the default (sc-2494 probe-first). */
export function runBannerLines(
  plan,
  { model, cascade, concurrency, dev, resuming, table, escalateSecs },
) {
  const effModel = (r) => r.model ?? model;
  const totalRows = plan.reduce((s, p) => s + p.rows.length, 0);
  const goldRows = plan.reduce((s, p) => s + p.rows.filter((r) => r.expected === 'FAIL').length, 0);
  const budget = estimateMinutes(
    plan.map((p) => ({ model: effModel(p.reviewer), rows: p.rows.length })),
    { estEscalations: estimateEscalations(plan, cascade), escalateSecs, concurrency, table },
  );
  const allPinned = plan.every((p) => p.reviewer.model);
  const modelLabel = allPinned ? [...new Set(plan.map((p) => p.reviewer.model))].join('/') : model;
  const cascadeLabel = allPinned ? 'single-pass' : cascade ? 'on' : 'off';
  const lines = [
    `reviewer-eval: ${totalRows} rows (${goldRows} gold) · model ${modelLabel} · cascade ${cascadeLabel} · ` +
      `concurrency ${concurrency} · est ≈ ${budget.minutes} min wall-clock${dev ? ' · --dev (holdouts excluded)' : ''}` +
      `${resuming ? ` · resuming (${resuming} checkpointed row(s) on disk)` : ''}`,
  ];
  if (budget.unpriced.length)
    lines.push(
      `reviewer-eval: no cost entry for ${budget.unpriced.join(', ')} — estimate excludes ${budget.unpricedRows} row(s); the run prints the measured first-pass mean per model at the end (probe before bench).`,
    );
  return lines;
}
