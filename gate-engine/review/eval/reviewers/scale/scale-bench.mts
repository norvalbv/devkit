/** Scale-track probe: one archived ship diff, real cascade, `whole` vs `chunk:<loc>` arms, labels
 * telemetry-mined. Checkpointed under --out; writes nothing to the repo or telemetry. Loop: lens-run.mts. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLockAsync } from '../../../../eval/publish-lock.mts';
import { cleanMaterialized, materialize, researchOutputDirectory } from './materialize.mts';
import { resolveGuardConfig } from '../../../../config.mts';
import { stagedFiles } from '../../../evidence/staged-git.mts';
import { lensGroupId } from '../../../lens/split.mts';
import { selectReviewers } from '../../../reviewers.mts';
import {
  assertDiffSha256,
  extractLocations,
  type IssueLocation,
  linesMatch,
  mineLabels,
  readArchivedDiff,
  resolveToStaged,
  type ScaleLabel,
} from './labels.mts';
import {
  type CheckpointRow,
  estimateUsd,
  isTerminal,
  openLensCheckpoint,
  planLensTasks,
  runIdentity,
  runLensWave,
  syncReviewAssets,
} from './lens-run.mts';
import { assertMergedParentRows } from '../warehouse-guards.mts';
import { arg, silenceBenchTelemetry } from './bench-args.mts';

// ── scoring ──────────────────────────────────────────────────────────────────────────────────────
interface ArmScore {
  hitsA: number;
  nA: number;
  hitsB: number;
  nB: number;
  predicted: number;
}

function score(
  labels: ScaleLabel[],
  rows: CheckpointRow[],
  stagedPaths: readonly string[],
): ArmScore {
  const preds: IssueLocation[] = [];
  for (const row of rows)
    for (const issue of row.issues)
      for (const loc of extractLocations(issue.text)) {
        const resolved = resolveToStaged(loc.file, stagedPaths);
        if (resolved !== undefined) preds.push({ file: resolved, line: loc.line });
      }
  const hit = (l: ScaleLabel): boolean =>
    preds.some((p) => p.file === l.file && linesMatch(l.line, p.line));
  const a = labels.filter((l) => l.tier === 'A');
  const b = labels.filter((l) => l.tier === 'B');
  // `predicted` counts ISSUES (what the judges disclosed), not resolved locations — an issue
  // naming two files must not double against verify-extras' issue-level tallies.
  return {
    hitsA: a.filter(hit).length,
    nA: a.length,
    hitsB: b.filter(hit).length,
    nB: b.length,
    predicted: rows.reduce((n, row) => n + row.issues.length, 0),
  };
}

interface ScaleRunOptions {
  diffSha: string;
  repo: string;
  branch: string;
  arms: string[];
  model: string;
  outputDirectory: string;
  contextDirectory?: string;
  dryRun: boolean;
}

/** The output bank owns checkpoint reads, context work, all awaits, and final publication. */
export async function runScaleBench(
  execute: (options: ScaleRunOptions) => Promise<void> = runScaleProbe,
): Promise<void> {
  const DIFF_SHA = arg('diff');
  if (DIFF_SHA !== undefined) assertDiffSha256(DIFF_SHA);
  const REPO = arg('repo');
  const BRANCH = arg('branch');
  const RESEARCH_ROOT = arg('research-root');
  if (
    process.argv.includes('--research-root') &&
    (!RESEARCH_ROOT || RESEARCH_ROOT.includes('\0') || RESEARCH_ROOT.length > 4096)
  )
    throw new Error('--research-root requires a nonempty path of at most 4096 characters');
  // SAFETY: arg() returns the fallback when the flag is absent, so a non-undefined fallback makes the result a string.
  const ARMS = (arg('arms', 'whole') as string).split(',').filter(Boolean);
  // SAFETY: same fallback contract as ARMS above — 'sonnet' guarantees a string.
  const MODEL = arg('model', 'sonnet') as string;
  const OUT = arg(
    'out',
    path.join(os.homedir(), '.devkit', 'research', '2026-08-22-ship-attempts', 'probe'),
  )!;
  const DRY = process.argv.includes('--dry-run');
  if (process.argv.includes('--clean')) {
    if (RESEARCH_ROOT !== undefined) {
      console.error('--clean cannot be combined with --research-root');
      process.exit(2);
    }
    // Materialized third-party worktrees are full checkouts nothing reaps — explicit cleanup mode.
    cleanMaterialized();
    process.exit(0);
  }

  const contextDirectory =
    RESEARCH_ROOT === undefined ? undefined : researchOutputDirectory(RESEARCH_ROOT);
  const outputDirectory = researchOutputDirectory(OUT);
  await withFileLockAsync(
    path.join(outputDirectory, '.scale-run.lock'),
    'scale output bank',
    async () => {
      if (!DIFF_SHA || !REPO || !BRANCH) {
        console.error(
          'usage: scale-bench --diff <sha256> --repo <path> --branch <name> [--arms whole,chunk:1000] [--research-root <private-context-dir>] [--dry-run]',
        );
        process.exit(2);
      }
      silenceBenchTelemetry();
      await execute({
        diffSha: DIFF_SHA,
        repo: REPO,
        branch: BRANCH,
        arms: ARMS,
        model: MODEL,
        outputDirectory,
        contextDirectory,
        dryRun: DRY,
      });
    },
    { createParent: false },
  );
}

