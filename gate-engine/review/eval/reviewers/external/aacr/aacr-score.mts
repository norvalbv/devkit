/** Score AACR-Bench runs with the benchmark's own evaluator and reduce them to a counts-only report.
 * Rule: docs/benchmarks/external/aacr/pre-registration.md. */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arg, argOr } from '../../scale/bench-args.mts';
import { assertCountsOnlyJson } from '../holes.mts';
import { clusterBootstrap } from '../reviewbench/reviewbench-score.mts';
import {
  type AacrInstance,
  type AacrSample,
  cellStat,
  evaluatorFinished,
  type RefVerdict,
  refVerdicts,
  selectAacr,
} from './aacr-export.mts';

const JUDGE_MODEL = 'qwen/qwen3-235b-a22b-2507';
const JUDGE_BASE_URL = 'https://openrouter.ai/api/v1';
const ROUNDS = 3;
/** The review scope's extensions (pre-registration); a reference on any other file is out of scope. */
const IN_SCOPE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|svelte)$/;

const research = arg('research', path.join(os.homedir(), '.devkit', 'research', 'aacr'))!;
const upstream = path.join(arg('upstream', path.join(research, 'upstream'))!, 'evaluation');
const model = argOr('model', 'claude-haiku-5-5');
const runs = argOr('runs', 'r1,r2').split(',');
const out = arg('out');

function finished(dir: string): boolean {
  const log = path.join(dir, 'evaluator.log');
  const rounds = readdirSync(dir).filter((f) => f.includes('_round_')).length;
  return evaluatorFinished(existsSync(log) ? readFileSync(log, 'utf8') : null, rounds, ROUNDS);
}

/** Run the upstream evaluator once into `dir` unless a finished scoring is already there. */
function evaluate(runDir: string, set: string, k: number): string {
  const dir = path.join(runDir, `metrics-${set}-k${k}`);
  const results = readdirSync(path.join(runDir, 'results'));
  if (existsSync(dir) && readdirSync(dir).some((f) => f.includes('_round_'))) {
    if (finished(dir) && results.every((f) => existsSync(path.join(dir, f)))) return dir;
    throw new Error(`${dir} holds a partial or stale scoring; delete it to re-score`);
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key)
    throw new Error('OPENROUTER_API_KEY unset: the upstream judge would fall back to a mock');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of results)
    if (!existsSync(path.join(dir, f)))
      symlinkSync(path.join(runDir, 'results', f), path.join(dir, f));
  const log = execFileSync(
    path.join(upstream, '.venv', 'bin', 'python'),
    [
      ...['-m', 'pipeline', 'run', '--stage', 'eval', '--reviewer', 'codex'],
      ...['--dataset', path.join(runDir, `${set}.jsonl`), '--results-dir', dir],
      ...['--line-k', String(k), '--eval-rounds', String(ROUNDS)],
    ],
    {
      cwd: upstream,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        JUDGE_MODEL,
        JUDGE_BASE_URL,
        JUDGE_API_KEY: key,
        JUDGE_USE_MOCK: 'false',
      },
    },
  );
  writeFileSync(path.join(dir, 'evaluator.log'), log, { mode: 0o600 });
  if (!finished(dir)) throw new Error(`${dir}: evaluator left no complete LLM-mode scoring; void`);
  return dir;
}

function readRounds(dir: string, instances: readonly AacrInstance[]): RefVerdict[][] {
  return (
    readdirSync(dir)
      .filter((f) => f.includes('_round_'))
      .sort()
      .slice(-ROUNDS)
      // SAFETY: the upstream evaluator writes {eval_res:[{instance_id, comments:[...]}]}.
      .map((f) =>
        refVerdicts(JSON.parse(readFileSync(path.join(dir, f), 'utf8')).eval_res, instances),
      )
  );
}

