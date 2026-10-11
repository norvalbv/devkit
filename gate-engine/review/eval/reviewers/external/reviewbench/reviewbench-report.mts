/** Joins each run's summary to its judged details and reduces to counts per stratum, with range and
 * bootstrap CI; `--union-of a,b` pools two whole-diff runs as a chunked arm's equal-cost control. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertCountsOnlyJson } from '../holes.mts';
import { arg } from '../../scale/bench-args.mts';
import {
  clusterBootstrap,
  flipRate,
  judgeAgreement,
  reduceRun,
  stratumUnits,
  unionRuns,
  type DetailFinding,
  type GoldenFinding,
  type ScoredPr,
} from './reviewbench-score.mts';

interface SummaryPr {
  key: string;
  loc: number;
  files: number;
  withheldNoFile: number;
  withheldFileNoLine: number;
  withheldFileNoLineStrict: number;
  crossFile: number;
  tasks: number;
  inconclusive: number;
  scopePaths?: string[];
  evidenceOmitted: number;
  evidenceTruncated: number;
}

interface RunSummary {
  prs: SummaryPr[];
  excluded: unknown[];
}

interface PrDetails {
  pr_key: string;
  candidate_findings: DetailFinding[];
}

interface LoadedRun {
  prs: ScoredPr[];
  excluded: number;
  unjudged: number;
}

const GOLDEN = arg('golden');
const RUNS = (arg('runs') ?? '').split(',').filter(Boolean);
const OUT = arg('out');
// Which judge's output to reduce: each judge model writes its own subdirectory of the run.
const SCORING = arg('scoring', 'scoring')!;
// A second judge's subdirectory on the FIRST run, for label-level judge agreement.
const AGREE_WITH = arg('agree-with');
const UNION_OF = (arg('union-of') ?? '').split(',').filter(Boolean);
if (!GOLDEN || RUNS.length === 0) {
  console.error(
    'usage: reviewbench-report --golden <dir> --runs <runDir>[,<runDir>...] [--scoring <subdir>] [--agree-with <subdir>] [--out <file>]',
  );
  process.exit(2);
}

function loadRun(dir: string, scoring = SCORING): LoadedRun {
  // SAFETY: run-summary.json is written by reviewbench-bench.mts with exactly these fields.
  const summary = JSON.parse(
    readFileSync(path.join(dir, 'run-summary.json'), 'utf8'),
  ) as RunSummary;
  // SAFETY: results.details.json is ReviewBench's PRDetailedOutput[] (scripts/eval/eval.ts).
  const details = JSON.parse(
    readFileSync(path.join(dir, scoring, 'results.details.json'), 'utf8'),
  ) as PrDetails[];
  const byKey = new Map(details.map((d) => [d.pr_key, d.candidate_findings]));
  const prs: ScoredPr[] = [];
  let unjudged = 0;
  for (const s of summary.prs) {
    const candidates = byKey.get(s.key);
    // A PR the judge never scored drops out of the denominator and is counted (prereg §4d).
    if (!candidates) {
      unjudged += 1;
      continue;
    }
    // SAFETY: ReviewBench golden files are {pr_key, pr, findings: GoldenFinding[]}.
    const golden = JSON.parse(readFileSync(path.join(GOLDEN!, `${s.key}.json`), 'utf8')) as {
      findings: GoldenFinding[];
    };
    prs.push({
      ...s,
      fullyShown: s.evidenceOmitted === 0 && s.evidenceTruncated === 0,
      golden: golden.findings,
      candidates,
    });
  }
  return { prs, excluded: summary.excluded.length, unjudged };
}

const loaded = RUNS.map((dir) => loadRun(dir));
const perRun = loaded.map((r) => ({
  ...reduceRun(r.prs),
  excluded: r.excluded,
  unjudged: r.unjudged,
}));
const strata = [...new Set(perRun.flatMap((r) => Object.keys(r.recall)))].sort();
const report = {
  runs: perRun.length,
  perRun,
  judgeAgreement: AGREE_WITH
    ? judgeAgreement(loaded[0].prs, loadRun(RUNS[0], AGREE_WITH).prs)
    : null,
  wholeUnion:
    UNION_OF.length === 2
      ? reduceRun(unionRuns(loadRun(UNION_OF[0]).prs, loadRun(UNION_OF[1]).prs))
      : null,
  strata: Object.fromEntries(
    strata.map((s) => {
      const known = perRun.flatMap((r) =>
        r.recall[s] ? [r.recall[s].caught / r.recall[s].labels] : [],
      );
      return [
        s,
        {
          labels: perRun.map((r) => r.recall[s]?.labels ?? 0),
          caught: perRun.map((r) => r.recall[s]?.caught ?? 0),
          namedElsewhere: perRun.map((r) => r.namedElsewhere[s] ?? 0),
          range: known.length ? [Math.min(...known), Math.max(...known)] : null,
          flips: flipRate(
            loaded.map((r) => r.prs),
            s,
          ),
          ci95: clusterBootstrap(
            stratumUnits(
              loaded.map((r) => r.prs),
              s,
            ),
          ),
        },
      ];
    }),
  ),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
assertCountsOnlyJson(text);
if (OUT) writeFileSync(OUT, text);
else process.stdout.write(text);