async function runScaleProbe({
  diffSha: DIFF_SHA,
  repo: REPO,
  branch: BRANCH,
  arms: ARMS,
  model: MODEL,
  outputDirectory,
  contextDirectory,
  dryRun: DRY,
}: ScaleRunOptions): Promise<void> {
  const DB = path.join(os.homedir(), '.claude-usage', 'usage.db');
  assertMergedParentRows(DB);
  // Pinned rather than inherited, and included in checkpoint execution identity.
  const ISSUE_CAP = '3';
  // ── checkpoint ───────────────────────────────────────────────────────────────────────────────────
  const ckpt = openLensCheckpoint(path.join(outputDirectory, 'checkpoint.jsonl'));
  if (ckpt.tornLines > 0)
    console.error(`checkpoint: skipped ${ckpt.tornLines} torn line(s) — those tasks re-run`);
  const { done } = ckpt;

  // ── main ─────────────────────────────────────────────────────────────────────────────────────────
  const devkitRoot = path.resolve(import.meta.dirname, '../../../../..');
  const diffText = readArchivedDiff(DIFF_SHA!);
  if (!diffText) throw new Error(`no archived diff at ${DIFF_SHA}`);
  const attemptTs = execFileSync(
    'sqlite3',
    [
      '-readonly',
      DB,
      `select s.ts_start from commit_ships s join commit_review_scope sc using(ship_id) where sc.diff_sha256='${DIFF_SHA}' order by s.ts_start limit 1`,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!attemptTs) throw new Error('diff sha not found in commit_review_scope');

  const { wt, base } = materialize({
    repo: REPO!,
    branch: BRANCH!,
    diffSha: DIFF_SHA!,
    attemptTs,
    diffText,
    researchRoot: contextDirectory,
    reviewAssetsRoot: devkitRoot,
  });
  syncReviewAssets(devkitRoot, wt);

  // ── execution identity ───────────────────────────────────────────────────────────────────────────
  const RUN_IDENTITY = runIdentity({ base, wt, issueCap: ISSUE_CAP });
  const reusable = (key: string): boolean => ckpt.reusable(key, RUN_IDENTITY);

  const cfg = resolveGuardConfig(wt);
  const staged = stagedFiles(wt);
  const sel = selectReviewers(staged, cfg).find((s) => s.reviewer.name === 'correctness-reviewer');
  if (!sel)
    throw new Error('correctness-reviewer not selected for this diff under the target repo config');
  const labels = mineLabels({
    dbPath: DB,
    branch: BRANCH!,
    diffSha256: DIFF_SHA!,
    diffText,
    sinceTs: attemptTs,
  });
  console.error(
    `probe: diff ${DIFF_SHA!.slice(0, 12)} base ${base.slice(0, 12)} — ${staged.length} staged, ${sel.files.length} in correctness scope; labels tierA ${labels.filter((l) => l.tier === 'A').length} tierB ${labels.filter((l) => l.tier === 'B').length}`,
  );

  // Legacy key compatibility: historical sonnet rows carry no model prefix.
  const keyPrefix = `${MODEL === 'sonnet' ? '' : `${MODEL}|`}${DIFF_SHA}`;
  const allTasks = ARMS.flatMap((arm) => planLensTasks({ arm, sel, diffText, keyPrefix }));
  console.error(
    `plan: ${allTasks.length} judge task(s) across arms [${ARMS.join(', ')}], est ~$${estimateUsd(allTasks).toFixed(0)} at $0.55+$0.03/KB`,
  );
  const legacyReused = allTasks.filter((t) => {
    const row = done.get(t.key);
    return isTerminal(row) && row.identity === undefined;
  }).length;
  const segregated = allTasks.filter((t) => {
    const row = done.get(t.key);
    return isTerminal(row) && row.identity !== undefined && row.identity !== RUN_IDENTITY;
  }).length;
  if (legacyReused > 0)
    console.error(
      `checkpoint: reusing ${legacyReused} legacy row(s) with no recorded execution identity (pre-dates identity tracking)`,
    );
  if (segregated > 0)
    console.error(
      `checkpoint: segregated ${segregated} row(s) whose execution identity no longer matches this run (base/brief/issue-cap changed) — re-driving`,
    );
  for (const t of allTasks)
    console.error(
      `  ${t.arm} chunk=${t.chunk} ${lensGroupId(t.group)} files=${t.files.length} evid=${(t.evidenceBytes / 1024).toFixed(1)}KB ${reusable(t.key) ? '(checkpointed)' : ''}`,
    );
  if (DRY) {
    console.error('dry-run: no judges executed.');
    return;
  }

  for (const arm of ARMS) {
    const tasks = allTasks.filter((t) => t.arm === arm);
    const armRows = await runLensWave({
      tasks,
      sel,
      wt,
      cfg,
      model: MODEL,
      issueCap: ISSUE_CAP,
      identity: RUN_IDENTITY,
      diffSha: DIFF_SHA!,
      base,
      measurementNamespace: outputDirectory,
      ckpt,
    });
    // Error/inconclusive attempts have unknown findings; scoring them as clean would distort recall.
    const scored = armRows.filter((r) => isTerminal(r));
    const unresolved = armRows.length - scored.length;
    const s = score(labels, scored, staged);
    console.error(
      `ARM ${arm} location proxy: tierA ${s.hitsA}/${s.nA} · tierB ${s.hitsB}/${s.nB} · predicted issues ${s.predicted} · judge tasks ${scored.length}${unresolved > 0 ? ` (+${unresolved} error/inconclusive EXCLUDED from scoring — re-run to re-drive)` : ''} · wall ${(armRows.reduce((a, r) => a + r.ms, 0) / 1000) | 0}s (sum)`,
    );
  }
  // Retain other arms' rows, but admit pre-identity rows only for fixed whole-diff membership.
  // Legacy chunk indices cannot identify files reliably and must not accompany their replacements.
  const legacyAdmissible = (r: CheckpointRow): boolean =>
    r.identity === undefined && r.key.includes('|-1|');
  const admissible = (r: CheckpointRow): boolean =>
    r.diff === DIFF_SHA && (r.identity === RUN_IDENTITY || legacyAdmissible(r));
  const staleRows = [...done.values()].filter((r) => r.diff === DIFF_SHA && !admissible(r));
  if (staleRows.length > 0)
    console.error(
      `results: segregating ${staleRows.length} row(s) judged under a DIFFERENT execution identity or under pre-identity chunk keys (any arm) — they do not enter results-*.json; re-run their arms to refresh them`,
    );
  const allRows = [...done.values()].filter(admissible);
  researchOutputDirectory(outputDirectory);
  const resultsPath = path.join(outputDirectory, `results-${DIFF_SHA!.slice(0, 12)}.json`);
  const resultsTmp = `${resultsPath}.tmp.${randomUUID()}`;
  writeFileSync(
    resultsTmp,
    JSON.stringify(
      { diff: DIFF_SHA, base, arms: ARMS, model: MODEL, labels, rows: allRows },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  researchOutputDirectory(outputDirectory);
  renameSync(resultsTmp, resultsPath);
  console.error(
    `results → ${path.join(outputDirectory, `results-${DIFF_SHA!.slice(0, 12)}.json`)}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runScaleBench();
}