/** Keep only references every run and round scored, in one shared order. */
function align(perRun: RefVerdict[][][]): RefVerdict[][][] {
  const all = perRun.flat();
  const shared = all[0]
    .map((v) => v.key)
    .filter((k) => all.every((r) => r.some((v) => v.key === k)));
  return perRun.map((rounds) =>
    rounds.map((r) => {
      const byKey = new Map(r.map((v) => [v.key, v]));
      return shared.map((k) => byKey.get(k)!);
    }),
  );
}

function strata(aligned: RefVerdict[][][]) {
  const levels = [...new Set(aligned[0][0].map((v) => v.level))].sort();
  const families = ['all', 'claude', 'other'] as const;
  const cells = (['all', 'in'] as const).flatMap((scope) =>
    ['all', ...levels].flatMap((level) => families.map((family) => ({ scope, level, family }))),
  );
  return cells.map(({ scope, level, family }) => {
    const keep = (v: RefVerdict): boolean =>
      (scope === 'all' || IN_SCOPE_RE.test(v.path)) &&
      (level === 'all' || v.level === level) &&
      (family === 'all' || v.family === family);
    const stat = cellStat(aligned, keep);
    const units = aligned.flatMap((rounds, run) =>
      rounds.flatMap((r) =>
        r.filter(keep).map((v) => ({
          cluster: v.repo,
          run,
          hits: Number(v.caught),
          n: 1,
        })),
      ),
    );
    return {
      scope,
      level,
      family,
      ...stat,
      ci95: clusterBootstrap(units, { iters: 10000, seed: 1 }),
    };
  });
}

const countBy = (xs: string[]): Record<string, number> =>
  Object.fromEntries([...new Set(xs)].map((x) => [x, xs.filter((y) => y === x).length]));
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const runDirs = runs.map((r) => path.join(research, 'runs', `${model}-whole-${r}`));
const pick = {
  languages: new Set(['TypeScript', 'JavaScript']),
  category: 'Code Defect',
};
const load = (file: string): AacrInstance[] =>
  // SAFETY: AACR-Bench sample files are JSON arrays of the AacrSample fields.
  selectAacr(readJson(path.join(upstream, '..', 'dataset', file)) as AacrSample[], pick);
const positives = load('positive_samples.json');
const negatives = load('negative_samples.json');

const notInScope = positives.flatMap((i) => i.refs.filter((r) => !IN_SCOPE_RE.test(r.path)));
for (const d of runDirs) {
  const listed = readJson(path.join(d, 'run-summary.json')).prs.flatMap(
    (p: { refsNotInScope: string[] }) => p.refsNotInScope,
  ).length;
  if (listed !== notInScope.length)
    throw new Error(
      `${d}: ${listed} refs outside the reviewer's scope, extension rule finds ${notInScope.length}`,
    );
}
const scored = (set: string, k: number, instances: readonly AacrInstance[]) =>
  strata(align(runDirs.map((d) => readRounds(evaluate(d, set, k), instances))));
const report = {
  benchmark: 'AACR-Bench',
  model,
  judge: JUDGE_MODEL,
  rounds: ROUNDS,
  runs: runDirs.map((d, i) => {
    const s = readJson(path.join(d, 'run-summary.json'));
    const sum = (f: string): number =>
      s.prs.reduce((n: number, p: Record<string, number>) => n + p[f], 0);
    const [tasks, inconclusive] = [sum('tasks'), sum('inconclusive')];
    return {
      run: runs[i],
      prs: s.prs.length,
      excluded: s.excluded.length,
      tasks,
      inconclusive,
      failedOnProtocol: inconclusive > 0.1 * tasks,
      exported: sum('exported'),
      withheld: sum('withheld'),
      multiFile: sum('multiFile'),
      refsNotInScope: countBy(s.prs.flatMap((p: { refsNotInScope: string[] }) => p.refsNotInScope)),
    };
  }),
  recallK1: scored('positives', 1, positives),
  recallK10: scored('positives', 10, positives),
  rejectedMatchedK1: scored('negatives', 1, negatives).filter(
    (s) => s.scope === 'all' && s.level === 'all',
  ),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
assertCountsOnlyJson(text);
if (out) writeFileSync(out, text);
console.log(text);
