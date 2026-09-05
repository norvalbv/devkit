/** Martian Code Review Bench probe: devkit's four-lens cascade over one golden repo's PRs, exported
 * in their benchmark_data shape. Method, limits and results: docs/benchmarks/external/README.md. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGuardConfigJson } from '../../../../config.mts';
import { measureDiffEvidenceCap } from '../../../diff-evidence.mts';
import { stagedFiles } from '../../../evidence/staged-git.mts';
import { lensGroupId } from '../../../lens/split.mts';
import { selectReviewers } from '../../../reviewers.mts';
import { cleanMaterialized, materialize } from '../scale/materialize.mts';
import {
  estimateUsd,
  isTerminal,
  openLensCheckpoint,
  planLensTasks,
  runIdentity,
  runLensWave,
  syncReviewAssets,
} from '../scale/lens-run.mts';
import type { GuardConfig } from '../../../../config.mts';
import type { ReviewerSelection } from '../../../reviewers.mts';
import type { LensTask } from '../scale/lens-run.mts';
import { exportFragment, type Golden, type PrRunBase } from './martian-export.mts';
import { arg, argInt, argOr, silenceBenchTelemetry } from '../scale/bench-args.mts';

interface PrRun extends PrRunBase {
  tasks: LensTask[];
  identity: string;
  wt: string;
  sel: ReviewerSelection;
  cfg: GuardConfig;
}

const REPO = arg('repo');
const ONLY = new Set(argOr('pr', '').split(',').filter(Boolean).map(Number));
const ARMS = argOr('arms', 'whole').split(',').filter(Boolean);
const MODEL = argOr('model', 'sonnet');
const ISSUE_CAP = argOr('issue-cap', '3');
const CONCURRENCY = argInt('concurrency', 2);
const RESEARCH = arg('research', path.join(os.homedir(), '.devkit', 'research', 'martian'))!;
const DRY = process.argv.includes('--dry-run');
if (process.argv.includes('--clean')) {
  cleanMaterialized(path.join(RESEARCH, 'worktrees'));
  process.exit(0);
}
if (!REPO) {
  console.error(
    'usage: martian-bench --repo <golden file stem, e.g. cal_dot_com> [--pr n,...] [--arms whole] [--model sonnet] [--dry-run]',
  );
  process.exit(2);
}

silenceBenchTelemetry();

const ensureDir = (d: string): void => {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
};
ensureDir(RESEARCH);
const gh = (args: string[]): string =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const cached = (file: string, produce: () => string): string => {
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const text = produce();
  // tmp+rename: a kill mid-write must not leave a torn cache file that every later run trusts.
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  return text;
};

// ── goldens ──────────────────────────────────────────────────────────────────────────────────────
ensureDir(path.join(RESEARCH, 'goldens'));
const goldensRaw = cached(path.join(RESEARCH, 'goldens', `${REPO}.json`), () => {
  const b64 = gh([
    'api',
    `repos/withmartian/code-review-benchmark/contents/offline/golden_comments/${REPO}.json`,
    '--jq',
    '.content',
  ]);
  return Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
});
// SAFETY: Martian's golden files are a JSON array of {pr_title, url, comments:[{comment, severity, category}]}.
const goldens = JSON.parse(goldensRaw) as Golden[];
const prNumber = (url: string): number => Number(url.split('/').pop());
const slugOf = (url: string): string => {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  if (!m) throw new Error(`not a GitHub PR url: ${url}`);
  return m[1];
};
const selected = goldens.filter((g) => ONLY.size === 0 || ONLY.has(prNumber(g.url)));
console.error(
  `${REPO}: ${goldens.length} PRs / ${goldens.reduce((n, g) => n + g.comments.length, 0)} goldens; running ${selected.length}`,
);

// ── repo clone (blobless: materialize needs rev-list on old bases; blobs fetch lazily) ─────────
const slug = slugOf(selected[0]?.url ?? goldens[0].url);
ensureDir(path.join(RESEARCH, 'repos'));
const repoDir = path.join(RESEARCH, 'repos', slug.replace('/', '_'));
if (!existsSync(path.join(repoDir, '.git'))) {
  // Clone into a private tmp dir and rename into place: two concurrent invocations for the same
  // repo cannot interleave a half-cloned checkout; the loser's rename fails and it reuses the winner's.
  const tmpClone = `${repoDir}.tmp.${process.pid}`;
  console.error(`clone: ${slug} → ${repoDir} (blobless)`);
  execFileSync(
    'git',
    ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${slug}.git`, tmpClone],
    {
      stdio: 'inherit',
    },
  );
  try {
    renameSync(tmpClone, repoDir);
  } catch {
    rmSync(tmpClone, { recursive: true, force: true });
    if (!existsSync(path.join(repoDir, '.git')))
      throw new Error(`clone: ${repoDir} missing after a concurrent clone`);
  }
}

// ── per-PR metadata + diff ───────────────────────────────────────────────────────────────────────
interface PrMeta {
  number: number;
  base: string;
  head: string;
  created_at: string;
  merged_at: string | null;
  changed_files: number;
}
ensureDir(path.join(RESEARCH, 'prs', REPO));
const devkitRoot = path.resolve(import.meta.dirname, '../../../../..');
const runsDir = path.join(RESEARCH, 'runs', REPO);
ensureDir(runsDir);
const ckpt = openLensCheckpoint(path.join(runsDir, 'checkpoint.jsonl'));
if (ckpt.tornLines > 0)
  console.error(`checkpoint: skipped ${ckpt.tornLines} torn line(s) — those tasks re-run`);

const runs: PrRun[] = [];
let plannedUsd = 0;
let plannedTasks = 0;
for (const g of selected) {
  const n = prNumber(g.url);
  // SAFETY: the cached file is the --jq projection below, exactly PrMeta's fields.
  const meta = JSON.parse(
    cached(path.join(RESEARCH, 'prs', REPO, `${n}.json`), () =>
      gh([
        'api',
        `repos/${slug}/pulls/${n}`,
        '--jq',
        '{number,base:.base.sha,head:.head.sha,created_at,merged_at,changed_files}',
      ]),
    ),
  ) as PrMeta;
  const diffText = cached(path.join(RESEARCH, 'prs', REPO, `${n}.diff`), () =>
    gh(['api', '-H', 'Accept: application/vnd.github.diff', `repos/${slug}/pulls/${n}`]),
  );
  const diffSha = createHash('sha256').update(diffText).digest('hex');
  // GitHub's PR diff is head vs the MERGE BASE, not vs base.sha (the base branch may have moved);
  // materialize() walks ancestors from the ref it is given, so hand it the merge base first.
  for (const sha of [meta.base, meta.head])
    try {
      git(repoDir, ['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      git(repoDir, ['fetch', '--quiet', 'origin', sha]);
    }
  let start = meta.base;
  try {
    start = git(repoDir, ['merge-base', meta.base, meta.head]).trim() || meta.base;
  } catch {
    // no common ancestor reachable — fall back to base.sha and let materialize walk from there
  }
  const { wt, base } = materialize({
    repo: repoDir,
    branch: start,
    diffSha,
    attemptTs: meta.created_at,
    diffText,
    researchRoot: path.join(RESEARCH, 'worktrees'),
    reviewAssetsRoot: devkitRoot,
  });
  syncReviewAssets(devkitRoot, wt);

  // In-process review config: language-scoped include, no file written into the worktree.
  const cfg = resolveGuardConfigJson(
    JSON.stringify({
      review: {
        paths: {
          include: ['**/*.ts', '**/*.tsx'],
          exclude: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
        },
      },
    }),
    wt,
  );
  const staged = stagedFiles(wt);
  const sel = selectReviewers(staged, cfg).find((s) => s.reviewer.name === 'correctness-reviewer');
  if (!sel || sel.files.length === 0)
    throw new Error(
      `PR #${n}: correctness-reviewer selected ${sel?.files.length ?? 0} of ${staged.length} staged files — refusing to run (a zero-file run would read as a total miss)`,
    );
  const identity = runIdentity({ base, wt, issueCap: ISSUE_CAP });
  const keyPrefix = `${MODEL}|martian:${REPO}#${n}|${diffSha.slice(0, 12)}`;
  const tasks = ARMS.flatMap((arm) => planLensTasks({ arm, sel, diffText, keyPrefix }));
  const evidence = measureDiffEvidenceCap(diffText);
  const pending = tasks.filter((t) => !ckpt.reusable(t.key, identity));
  plannedTasks += pending.length;
  plannedUsd += estimateUsd(pending);
  console.error(
    `PR #${n}: base ${base.slice(0, 12)} · ${staged.length} staged / ${sel.files.length} in scope · evidence ${(evidence.evidence_bytes_shown / 1024).toFixed(1)}KB omitted ${evidence.omitted_files} truncated ${evidence.truncated_files} · ${tasks.length} task(s), ${pending.length} to run`,
  );
  for (const t of tasks)
    console.error(
      `  ${t.arm} chunk=${t.chunk} ${lensGroupId(t.group)} files=${t.files.length} evid=${(t.evidenceBytes / 1024).toFixed(1)}KB${ckpt.reusable(t.key, identity) ? ' (checkpointed)' : ''}`,
    );
  runs.push({
    pr: n,
    url: g.url,
    slug,
    diffSha,
    base,
    mergedAt: meta.merged_at,
    scopeFiles: sel.files,
    staged,
    evidence,
    tasks,
    identity,
    wt,
    sel,
    cfg,
  });
}
console.error(
  `plan: ${plannedTasks} judge task(s) to run, est ~$${plannedUsd.toFixed(0)} at $0.55+$0.03/KB (model ${MODEL})`,
);
if (DRY) {
  console.error('dry-run: no judges executed.');
  process.exit(0);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
for (const r of runs) {
  for (const arm of ARMS) {
    const rows = await runLensWave({
      tasks: r.tasks.filter((t) => t.arm === arm),
      sel: r.sel,
      wt: r.wt,
      cfg: r.cfg,
      model: MODEL,
      issueCap: ISSUE_CAP,
      identity: r.identity,
      diffSha: r.diffSha,
      ckpt,
      concurrency: CONCURRENCY,
    });
    const terminal = rows.filter(isTerminal);
    console.error(
      `PR #${r.pr} ${arm}: ${terminal.length}/${rows.length} terminal · issues ${terminal.reduce((n, x) => n + x.issues.length, 0)} · wall ${(rows.reduce((a, x) => a + x.ms, 0) / 1000) | 0}s (sum)`,
    );
  }
}

// ── export ───────────────────────────────────────────────────────────────────────────────────────
const fragment = exportFragment({
  goldens: selected,
  runs: runs.map((r) => ({
    ...r,
    rows: r.tasks
      .map((t) => ckpt.done.get(t.key))
      .filter((x) => x !== undefined && x.identity === r.identity),
  })),
  tool: 'devkit-correctness',
  goldenSourceFile: `${REPO}.json`,
  model: MODEL,
});
const fragmentPath = path.join(runsDir, `benchmark_data.fragment.${MODEL}.json`);
writeFileSync(fragmentPath, `${JSON.stringify(fragment.benchmarkData, null, 2)}\n`, {
  mode: 0o600,
});
const contextPath = path.join(runsDir, `review-context.${MODEL}.json`);
writeFileSync(contextPath, `${JSON.stringify(fragment.contexts, null, 2)}\n`, { mode: 0o600 });
console.error(`fragment → ${fragmentPath}\ncontexts → ${contextPath}`);
console.error(
  [
    '',
    'Next (Martian judge, their pipeline — needs MARTIAN_API_KEY / MARTIAN_BASE_URL in offline/.env):',
    `  git clone https://github.com/withmartian/code-review-benchmark ${path.join(RESEARCH, 'upstream')}  # record the sha`,
    `  cd ${path.join(RESEARCH, 'upstream', 'offline')} && uv sync`,
    `  bun ${path.join(import.meta.dirname, 'martian-merge.mts')} --fragment ${fragmentPath} --into results/benchmark_data.json`,
    `  MARTIAN_MODEL=anthropic/claude-opus-4-5-20251101 uv run python -m code_review_benchmark.step2_extract_comments --tool devkit-correctness`,
    `  MARTIAN_MODEL=anthropic/claude-opus-4-5-20251101 uv run python -m code_review_benchmark.step2_5_dedup_candidates --tool devkit-correctness`,
    `  MARTIAN_MODEL=anthropic/claude-opus-4-5-20251101 uv run python -m code_review_benchmark.step3_judge_comments --tool devkit-correctness --dedup-groups results/anthropic_claude-opus-4-5-20251101/dedup_groups.json`,
    `  bun ${path.join(import.meta.dirname, 'martian-report.mts')} --repo ${REPO} --model ${MODEL} --evaluations results/anthropic_claude-opus-4-5-20251101/evaluations.json`,
  ].join('\n'),
);
