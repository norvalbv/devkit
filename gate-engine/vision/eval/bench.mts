#!/usr/bin/env node

/**
 * vision-eval: accuracy benchmark for the product-vision judge (../check-vision.mts). A HARD gate
 * ships only behind a passing bench (review-gate-in-chain: no advisory tier — a judge is benched
 * before it blocks, never trusted on vibes). A prompt edit is unverifiable without this.
 *
 * It composes the judge call FROM THE GATE (visionJudgeArgs + buildJudgeInput +
 * parseVisionVerdict), so the bench exercises the exact argv/stdin/parse path the gate runs —
 * prompt and logic never drift (the sentry-eval rule).
 *
 * METHODOLOGY (per the 2026-07-13 feature-critique + bench-gates-on-flips-not-deltas):
 * - MULTI-RUN MAJORITY: every row is judged BENCH_RUNS times (default 3); the row's verdict is
 *   the majority; no majority → UNSTABLE (counts wrong). Per-row flip rate is reported — a
 *   single-sample bench turns judge noise into false signal (arXiv:2606.13685, 2408.04667).
 * - HONEST STATISTICS: OUT precision/recall print with Wilson 95% intervals and an MDE line;
 *   "floors met" with the floor inside the CI is flagged, never silently trusted
 *   (arXiv:2503.01747).
 * - SEALED HOLDOUT: rows carry split:"dev"|"holdout". Prompt iteration uses dev only
 *   (BENCH_SPLIT=dev); --fail evaluates the floors on the HOLDOUT split — dev==test is textbook
 *   overfitting (arXiv:2511.18619).
 * - OUT-BINARY REGRESSION, NEVER AGGREGATE DELTAS: --fail compares per-row OUT-binary stable
 *   verdicts against the baseline via a McNemar mid-p flip test (p<0.05, one-directional) —
 *   the aggregate-delta epsilon gate was explicitly REJECTED in bench-gates-on-flips-not-deltas;
 *   accuracy folds in the deliberately-fuzzy DRIFT↔FIT boundary and never gates.
 * - LEDGER: every run appends a summary line to runs.log so the dev-vs-holdout gap stays visible.
 *
 * SHIPPING FLOORS (evaluated on the holdout; --fail enforces):
 *   OUT precision ≥ 0.90 — a false OUT costs a blocked commit and trains reflexive bypass.
 *   OUT recall    ≥ 0.75 — the gate must actually catch the class it exists for.
 *
 * Each row in cases.jsonl: { id, split:"dev"|"holdout", paths, diff,
 * expected:"FIT"|"DRIFT"|"OUT", category, note, statement? }. The corpus is DE-CONFOUNDED:
 * counterfactual rows carry OUT semantics without the announcing path/comment cues, and FIT
 * own-infra rows sit under cue-bearing paths (arXiv:2004.02709 contrast sets, 2005.04118).
 *
 *   BENCH_MODEL=opus|sonnet|haiku   judge model (default opus — the gate's shipped model)
 *   BENCH_RUNS=N                    judge samples per row, majority vote (default 3)
 *   BENCH_CONCURRENCY=N             parallel judge calls (default 6)
 *   BENCH_SPLIT=dev|holdout|all     row subset (default all; --fail floors always key on holdout)
 *   BENCH_ONLY=id1,id2              run a subset (dev-side prompt-iteration loop)
 *
 *   node bench.mjs              # run, print confusion + per-split metrics + floors + CI
 *   node bench.mjs --baseline   # write current run as the new baseline (results.baseline.json)
 *   node bench.mjs --fail       # exit 1 if holdout floors missed OR OUT-binary flips regressed
 *
 * Exit 0 = ran (floors met under --fail) · 1 = floors/regression (with --fail) · 2 = could not run.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { buildJudgeInput, parseVisionVerdict, visionJudgeArgs } from '../check-vision.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesPath = path.join(here, 'cases.jsonl');
const baselinePath = path.join(here, 'results.baseline.json');
const ledgerPath = path.join(here, 'runs.log');

const MODEL = process.env.BENCH_MODEL ?? 'opus';
const RUNS = Math.max(1, Number(process.env.BENCH_RUNS ?? '3') || 3);
const CONCURRENCY = Math.max(1, Number(process.env.BENCH_CONCURRENCY ?? '6') || 6);
const SPLIT = process.env.BENCH_SPLIT ?? 'all';
const ONLY = new Set((process.env.BENCH_ONLY ?? '').split(',').filter(Boolean));
const args = new Set(process.argv.slice(2));
const writeBaseline = args.has('--baseline');
const failMode = args.has('--fail');

const FLOOR_OUT_PRECISION = 0.9;
const FLOOR_OUT_RECALL = 0.75;

// The corpus default: a tool-not-platform product (the guard.config.example.json statement).
const DEFAULT_STATEMENT =
  "A friendly AI development TOOL, not a platform: the product must never host the user's " +
  "shipped-product backend (their database, payments, auth, hosting/deploy) — that is the user's " +
  "own product's job. The product's OWN infra (its own database, its own auth for its own users, " +
  'its own billing for its own subscriptions, its own deploy pipeline) is always fine, and the ' +
  "tool ACTING on the user's own external accounts (running their migrations, issuing a refund " +
  'with their Stripe key, deploying to their own Vercel) as a development task is fine — hosting ' +
  'means WE operate it. OUT = a ' +
  "diff that makes us host, provision or operate the USER's product backend for their end " +
  'customers. DRIFT = a diff serving an audience off the developer-task spine (features for the ' +
  "user's end customers, or a third audience) or contradicting the friendly-dev-tool identity.";

interface Row {
  id: string;
  split: 'dev' | 'holdout';
  paths: string;
  diff: string;
  expected: 'FIT' | 'DRIFT' | 'OUT';
  category: string;
  note?: string;
  statement?: string;
}

function loadCasesOrExit(): Row[] {
  try {
    const rows = readFileSync(casesPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);
    if (rows.length) {
      return rows
        .filter((r) => SPLIT === 'all' || r.split === SPLIT)
        .filter((r) => ONLY.size === 0 || ONLY.has(r.id));
    }
    console.error('vision-eval: cases.jsonl is empty');
  } catch (e) {
    console.error(`vision-eval: cannot read cases — ${e}`);
  }
  return process.exit(2);
}

/** One judge sample for one row, via the gate's own argv/stdin/parse path. */
async function sampleOnce(c: Row, run: number): Promise<string> {
  const raw = await execJudgeAsync({
    label: `vision-eval:${c.id}#${run}`,
    args: visionJudgeArgs(c.statement ?? DEFAULT_STATEMENT, MODEL),
    input: buildJudgeInput(c.paths, c.diff),
    timeout: 120000,
  });
  if (raw === null) return 'NULL'; // outage samples count toward instability — never silent
  return parseVisionVerdict(raw) ?? 'NULL';
}

