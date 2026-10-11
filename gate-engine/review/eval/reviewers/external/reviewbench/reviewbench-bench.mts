/** Runs devkit's four-lens correctness cascade over ReviewBench PRs and exports its judging input;
 * each `--run` label is an independent, separately checkpointed repeat for the noise band. */
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanMaterialized } from '../../scale/materialize.mts';
import { isTerminal, openLensCheckpoint } from '../../scale/lens-run.mts';
import { arg, argInt, argOr, silenceBenchTelemetry } from '../../scale/bench-args.mts';
import {
  diffSize,
  ensureClone,
  ensurePrivateDir,
  fetchCommits,
  prepareAll,
  runPr,
} from '../pr-run.mts';
import { benchGateHash } from '../../corpus.mts';
import { exportReviewBench } from './reviewbench-export.mts';

interface ManifestPr {
  repo: string;
  pr_number: number;
  base: string;
  head: string;
  nwo: string;
  language: string;
}

/** One include list for every PR, shared with the AACR-Bench adapter; tests stay in scope because
 * production correctness reviews them too. */
const INCLUDE = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'svelte',
  'py',
  'go',
  'cs',
  'rs',
  'java',
  'kt',
  'swift',
  'rb',
  'php',
  'sh',
].map((e) => `**/*.${e}`);

const prKey = (p: ManifestPr): string =>
  `${p.nwo.replace('/', '_')}_${p.pr_number}-${p.head.slice(0, 8)}`;

const UPSTREAM = arg(
  'upstream',
  path.join(os.homedir(), '.devkit', 'research', 'reviewbench', 'upstream'),
)!;
const RESEARCH = arg('research', path.join(os.homedir(), '.devkit', 'research', 'reviewbench'))!;
const SET = argOr('set', 'test');
const ONLY = new Set(argOr('pr', '').split(',').filter(Boolean));
const LANGS = new Set(argOr('lang', '').split(',').filter(Boolean));
const ARMS = argOr('arms', 'whole').split(',').filter(Boolean);
const MODEL = argOr('model', 'claude-haiku-5-5');
const RUN = argOr('run', 'r1');
const ISSUE_CAP = argOr('issue-cap', '3');
const CONCURRENCY = argInt('concurrency', 2);
const DRY = process.argv.includes('--dry-run');
if (process.argv.includes('--clean')) {
  cleanMaterialized(path.join(RESEARCH, 'worktrees'));
  process.exit(0);
}
silenceBenchTelemetry();
ensurePrivateDir(RESEARCH);

const manifestFile = SET === 'test' ? 'corpus/test/test.json' : 'corpus/manifest.json';
// SAFETY: ReviewBench's manifest is a JSON array of the ManifestPr fields (plus others unused here).
const manifest = JSON.parse(
  readFileSync(path.join(UPSTREAM, manifestFile), 'utf8'),
) as ManifestPr[];
const selected = manifest.filter(
  (p) => (ONLY.size === 0 || ONLY.has(prKey(p))) && (LANGS.size === 0 || LANGS.has(p.language)),
);
console.error(`reviewbench ${SET}: ${manifest.length} PRs; ${selected.length} selected`);

const remotesOf = (p: ManifestPr): string[] => [
  `https://github.com/review-bench/${p.nwo.replace('/', '_')}.git`,
  `${p.repo}.git`,
];
// Sizing pass for subset selection: clone, fetch and numstat only; no worktree, no model call.
if (process.argv.includes('--sizes')) {
  const sizes = selected.map((p) => {
    try {
      const repoDir = ensureClone(
        path.join(RESEARCH, 'repos'),
        p.nwo.replace('/', '_'),
        remotesOf(p),
      );
      if (!fetchCommits(repoDir, remotesOf(p), [p.base, p.head]))
        return { key: prKey(p), error: 'unfetchable' };
      return { key: prKey(p), language: p.language, ...diffSize(repoDir, p.base, p.head) };
    } catch (e) {
      return { key: prKey(p), error: String(e).split('\n')[0].slice(0, 200) };
    }
  });
  const out = path.join(RESEARCH, `sizes-${SET}.json`);
  writeFileSync(out, `${JSON.stringify(sizes, null, 2)}\n`, { mode: 0o600 });
  console.error(`sizes → ${out} (${sizes.length} PRs)`);
  process.exit(0);
}

