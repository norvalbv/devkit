#!/usr/bin/env node

/**
 * sentry-eval: accuracy benchmark for the commit-message Sentry-advisory judge
 * (../check-sentry.mjs). A prompt edit is unverifiable without a measurable check; this scores the
 * SHARED prompt/parser/voting against a labelled set of commit subjects so the cheapest config that
 * classifies correctly can be LOCKED, not guessed (the token-economy goal).
 *
 * It imports the judge pieces FROM THE GATE (buildPrompt / shouldJudge / buildContext / judge), so the
 * benchmark exercises the exact path the gate runs — prompt and logic never drift.
 *
 * SEED corpus: cases.jsonl ships a small, GENERIC starter set (no repo-specific subjects). It is a
 * seed, not data the engine reads at runtime — copy it and add your own real commit subjects for a
 * meaningful score on your codebase. No baseline ships: generate yours with --baseline once tuned.
 *
 * Each row in cases.jsonl: { id, message, nameStatus?, expected:"MONITOR"|"SKIP", category, note }.
 * A row whose type free-skips (shouldJudge=false) is scored deterministically as SKIP with NO claude
 * call — so the bench only spends tokens on the judged set, exactly like the gate.
 *
 * Sweeps (the token-economy validation — pick the cheapest cell that clears the F1 target):
 *   BENCH_MODEL=haiku|sonnet     model (default haiku)
 *   BENCH_CONTEXT=message|names  message-only vs message + changed-file list (default message)
 *   BENCH_SHOTS=0|4              zero- vs few-shot (default 4)
 *   BENCH_SAMPLES=1|3            self-consistency majority-vote (default 1)
 *
 *   node bench.mjs              # run, print confusion matrix + per-category
 *   node bench.mjs --baseline   # write current run as the new baseline (results.baseline.json)
 *   node bench.mjs --fail       # exit 1 if F1 or accuracy regressed vs baseline
 *
 * Exit 0 = ran (no regression under --fail) · 1 = regression (with --fail) · 2 = could not run.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, buildPrompt, judge, shouldJudge } from '../check-sentry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesPath = path.join(here, 'cases.jsonl');
const baselinePath = path.join(here, 'results.baseline.json');

const MODEL = process.env.BENCH_MODEL ?? 'haiku';
const CONTEXT = process.env.BENCH_CONTEXT ?? 'message';
const SHOTS = Number(process.env.BENCH_SHOTS ?? '4');
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? '1') || 1;
const args = new Set(process.argv.slice(2));
const writeBaseline = args.has('--baseline');
const failOnRegression = args.has('--fail');

const parseCasesText = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function loadCasesOrExit() {
  try {
    const rows = parseCasesText(readFileSync(casesPath, 'utf8'));
    if (rows.length) return rows;
    console.error('sentry-eval: cases.jsonl is empty');
  } catch (e) {
    console.error(`sentry-eval: cannot read cases — ${e}`);
  }
  return process.exit(2);
}

/** Classify one case → its verdict. Free-skips score deterministically (no claude, no tokens). */
function classify(c) {
  if (!shouldJudge(c.message)) return { got: 'SKIP', judged: false };
  const input = buildContext(c.message, c.nameStatus, CONTEXT);
  const result = judge(input, { model: MODEL, samples: SAMPLES, prompt: buildPrompt(SHOTS) });
  if (!result) return process.exit(2); // claude unavailable → can't benchmark
  return { got: result.verdict ?? 'NULL', judged: true };
}

function f1(tp, fp, fn) {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const score = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1: score };
}

const cases = loadCasesOrExit();
const results = [];
let correct = 0;
let tp = 0;
let fp = 0;
let fn = 0;
const byCategory = {};

for (const c of cases) {
  process.stdout.write(`  ${c.id.padEnd(26)} `);
  const { got, judged } = classify(c);
  const ok = got === c.expected;
  if (ok) correct += 1;
  if (c.expected === 'MONITOR' && got === 'MONITOR') tp += 1;
  if (c.expected === 'SKIP' && got === 'MONITOR') fp += 1;
  if (c.expected === 'MONITOR' && got !== 'MONITOR') fn += 1;
  byCategory[c.category] ??= { correct: 0, total: 0 };
  byCategory[c.category].total += 1;
  if (ok) byCategory[c.category].correct += 1;
  results.push({ id: c.id, expected: c.expected, got, ok });
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  got=${got} want=${c.expected}${judged ? '' : ' (free-skip)'}`,
  );
}

const total = cases.length;
const accuracy = Number(((correct / total) * 100).toFixed(1));
const { precision, recall, f1: f1score } = f1(tp, fp, fn);

console.log('');
console.log(
  `sentry-eval: ${correct}/${total} correct (${accuracy}%)  [model=${MODEL} context=${CONTEXT} shots=${SHOTS} samples=${SAMPLES}]`,
);
console.log(
  `  MONITOR  precision ${precision.toFixed(2)}  recall ${recall.toFixed(2)}  F1 ${f1score.toFixed(2)}  (tp=${tp} fp=${fp} fn=${fn})`,
);
for (const [cat, s] of Object.entries(byCategory)) {
  console.log(`  ${cat.padEnd(16)} ${s.correct}/${s.total}`);
}

let regressed = false;
if (existsSync(baselinePath)) {
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const dF1 = f1score - base.f1;
  const dAcc = accuracy - base.accuracy;
  // Sign from the NUMBER, not the rounded string — else a delta that rounds to -0.00 prints "+-0.00".
  const arrow = (n) => (n > 0 ? '↑' : n < 0 ? '↓' : '=');
  const signed = (n, dp) => `${n > 0 ? '+' : ''}${n.toFixed(dp)}`;
  console.log(
    `  vs baseline: F1 ${arrow(dF1)} ${signed(dF1, 2)} · acc ${arrow(dAcc)} ${signed(dAcc, 1)}`,
  );
  regressed = f1score < base.f1 - 1e-9 || accuracy < base.accuracy - 1e-9;
}

const summary = {
  model: MODEL,
  context: CONTEXT,
  shots: SHOTS,
  samples: SAMPLES,
  correct,
  total,
  accuracy,
  precision: Number(precision.toFixed(3)),
  recall: Number(recall.toFixed(3)),
  f1: Number(f1score.toFixed(3)),
  byCategory,
  results,
};

if (writeBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`  wrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
}

if (failOnRegression && regressed) {
  console.error('\nFAIL: F1/accuracy regressed vs baseline.');
  process.exit(1);
}
process.exit(0);
