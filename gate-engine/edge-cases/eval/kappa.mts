#!/usr/bin/env bun

/**
 * Label-noise floor: blind second-labeler agreement (methodology audit F7 / house checklist #6).
 *
 *   bun gate-engine/edge-cases/eval/kappa.mts --cases 12            # sample, relabel with KAPPA_MODEL, report κ
 *   bun gate-engine/edge-cases/eval/kappa.mts --report              # recompute κ from an existing second pass
 *
 * Samples cases deterministically (seeded by --seed, default 1118), relabels them BLIND (the
 * second labeler never sees the first pass — label.mts has no access to proposals when writing to
 * a fresh LABEL_OUT), matches the two passes' findings via the SHARED pre-registered match rule
 * (lib/match.mts `matchFindings` — the one implementation the bench and ceiling calibration also
 * run), and reports Cohen's κ on verdict and on wasLiveBug over matched pairs, plus the unmatched
 * rate (segmentation disagreement — itself a noise signal).
 *
 * sc-1119 note: the matcher moved into lib/match.mts and gained the contract's item-3 exception
 * (one broad finding covering two counterparts) — a behavior change TOWARD the registered
 * contract. κ math still runs over greedy one-to-one pairs (an item-3 credit pairs one finding
 * with two labels, which κ cannot use); credits are surfaced in the unmatched accounting instead.
 *
 * Interpretation contract (README): report κ next to every sc-1119 results table; a variant delta
 * smaller than the disagreement floor is unresolved. Target α ≥ 0.667 (Krippendorff's threshold
 * for tentative conclusions) — below that, labels need another audit round before benching.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchFindings } from './lib/match.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.join(here, 'raw');
const firstPassPath = path.join(rawDir, 'proposals.jsonl');
const secondPassPath = path.join(rawDir, 'proposals.kappa.jsonl');

const KAPPA_MODEL = process.env.KAPPA_MODEL ?? 'haiku';
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const nCases = Number(flag('--cases') ?? 12);
const seed = Number(flag('--seed') ?? 1118);
const reportOnly = argv.includes('--report');

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// deterministic PRNG (mulberry32) — the sample must be reproducible and pre-registerable.
// Same generator as lib/stats.mts's export; kept local so the historical seed-1118 sample
// stays byte-identical regardless of stats.mts evolution.
const mulberry32 = (seed) => {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const first = readJsonl(firstPassPath);
if (!first.length) {
  console.error('kappa: raw/proposals.jsonl is empty — run label.mts first');
  process.exit(2);
}

if (!reportOnly) {
  const eligible = first.filter((p) => !p.degenerate && (p.findings ?? []).length > 0);
  const rng = mulberry32(seed);
  const shuffled = [...eligible].sort(() => rng() - 0.5);
  const sample = shuffled.slice(0, nCases).map((p) => p.id);
  console.log(`kappa: relabeling ${sample.length} cases with ${KAPPA_MODEL} (seed ${seed})`);
  execFileSync('bun', [path.join(here, 'label.mts'), '--ids', sample.join(',')], {
    stdio: 'inherit',
    env: { ...process.env, LABEL_MODEL: KAPPA_MODEL, LABEL_OUT: secondPassPath },
  });
}

// ── match the two passes with the SHARED pre-registered rule (lib/match.mts) ─────────────────────
const second = readJsonl(secondPassPath);
const firstById = new Map(first.map((p) => [p.id, p]));
const pairs = [];
let unmatchedA = 0;
let unmatchedB = 0;
let item3 = 0;
for (const b of second) {
  const a = firstById.get(b.id);
  if (!a) continue;
  const m = matchFindings(a.findings, b.findings);
  for (const { j, g } of m.pairs) pairs.push([j, g]);
  item3 += m.item3Credits.length;
  unmatchedA += m.unmatchedJudge.length;
  unmatchedB += m.unmatchedGold.length;
}

const kappaOf = (key) => {
  const cats = [...new Set(pairs.flatMap(([a, b]) => [String(a[key]), String(b[key])]))];
  const n = pairs.length;
  if (!n) return Number.NaN;
  const agree = pairs.filter(([a, b]) => String(a[key]) === String(b[key])).length / n;
  let pe = 0;
  for (const c of cats) {
    const pa = pairs.filter(([a]) => String(a[key]) === c).length / n;
    const pb = pairs.filter(([, b]) => String(b[key]) === c).length / n;
    pe += pa * pb;
  }
  // single-class degenerate case: κ is UNDEFINED (0/0), not 0 — reporting 0 would read as
  // chance-level agreement when raw agreement is 100%
  if (1 - pe === 0) return Number.NaN;
  return (agree - pe) / (1 - pe);
};
const fmtKappa = (k) =>
  Number.isNaN(k) ? 'undefined (single-class — see raw agreement)' : k.toFixed(3);

console.log(
  `kappa: ${pairs.length} matched finding pairs (unmatched: ${unmatchedA} first-pass, ${unmatchedB} second-pass; item-3 covered credits: ${item3})`,
);
console.log(`  verdict    κ = ${fmtKappa(kappaOf('verdict'))}`);
console.log(`  wasLiveBug κ = ${fmtKappa(kappaOf('wasLiveBug'))}`);
console.log(
  `  raw agreement: verdict ${((pairs.filter(([a, b]) => a.verdict === b.verdict).length / (pairs.length || 1)) * 100).toFixed(1)}% · wasLiveBug ${((pairs.filter(([a, b]) => String(a.wasLiveBug) === String(b.wasLiveBug)).length / (pairs.length || 1)) * 100).toFixed(1)}%`,
);