const devkitRoot = path.resolve(import.meta.dirname, '../../../../../..');
const label = `${MODEL}-${ARMS.join('+')}-${RUN}`;
const runDir = path.join(RESEARCH, 'runs', label);
ensurePrivateDir(path.join(runDir, 'findings'));
const settings = {
  research: RESEARCH,
  devkitRoot,
  include: INCLUDE,
  keyPrefix: (key: string) => `${MODEL}|${RUN}|reviewbench:${key}`,
  arms: ARMS,
  model: MODEL,
  issueCap: ISSUE_CAP,
  concurrency: CONCURRENCY,
  ckpt: openLensCheckpoint(path.join(runDir, 'checkpoint.jsonl')),
};
const { prepared, excluded } = prepareAll(
  selected.map((p) => ({
    ...p,
    key: prKey(p),
    repoName: p.nwo.replace('/', '_'),
    remotes: remotesOf(p),
  })),
  settings,
);
// Compared runs must share this hash of the reviewer's gate code, brief and skill.
const gateHash = prepared.length > 0 ? benchGateHash(prepared[0].r.sel.reviewer) : null;
console.error(`model ${MODEL} · gateHash ${gateHash}`);
if (DRY) process.exit(0);

interface PrSummary {
  key: string;
  diffSha: string;
  language: string;
  loc: number;
  files: number;
  scopeFiles: number;
  /** Staged paths the correctness reviewer held in scope; private, never committed. */
  scopePaths: string[];
  evidenceOmitted: number;
  evidenceTruncated: number;
  tasks: number;
  inconclusive: number;
  exported: number;
  withheldNoFile: number;
  withheldFileNoLine: number;
  withheldFileNoLineStrict: number;
  crossFile: number;
}
const summary: PrSummary[] = [];
for (const { pr: p, r } of prepared) {
  const { key } = p;
  const rows = await runPr(r, settings);
  const out = exportReviewBench({
    pr: { repo: p.repo, pr_number: p.pr_number, base: p.base, head: p.head },
    agent: `devkit-correctness-${MODEL}`,
    staged: r.staged,
    rows,
  });
  const inconclusive = rows.filter((x) => !isTerminal(x)).length;
  if (out.file)
    writeFileSync(
      path.join(runDir, 'findings', `${key}.json`),
      `${JSON.stringify(out.file, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  else excluded.push({ key, reason: 'no terminal lens verdict' });
  summary.push({
    key,
    diffSha: r.diffSha,
    language: p.language,
    loc: r.diffLines,
    files: r.diffFiles,
    scopeFiles: r.sel.files.length,
    scopePaths: [...r.sel.files],
    evidenceOmitted: r.evidence.omitted_files,
    evidenceTruncated: r.evidence.truncated_files,
    tasks: out.tasks,
    inconclusive,
    exported: out.file?.findings.length ?? 0,
    withheldNoFile: out.withheldNoFile,
    withheldFileNoLine: out.withheldFileNoLine,
    withheldFileNoLineStrict: out.withheldFileNoLineStrict,
    crossFile: out.crossFile,
  });
  console.error(
    `${key}: ${out.terminalTasks}/${out.tasks} terminal · exported ${out.file?.findings.length ?? 0} · withheld no-file ${out.withheldNoFile} file-no-line ${out.withheldFileNoLine}`,
  );
}
writeFileSync(
  path.join(runDir, 'run-summary.json'),
  `${JSON.stringify({ label, set: SET, model: MODEL, gateHash, arms: ARMS, run: RUN, prs: summary, excluded }, null, 2)}\n`,
  { mode: 0o600 },
);
console.error(
  `findings → ${path.join(runDir, 'findings')}\nnext: (cd ${UPSTREAM} && npm run judge -- --candidate ${path.join(runDir, 'findings')} --provider claude-cli --model claude-sonnet-5 --output ${path.join(runDir, 'scoring-cli', 'results.json')} --repo-dir ${path.join(RESEARCH, 'judge-repos')} --concurrency 2)`,
);
