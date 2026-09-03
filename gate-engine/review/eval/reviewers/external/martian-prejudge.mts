/** PROXY for Martian's step3 when no API key is configured: their JUDGE_PROMPT verbatim through a
 * local light judge, evaluations.json shape. Different judge, no extraction/dedup — first read only. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execJudgeAsync } from '../../../../judge/run-judge.mts';
import { type Golden, readFragment } from './martian-export.mts';
import { arg, argInt, silenceBenchTelemetry } from '../scale/bench-args.mts';

silenceBenchTelemetry();

const REPO = arg('repo');
const MODEL = arg('model', 'sonnet')!;
const JUDGE = arg('judge', 'haiku')!;
const CONCURRENCY = argInt('concurrency', 2);
const RESEARCH = arg('research', path.join(os.homedir(), '.devkit', 'research', 'martian'))!;
const TOOL = 'devkit-correctness';
if (!REPO) {
  console.error('usage: martian-prejudge --repo <stem> [--model sonnet] [--judge haiku]');
  process.exit(2);
}

/** Verbatim from offline/code_review_benchmark/step3_judge_comments.py (JUDGE_PROMPT). */
const JUDGE_PROMPT = (golden: string, candidate: string): string =>
  `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
${golden}

Candidate Issue (from the tool's review):
${candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}`;

interface Verdict {
  match: boolean;
  confidence: number;
}
/** The LAST "match" and the LAST "confidence" in the reply — the answer object comes after any
 * reasoning that might quote the prompt's own `true/false` example. */
export function parseVerdict(text: string): Verdict | null {
  // `\b(?!\/)` skips the prompt's own template text `"match": true/false` if the judge echoes it.
  const matches = [...text.matchAll(/"match"\s*:\s*(true|false)\b(?!\/)/g)];
  if (matches.length === 0) return null;
  const confs = [...text.matchAll(/"confidence"\s*:\s*([0-9.]+)/g)];
  const last = confs.at(-1);
  return { match: matches.at(-1)![1] === 'true', confidence: last ? Number(last[1]) : 0.5 };
}

const runsDir = path.join(RESEARCH, 'runs', REPO);
const fragmentPath = path.join(runsDir, `benchmark_data.fragment.${MODEL}.json`);
if (!existsSync(fragmentPath))
  throw new Error(`no fragment at ${fragmentPath} — run martian-bench first`);
const fragment = readFragment(readFileSync(fragmentPath, 'utf8'));
// SAFETY: Martian's golden file (cached by martian-bench.mts).
const goldens = JSON.parse(
  readFileSync(path.join(RESEARCH, 'goldens', `${REPO}.json`), 'utf8'),
) as Golden[];
const ckptPath = path.join(runsDir, `prejudge.${MODEL}.${JUDGE}.pairs.jsonl`);
const verdicts = new Map<string, Verdict>();
if (existsSync(ckptPath))
  for (const l of readFileSync(ckptPath, 'utf8').split('\n'))
    if (l.trim()) {
      try {
        // SAFETY: append-only, written below as {key, match, confidence}.
        const v = JSON.parse(l) as { key: string } & Verdict;
        verdicts.set(v.key, { match: v.match, confidence: v.confidence });
      } catch {
        // a kill mid-append tore this line — that pair is re-judged
      }
    }

interface Pair {
  key: string;
  url: string;
  gIdx: number;
  cIdx: number;
  golden: string;
  candidate: string;
}
const pairs: Pair[] = [];
for (const g of goldens) {
  const entry = fragment.get(g.url);
  if (!entry) continue;
  const review = entry.reviews.find((r) => r.tool === TOOL);
  if (!review) continue;
  g.comments.forEach((c, gIdx) =>
    review.review_comments.forEach((rc, cIdx) => {
      const key = `${g.url.split('/').pop()}|${gIdx}|${cIdx}`;
      pairs.push({ key, url: g.url, gIdx, cIdx, golden: c.comment, candidate: rc.body });
    }),
  );
}
const pending = pairs.filter((p) => !verdicts.has(p.key));
console.error(
  `prejudge: ${pairs.length} pair(s) over ${fragment.size} PR(s); ${pending.length} to judge with ${JUDGE}`,
);