/** Majority verdict across RUNS samples; no strict majority → UNSTABLE (counts wrong). */
function majority(samples: string[]): { verdict: string; unanimous: boolean } {
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { verdict: n * 2 > samples.length ? top : 'UNSTABLE', unanimous: counts.size === 1 };
}

/** Minimal promise pool — CONCURRENCY tasks in flight, order-stable results. */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Wilson 95% interval for k successes of n. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + z ** 2 / n;
  const centre = (p + z ** 2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z ** 2 / (4 * n ** 2))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** McNemar mid-p (two-sided binomial on discordant pairs) — the flip test, never deltas. */
function mcNemarMidP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  const pmf = (i: number) => {
    let logC = 0;
    for (let j = 0; j < i; j++) logC += Math.log(n - j) - Math.log(j + 1);
    return Math.exp(logC + n * Math.log(0.5));
  };
  let p = 0;
  for (let i = 0; i < k; i++) p += pmf(i);
  p = 2 * (p + pmf(k) / 2);
  return Math.min(1, p);
}

interface SplitMetrics {
  n: number;
  correct: number;
  accuracy: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  precisionCi: [number, number];
  recallCi: [number, number];
  floorsMet: boolean;
  floorInsideCi: boolean;
}

function metricsFor(rows: { expected: string; verdict: string }[]): SplitMetrics {
  let correct = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of rows) {
    if (r.verdict === r.expected) correct += 1;
    if (r.expected === 'OUT' && r.verdict === 'OUT') tp += 1;
    if (r.expected !== 'OUT' && r.verdict === 'OUT') fp += 1;
    if (r.expected === 'OUT' && r.verdict !== 'OUT') fn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const precisionCi = wilson(tp, tp + fp);
  const recallCi = wilson(tp, tp + fn);
  return {
    n: rows.length,
    correct,
    accuracy: rows.length ? Number(((correct / rows.length) * 100).toFixed(1)) : 0,
    tp,
    fp,
    fn,
    precision,
    recall,
    precisionCi,
    recallCi,
    floorsMet: precision >= FLOOR_OUT_PRECISION && recall >= FLOOR_OUT_RECALL,
    floorInsideCi: precisionCi[0] < FLOOR_OUT_PRECISION || recallCi[0] < FLOOR_OUT_RECALL,
  };
}

