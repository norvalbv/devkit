/** Reduce Martian judge output for devkit-correctness to profile scores (strict/core/all, F1+F2)
 * and the holes.mts miss partition. Asymmetries and non-comparability: docs/benchmarks/external/README.md. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORRECTNESS_LENSES } from '../../../lens/groups.mts';
import {
  assertCountsOnly,
  type ExternalFinding,
  partitionFinding,
  reduceLensHoles,
  renderLensHoles,
} from './holes.mts';
import type { ExportedContext, Golden } from './martian-export.mts';
import { arg, argInt } from '../scale/bench-args.mts';

const REPO = arg('repo');
const MODEL = arg('model', 'sonnet')!;
const EVALS = arg('evaluations');
const TOOL = arg('tool', 'devkit-correctness')!;
const RESEARCH = arg('research', path.join(os.homedir(), '.devkit', 'research', 'martian'))!;
const OUT = arg('out', path.join(RESEARCH, 'reports'))!;
const MIN_DENOMINATOR = argInt('min-denominator', 8);
if (!REPO || !EVALS) {
  console.error(
    'usage: martian-report --repo <stem> --model <m> --evaluations <evaluations.json> [--out <dir>]',
  );
  process.exit(2);
}

export const PROFILES = {
  strict: ['bug', 'security', 'concurrency', 'data', 'api'],
  core: ['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect'],
  all: null,
} as const satisfies Record<string, readonly string[] | null>;

interface Judged {
  golden_comment: string;
  severity?: string;
  category?: string;
  matched_candidate?: string;
}
interface ToolEval {
  skipped?: boolean;
  true_positives?: Judged[];
  false_negatives?: Judged[];
  false_positives?: Array<{ candidate: string }>;
}

export function lensOfCandidate(
  candidate: string,
  issues: ReadonlyArray<{ lens: string; text: string }>,
): string {
  const tag = candidate.match(/\[([a-z-]+)\]/);
  if (tag && CORRECTNESS_LENSES.some((l) => l === tag[1])) return tag[1];
  // Without the tag, attribute only when exactly ONE devkit issue's opening text sits inside the
  // candidate; several (or none) is 'unknown', never a first-match guess.
  const hits = issues.filter((i) => i.text.length >= 40 && candidate.includes(i.text.slice(0, 60)));
  const lenses = new Set(hits.map((h) => h.lens));
  return lenses.size === 1 ? hits[0].lens : 'unknown';
}

export interface ProfileScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  f2: number;
}
export function scoreProfile(
  entries: ReadonlyArray<{ tp: Judged[]; fn: Judged[]; fp: number }>,
  categories: readonly string[] | null,
): ProfileScore {
  const inProfile = (j: Judged): boolean =>
    categories === null || categories.includes(j.category ?? '');
  let tp = 0;
  let fn = 0;
  let fp = 0;
  for (const e of entries) {
    tp += e.tp.filter(inProfile).length;
    fn += e.fn.filter(inProfile).length;
    fp += e.fp;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const fb = (b: number): number =>
    precision + recall ? ((1 + b * b) * precision * recall) / (b * b * precision + recall) : 0;
  const score: ProfileScore = { tp, fp, fn, precision, recall, f1: fb(1), f2: fb(2) };
  return score;
}

// SAFETY: the goldens file is Martian's JSON array of {pr_title, url, comments} (cached by martian-bench.mts).
const goldens = JSON.parse(
  readFileSync(path.join(RESEARCH, 'goldens', `${REPO}.json`), 'utf8'),
) as Golden[];
const contextsPath = path.join(RESEARCH, 'runs', REPO, `review-context.${MODEL}.json`);
// SAFETY: review-context.*.json is written by martian-bench.mts as Record<url, ExportedContext>.
const contexts = JSON.parse(readFileSync(contextsPath, 'utf8')) as Record<string, ExportedContext>;
// SAFETY: evaluations.json is written by Martian's step3 as {url: {tool: ToolEval}}.
const evals = JSON.parse(readFileSync(EVALS, 'utf8')) as Record<string, Record<string, ToolEval>>;
/** Own-key lookup on a JSON-derived record — never reads an inherited Object.prototype member. */
const own = <T,>(rec: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(rec, key) ? rec[key] : undefined;
const contextFor = (url: string): ExportedContext | undefined => own(contexts, url);

const findings: ExternalFinding[] = [];
const entries: Array<{ tp: Judged[]; fn: Judged[]; fp: number }> = [];
let judgedPrs = 0;
// PRs that never reached the judge are NAMED, never silently dropped from the denominator: a
// review that fully errored (omitted from the fragment) or a judge that skipped the PR.
const unjudged: Array<{ pr: string; reason: string }> = [];
for (const g of goldens) {
  const perTool = own(evals, g.url);
  const ev = perTool ? own(perTool, TOOL) : undefined;
  const ctx = contextFor(g.url);
  const pr = g.url.split('/').pop() ?? g.url;
  if (!ctx) {
    unjudged.push({ pr, reason: 'not in this run' });
    continue;
  }
  if (!ev) {
    unjudged.push({
      pr,
      reason:
        ctx.issues.length === 0
          ? 'review errored (omitted from fragment) or not judged'
          : 'not judged',
    });
    continue;
  }
  if (ev.skipped) {
    unjudged.push({ pr, reason: 'judge skipped' });
    continue;
  }
  judgedPrs += 1;
  const tp = ev.true_positives ?? [];
  const fn = ev.false_negatives ?? [];
  entries.push({ tp, fn, fp: (ev.false_positives ?? []).length });
  // Two goldens on one PR can share identical text; each TP is consumed once, in order.
  const tpByText = new Map<string, Judged[]>();
  for (const j of tp)
    tpByText.set(j.golden_comment, [...(tpByText.get(j.golden_comment) ?? []), j]);
  g.comments.forEach((c, idx) => {
    const hit = tpByText.get(c.comment)?.shift();
    findings.push({
      source: 'martian',
      id: `${g.url.split('/').pop()}#${idx}`,
      changeKey: g.url,
      category: c.category,
      severity: c.severity,
      judged: hit
        ? {
            matched: true,
            lens: hit.matched_candidate
              ? lensOfCandidate(hit.matched_candidate, ctx.issues)
              : 'unknown',
          }
        : { matched: false },
    });
  });
}
const rows = findings.map((f) => partitionFinding(f, contextFor(f.changeKey)));
const report = reduceLensHoles(rows, {
  source: `martian:${REPO}@${MODEL}`,
  minDenominator: MIN_DENOMINATOR,
});
assertCountsOnly(report);
const scores = Object.fromEntries(
  Object.entries(PROFILES).map(([name, cats]) => [name, scoreProfile(entries, cats)]),
);
const merged = goldens.map((g) => contextFor(g.url)?.mergedAt ?? null);
const byYear: Record<string, number> = {};
for (const m of merged)
  byYear[m ? m.slice(0, 4) : 'unknown'] = (byYear[m ? m.slice(0, 4) : 'unknown'] ?? 0) + 1;

mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, `${REPO}-${MODEL}-summary.json`);
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      repo: REPO,
      tool: TOOL,
      reviewerModel: MODEL,
      judgedPrs,
      unjudgedPrs: unjudged,
      goldensTotal: goldens.reduce((n, g) => n + g.comments.length, 0),
      goldens: findings.length,
      prMergeYears: byYear,
      scores,
      lensHoles: report,
      comparability:
        'NOT comparable to the published leaderboard: Martian methodology §9 (no standardized harness; published tools reviewed full forked repositories). Contamination inflates recall on 2023 PRs, which shrinks apparent holes.',
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  path.join(RESEARCH, 'runs', REPO, `lens-holes.${MODEL}.findings.jsonl`),
  `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
  {
    mode: 0o600,
  },
);
if (unjudged.length)
  console.log(
    `unjudged PRs (${unjudged.length}): ${unjudged.map((u) => `#${u.pr} — ${u.reason}`).join('; ')}`,
  );
for (const [name, s] of Object.entries(scores))
  console.log(
    `${name.padEnd(7)} tp ${s.tp} fp ${s.fp} fn ${s.fn} · P ${s.precision.toFixed(2)} R ${s.recall.toFixed(2)} F1 ${s.f1.toFixed(2)} F2 ${s.f2.toFixed(2)}`,
  );
console.log(renderLensHoles(report));
console.error(`summary → ${outFile}`);