let cursor = 0;
async function worker(): Promise<void> {
  while (cursor < pending.length) {
    const p = pending[cursor];
    cursor += 1;
    const out = await execJudgeAsync({
      label: `martian-prejudge:${p.key}`,
      args: ['-p', JUDGE_PROMPT(p.golden, p.candidate), '--model', JUDGE],
      input: '',
      timeout: 120_000,
      cwd: process.cwd(),
    });
    const v = parseVerdict(String(out ?? ''));
    if (!v) {
      console.error(`  ${p.key} → NO VERDICT (outage/malformed) — re-drives next run`);
      continue;
    }
    verdicts.set(p.key, v);
    writeFileSync(ckptPath, `${JSON.stringify({ key: p.key, ...v })}\n`, {
      flag: 'a',
      mode: 0o600,
    });
    console.error(`  ${p.key} → ${v.match ? 'MATCH' : 'no'} (${v.confidence})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// Reduce to evaluations.json shape: per golden keep the highest-confidence matching candidate;
// a candidate matched to no golden is a false positive.
interface ToolEvaluation {
  skipped: boolean;
  true_positives: Array<{
    golden_comment: string;
    severity: string;
    category: string;
    matched_candidate: string;
    confidence: number;
  }>;
  false_negatives: Array<{ golden_comment: string; severity: string; category: string }>;
  false_positives: Array<{ candidate: string }>;
  judge: string;
}
const evaluations = new Map<string, Record<typeof TOOL, ToolEvaluation>>();
let unjudgedPairs = 0;
for (const g of goldens) {
  const entry = fragment.get(g.url);
  if (!entry) continue;
  const review = entry.reviews.find((r) => r.tool === TOOL);
  if (!review) continue;
  const tp: Array<{
    golden_comment: string;
    severity: string;
    category: string;
    matched_candidate: string;
    confidence: number;
  }> = [];
  const fn: Array<{ golden_comment: string; severity: string; category: string }> = [];
  const matchedCandidates = new Set<number>();
  // Any unjudged pair (outage, malformed reply) skips the whole PR: a golden scored FN because its
  // judge call failed is a fabricated miss, and Martian's own shape has `skipped` for exactly this.
  const prKey = g.url.split('/').pop();
  const missing = g.comments.flatMap((_c, gIdx) =>
    review.review_comments.filter((_rc, cIdx) => !verdicts.has(`${prKey}|${gIdx}|${cIdx}`)),
  ).length;
  if (missing > 0) {
    unjudgedPairs += missing;
    evaluations.set(g.url, {
      [TOOL]: {
        skipped: true,
        true_positives: [],
        false_negatives: [],
        false_positives: [],
        judge: `${JUDGE} (proxy) — ${missing} pair(s) unjudged, re-run`,
      },
    });
    continue;
  }
  g.comments.forEach((c, gIdx) => {
    let best: { cIdx: number; confidence: number } | null = null;
    review.review_comments.forEach((_rc, cIdx) => {
      const v = verdicts.get(`${prKey}|${gIdx}|${cIdx}`);
      if (!v) return;
      if (v.match && (best === null || v.confidence > best.confidence))
        best = { cIdx, confidence: v.confidence };
    });
    if (best) {
      matchedCandidates.add(best.cIdx);
      tp.push({
        golden_comment: c.comment,
        severity: c.severity,
        category: c.category,
        matched_candidate: review.review_comments[best.cIdx].body,
        confidence: best.confidence,
      });
    } else fn.push({ golden_comment: c.comment, severity: c.severity, category: c.category });
  });
  const fp = review.review_comments
    .filter((_rc, cIdx) => !matchedCandidates.has(cIdx))
    .map((rc) => ({ candidate: rc.body }));
  evaluations.set(g.url, {
    [TOOL]: {
      skipped: false,
      true_positives: tp,
      false_negatives: fn,
      false_positives: fp,
      judge: `${JUDGE} (local proxy, Martian JUDGE_PROMPT verbatim)`,
    },
  });
}
const outPath = path.join(runsDir, `prejudge.${MODEL}.${JUDGE}.evaluations.json`);
mkdirSync(runsDir, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(Object.fromEntries(evaluations), null, 2)}\n`, {
  mode: 0o600,
});
console.error(
  `evaluations (proxy) → ${outPath}${unjudgedPairs ? ` — ${unjudgedPairs} pair(s) unjudged, re-run to complete` : ''}`,
);