function printSplit(name: string, m: SplitMetrics) {
  const ci = (c: [number, number]) => `[${c[0].toFixed(2)},${c[1].toFixed(2)}]`;
  console.log(`  ${name}: ${m.correct}/${m.n} (${m.accuracy}%)`);
  console.log(
    `    OUT precision ${m.precision.toFixed(2)} ${ci(m.precisionCi)} (floor ${FLOOR_OUT_PRECISION})  recall ${m.recall.toFixed(2)} ${ci(m.recallCi)} (floor ${FLOOR_OUT_RECALL})  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`,
  );
  if (m.floorsMet && m.floorInsideCi) {
    console.log(
      '    ⚠️  floors met on the POINT estimate but sit inside the 95% CI — grow OUT positives before trusting this.',
    );
  }
}

const cases = loadCasesOrExit();
console.log(
  `vision-eval: ${cases.length} cases × ${RUNS} runs  [model=${MODEL} split=${SPLIT} concurrency=${CONCURRENCY}]`,
);

// All (row, run) samples share one pool so wall-clock ≈ rows × runs / concurrency.
const jobs = cases.flatMap((c) => Array.from({ length: RUNS }, (_, r) => ({ c, r })));
const sampleResults = await pool(jobs, CONCURRENCY, ({ c, r }) => sampleOnce(c, r));
const samplesByRow = new Map<string, string[]>();
jobs.forEach((j, i) => {
  const arr = samplesByRow.get(j.c.id) ?? [];
  arr.push(sampleResults[i]);
  samplesByRow.set(j.c.id, arr);
});

const rows = cases.map((c) => {
  const samples = samplesByRow.get(c.id) ?? [];
  const { verdict, unanimous } = majority(samples);
  return { ...c, verdict, unanimous, samples };
});

const flips = rows.filter((r) => !r.unanimous);
const confusion: Record<string, Record<string, number>> = {};
const byCategory: Record<string, { correct: number; total: number }> = {};
for (const r of rows) {
  const ok = r.verdict === r.expected;
  byCategory[r.category] ??= { correct: 0, total: 0 };
  byCategory[r.category].total += 1;
  if (ok) byCategory[r.category].correct += 1;
  confusion[r.expected] ??= {};
  confusion[r.expected][r.verdict] = (confusion[r.expected][r.verdict] ?? 0) + 1;
  console.log(
    `  ${r.id.padEnd(34)} ${ok ? 'OK  ' : 'FAIL'}  got=${r.verdict} want=${r.expected}${r.unanimous ? '' : ` (flip: ${r.samples.join('/')})`}`,
  );
}

const dev = metricsFor(rows.filter((r) => r.split === 'dev'));
const holdout = metricsFor(rows.filter((r) => r.split === 'holdout'));
const all = metricsFor(rows);

