/** AACR-Bench narrow run: the four-lens correctness cascade over AACR pull requests carrying Code
 * Defect references. Rule: docs/benchmarks/external/aacr/pre-registration.md. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTerminal, openLensCheckpoint } from '../../scale/lens-run.mts';
import { arg, argInt, argOr, silenceBenchTelemetry } from '../../scale/bench-args.mts';
import { ensurePrivateDir, prepareAll, runPr } from '../pr-run.mts';
import { type AacrSample, exportAacrResult, selectAacr, toStandardJsonl } from './aacr-export.mts';

/** sha256 of dataset/positive_samples.json at alibaba/aacr-bench 68a56975, pinned by the rule. */
const POSITIVES_SHA = '7a4a0e7046ffd1b8f41f951480bbb618d23d38d9f67364f38aabcda121a50be3';
const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'svelte'];

const research = arg('research', path.join(os.homedir(), '.devkit', 'research', 'aacr'))!;
const upstream = arg('upstream', path.join(research, 'upstream'))!;
const only = new Set(argOr('pr', '').split(',').filter(Boolean));
const model = argOr('model', 'claude-haiku-5-5');
const run = argOr('run', 'r1');
silenceBenchTelemetry();

function readSamples(file: string, sha?: string): AacrSample[] {
  const text = readFileSync(path.join(upstream, 'dataset', file), 'utf8');
  const got = createHash('sha256').update(text).digest('hex');
  if (sha && got !== sha) throw new Error(`${file}: sha256 ${got} is not the pinned ${sha}`);
  // SAFETY: AACR-Bench sample files are JSON arrays of the AacrSample fields (plus others unused).
  return JSON.parse(text) as AacrSample[];
}
const pick = {
  languages: new Set(argOr('lang', 'TypeScript,JavaScript').split(',')),
  category: 'Code Defect',
};
const select = (file: string, sha?: string) =>
  selectAacr(readSamples(file, sha), pick).filter((i) => only.size === 0 || only.has(i.instanceId));
const positives = select('positive_samples.json', POSITIVES_SHA);
const negatives = select('negative_samples.json');
const refCount = (set: typeof positives): number => set.reduce((n, i) => n + i.refs.length, 0);
console.error(
  `aacr: ${refCount(positives)} Code Defect refs on ${positives.length} PRs (left-side excluded ${positives.reduce((n, i) => n + i.excludedLeft, 0)}); ${refCount(negatives)} rejected on ${negatives.length} PRs`,
);

const runDir = path.join(research, 'runs', `${model}-whole-${run}`);
const resultsDir = path.join(runDir, 'results');
ensurePrivateDir(resultsDir);
writeFileSync(path.join(runDir, 'positives.jsonl'), toStandardJsonl(positives), { mode: 0o600 });
writeFileSync(path.join(runDir, 'negatives.jsonl'), toStandardJsonl(negatives), { mode: 0o600 });

const settings = {
  research,
  devkitRoot: path.resolve(import.meta.dirname, '../../../../../..'),
  include: EXTENSIONS.map((e) => `**/*.${e}`),
  keyPrefix: (key: string) => `${model}|${run}|aacr:${key}`,
  arms: ['whole'],
  model,
  issueCap: argOr('issue-cap', '3'),
  concurrency: argInt('concurrency', 2),
  ckpt: openLensCheckpoint(path.join(runDir, 'checkpoint.jsonl')),
};
const instances = new Map([...negatives, ...positives].map((i) => [i.instanceId, i]));
const { prepared, excluded } = prepareAll(
  [...instances.values()].map((i) => ({
    key: i.instanceId,
    repoName: i.repo.replace('/', '_'),
    remotes: [`https://github.com/${i.repo}.git`],
    base: i.base,
    head: i.head,
  })),
  settings,
);
if (process.argv.includes('--dry-run')) process.exit(0);

const summary = [];
for (const { pr, r } of prepared) {
  const rows = await runPr(r, settings);
  const out = exportAacrResult(rows, r.staged);
  if (out)
    writeFileSync(
      path.join(resultsDir, `${pr.key}.json`),
      `${JSON.stringify({ review_output: out.review_output }, null, 2)}\n`,
      { mode: 0o600 },
    );
  else excluded.push({ key: pr.key, reason: 'no terminal lens verdict' });
  const inScope = new Set(r.sel.files);
  const row = {
    id: pr.key,
    diffSha: r.diffSha,
    loc: r.diffLines,
    files: r.diffFiles,
    scopeFiles: r.sel.files.length,
    refsNotInScope: (positives.find((i) => i.instanceId === pr.key)?.refs ?? [])
      .filter((x) => !inScope.has(x.path))
      .map((x) => x.level),
    tasks: rows.length,
    inconclusive: rows.filter((x) => !isTerminal(x)).length,
    exported: out?.review_output.length ?? 0,
    withheld: out?.withheld ?? 0,
    multiFile: out?.multiFile ?? 0,
  };
  summary.push(row);
  console.error(
    `${pr.key}: ${row.tasks - row.inconclusive}/${row.tasks} terminal · exported ${row.exported} · withheld ${row.withheld} · multi-file ${row.multiFile}`,
  );
}
writeFileSync(
  path.join(runDir, 'run-summary.json'),
  `${JSON.stringify({ model, run, positivesSha: POSITIVES_SHA, prs: summary, excluded }, null, 2)}\n`,
  { mode: 0o600 },
);
console.error(`results → ${resultsDir}\nnext: aacr-score.mts --runs <run,run>`);
