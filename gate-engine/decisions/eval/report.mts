/**
 * Presentation for the judge bench: confusion matrices, per-class tables, the coverage matrix and
 * the run ledger. Split out of bench.mts so the file that SPENDS money (judge orchestration) stays
 * separable from the file that formats what it bought — and so neither grows past the size ratchet.
 *
 * Nothing here calls a judge or reaches the network; `printCoverage` is a zero-cost corpus report.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchScope } from '../check-alignment.mts';
import { detectSmells } from '../detect.mts';
import { loadCases, SUBS } from './cases.mts';

const here = path.dirname(fileURLToPath(import.meta.url));

export function round3(pc) {
  return {
    ...pc,
    precision: Number(pc.precision.toFixed(3)),
    recall: Number(pc.recall.toFixed(3)),
    f1: Number(pc.f1.toFixed(3)),
  };
}

/** Per-row verdict map for the baseline — what the flip-table gate diffs against. */
export function rowMap(results) {
  const map = {};
  for (const r of results)
    map[r.id] = { got: r.final ?? r.got, ok: r.ok, stable: r.stable ?? true, expected: r.expected };
  return map;
}

export function byCategory(results) {
  const cats = {};
  for (const r of results) {
    if (!r.category) continue;
    cats[r.category] ??= { correct: 0, total: 0 };
    cats[r.category].total += 1;
    if (r.ok) cats[r.category].correct += 1;
  }
  return cats;
}

export function printConfusion(confusion) {
  const gots = [...new Set(Object.values(confusion).flatMap((g) => Object.keys(g)))].sort();
  const expecteds = Object.keys(confusion).sort();
  console.log(`  ${'want \\ got'.padEnd(14)}${gots.map((g) => g.padStart(12)).join('')}`);
  for (const e of expecteds) {
    const cells = gots.map((g) => String(confusion[e][g] ?? 0).padStart(12));
    console.log(`  ${e.padEnd(14)}${cells.join('')}`);
  }
}

export function printPerClass(perClass) {
  for (const [c, s] of Object.entries(perClass)) {
    console.log(
      `  ${c.padEnd(14)} precision ${s.precision.toFixed(2)}  recall ${s.recall.toFixed(2)}  ` +
        `F1 ${s.f1.toFixed(2)}  (tp=${s.tp} fp=${s.fp} fn=${s.fn})`,
    );
  }
}

/** Wall-clock budget for the run about to start. `resumable` rows are already checkpointed, so the
 * estimate reports what is still to PAY for — a resumed run that still quoted the full 149 minutes
 * would be reporting a cost nobody is about to incur. */
export function printEstimate(plan, runs, resumable = {}) {
  const parts = [];
  let seconds = 0;
  const left = (name) => Math.max(0, (plan[name]?.length ?? 0) - (resumable[name] ?? 0));
  if (plan.detect) {
    // Only rows that actually reach the judge cost anything; free-skip rows raise no smell.
    const judged = plan.detect.filter(
      (c) => detectSmells(c.entries, c.boundaries ?? []).length,
    ).length;
    const todo = Math.min(judged, left('detect'));
    seconds += todo * 30 * runs;
    parts.push(`detect ${todo} judged × ~30s${runs > 1 ? ` × K=${runs}` : ''}`);
  }
  if (plan.alignment) {
    const judged = plan.alignment.filter((c) =>
      Object.keys(c.repo.staged).some((f) => matchScope([f], c.target.scope)),
    ).length;
    const todo = Math.min(judged, left('alignment'));
    seconds += todo * 90;
    parts.push(`alignment ${todo} judged × ~90s (+120–240s per escalation; K=1)`);
  }
  if (plan.depth) {
    const todo = left('depth');
    seconds += todo * 40 * runs;
    parts.push(`depth ${todo} judged × ~40s${runs > 1 ? ` × K=${runs}` : ''}`);
  }
  const resumed = Object.values(resumable).reduce((n, v) => n + v, 0);
  console.log(
    `decisions-eval: budget ≈ ${Math.round(seconds / 60)} min  (${parts.join(' · ')})` +
      `${resumed ? `  · ${resumed} row(s) resumed from checkpoint` : ''}`,
  );
}

/** Projected precision at realistic DECISION prevalence: the corpus is deliberately ~balanced for
 * measurement power, but real commit streams are mostly ROUTINE — precision is prevalence-dependent
 * (sensitivity/specificity are not), so report what the gate would look like in the wild. */
export function ppvLine(s) {
  const tpr = s.decision.recall;
  const negatives = s.routine.tp + s.decision.fp;
  const fpr = negatives ? s.decision.fp / negatives : 0;
  const ppv = (p) => {
    const v = (tpr * p) / (tpr * p + fpr * (1 - p));
    return Number.isFinite(v) ? v.toFixed(2) : '—';
  };
  return `  projected precision at real prevalence: p=5% → ${ppv(0.05)} · p=15% → ${ppv(0.15)}  (corpus is balanced by design)`;
}

/** Metamorphic variant groups: rows sharing variantOf must agree (invariance) — consistency is
 * its own metric, never folded into accuracy (a prompt that gains accuracy but loses consistency
 * is Goodharting the corpus). */
export function variantConsistency(rows, rowResults) {
  const groups = {};
  for (const r of rows) {
    if (!r.variantOf || r.variantKind === 'directional') continue;
    groups[r.variantOf] ??= new Set([r.variantOf]);
    groups[r.variantOf].add(r.id);
  }
  const ids = Object.keys(groups);
  if (!ids.length) return null;
  let consistent = 0;
  const broken = [];
  for (const g of ids) {
    const verdicts = new Set(
      [...groups[g]].map((id) => rowResults[id]?.got).filter((v) => v !== undefined),
    );
    if (verdicts.size <= 1) consistent += 1;
    else broken.push(g);
  }
  return { consistent, total: ids.length, broken };
}

/**
 * `bench.mjs coverage` — the corpus-coverage instrument (zero claude calls): per sub-bench, a
 * category × label × difficulty cell-count table plus provenance/holdout/variant tallies. Empty
 * or thin cells are the corpus's documented debt; grow rows toward them, not wherever is easy.
 */
export function printCoverage() {
  for (const name of SUBS) {
    const rows = loadCases(name);
    console.log(`\n── ${name} (${rows.length} rows) ──`);
    const cells = {};
    const tag = { provenance: {}, holdout: 0, variants: 0 };
    for (const r of rows) {
      const key = `${(r.category ?? 'uncategorised').padEnd(24)} ${String(r.expected).padEnd(11)} ${r.difficulty ?? 'unset'}`;
      cells[key] = (cells[key] ?? 0) + 1;
      const p = r.provenance ?? 'authored';
      tag.provenance[p] = (tag.provenance[p] ?? 0) + 1;
      if (r.holdout) tag.holdout += 1;
      if (r.variantOf) tag.variants += 1;
    }
    console.log(`  ${'category'.padEnd(24)} ${'expected'.padEnd(11)} difficulty  rows`);
    for (const key of Object.keys(cells).sort()) console.log(`  ${key}  ${cells[key]}`);
    console.log(
      `  provenance: ${Object.entries(tag.provenance)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')} · holdout=${tag.holdout} · variant rows=${tag.variants}`,
    );
    const unset = rows.filter((r) => !r.difficulty).length;
    if (unset) console.log(`  COVERAGE DEBT: ${unset} row(s) missing a difficulty tag`);
  }
}

export function appendLedger(entry) {
  try {
    appendFileSync(path.join(here, 'runs.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is telemetry; never let it break a run.
  }
}