console.log('');
console.log(`vision-eval summary  [model=${MODEL} runs=${RUNS}]`);
printSplit('all    ', all);
if (SPLIT === 'all') {
  printSplit('dev    ', dev);
  printSplit('holdout', holdout);
}
console.log(
  `  flip rate: ${flips.length}/${rows.length} rows non-unanimous${flips.length ? ` (${flips.map((f) => f.id).join(', ')})` : ''}`,
);
// MDE guidance: positives needed for a ±0.05 CI half-width at the observed precision.
const pHat = all.precision || 0.9;
const mdeN = Math.ceil((1.96 ** 2 * pHat * (1 - pHat)) / 0.05 ** 2);
console.log(
  `  MDE: ±0.05 CI on OUT precision at p≈${pHat.toFixed(2)} needs ~${mdeN} predicted-OUT rows (have ${all.tp + all.fp})`,
);
for (const [want, gots] of Object.entries(confusion)) {
  const cells = Object.entries(gots)
    .map(([g, n]) => `${g}=${n}`)
    .join(' ');
  console.log(`  want ${want.padEnd(5)} → ${cells}`);
}
for (const [cat, s] of Object.entries(byCategory)) {
  console.log(`  ${cat.padEnd(24)} ${s.correct}/${s.total}`);
}

// The shipping bar keys on the HOLDOUT split (dev is the iteration surface).
const gateMetrics = SPLIT === 'dev' ? dev : holdout;
if (failMode && gateMetrics.n === 0) {
  console.error('\nFAIL: no holdout rows ran — floors cannot be evaluated.');
  process.exit(1);
}

// Regression vs baseline: OUT-binary per-row flips (McNemar mid-p), NEVER aggregate deltas.
let regressed = false;
if (existsSync(baselinePath) && ONLY.size === 0) {
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baseById = new Map<string, string>(
    (base.rows ?? []).map((r: { id: string; verdict: string }) => [r.id, r.verdict]),
  );
  let b = 0; // baseline OUT-binary-correct → now wrong
  let c = 0; // baseline wrong → now correct
  for (const r of rows) {
    const bv = baseById.get(r.id);
    if (bv === undefined) continue;
    const baseOk = (bv === 'OUT') === (r.expected === 'OUT');
    const nowOk = (r.verdict === 'OUT') === (r.expected === 'OUT');
    if (baseOk && !nowOk) b += 1;
    if (!baseOk && nowOk) c += 1;
  }
  const p = mcNemarMidP(b, c);
  console.log(
    `  vs baseline (OUT-binary flips): worsened=${b} improved=${c} mid-p=${p.toFixed(3)}`,
  );
  regressed = b > c && p < 0.05;
}

const summary = {
  model: MODEL,
  runs: RUNS,
  split: SPLIT,
  all: { accuracy: all.accuracy, precision: all.precision, recall: all.recall },
  dev: { n: dev.n, precision: dev.precision, recall: dev.recall },
  holdout: {
    n: holdout.n,
    precision: holdout.precision,
    recall: holdout.recall,
    floorsMet: holdout.floorsMet,
  },
  flipRate: Number((flips.length / Math.max(1, rows.length)).toFixed(3)),
  rows: rows.map((r) => ({ id: r.id, expected: r.expected, verdict: r.verdict })),
};

appendFileSync(
  ledgerPath,
  `${JSON.stringify({ at: new Date().toISOString(), ...summary, rows: undefined })}\n`,
);

if (writeBaseline && ONLY.size === 0) {
  writeFileSync(baselinePath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`  wrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
}

if (failMode && (!gateMetrics.floorsMet || regressed)) {
  console.error(
    `\nFAIL: ${gateMetrics.floorsMet ? 'OUT-binary flips regressed vs baseline' : `holdout floors not met (precision ${gateMetrics.precision.toFixed(2)}/${FLOOR_OUT_PRECISION}, recall ${gateMetrics.recall.toFixed(2)}/${FLOOR_OUT_RECALL})`}.`,
  );
  process.exit(1);
}
process.exit(0);
