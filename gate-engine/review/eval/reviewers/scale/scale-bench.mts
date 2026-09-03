/** Scale-track probe: one archived ship diff, real cascade, `whole` vs `chunk:<loc>` arms, labels
 * telemetry-mined. Checkpointed under --out; writes nothing to the repo or telemetry. Loop: lens-run.mts. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanMaterialized, materialize } from './materialize.mts';
import { resolveGuardConfig } from '../../../../config.mts';
import { stagedFiles } from '../../../evidence/staged-git.mts';
import { lensGroupId } from '../../../lens/split.mts';
import { selectReviewers } from '../../../reviewers.mts';
import {
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

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
const DIFF_SHA = arg('diff');
const REPO = arg('repo');
const BRANCH = arg('branch');
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
  // Materialized third-party worktrees are full checkouts nothing reaps — explicit cleanup mode.
  cleanMaterialized();
  process.exit(0);
}
const DB = path.join(os.homedir(), '.claude-usage', 'usage.db');
assertMergedParentRows(DB);
// Pinned so an inherited shell override cannot silently change the disclosure cap the
// pre-registration fixes at 3; also folded into the checkpoint execution identity below, since a
// different cap changes what a judge is allowed to disclose.
const ISSUE_CAP = '3';
if (!DIFF_SHA || !REPO || !BRANCH) {
  console.error(
    'usage: scale-bench --diff <sha256> --repo <path> --branch <name> [--arms whole,chunk:1000] [--dry-run]',
  );
  process.exit(2);
}

silenceBenchTelemetry();

// ── checkpoint ───────────────────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const ckpt = openLensCheckpoint(path.join(OUT, 'checkpoint.jsonl'));
if (ckpt.tornLines > 0)
  console.error(`checkpoint: skipped ${ckpt.tornLines} torn line(s) — those tasks re-run`);
const { done } = ckpt;

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
  process.exit(0);
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
    ckpt,
  });
  // Only real verdicts are scoreable: an error/inconclusive row has no artifact, and "no
  // artifact is not the same fact as an artifact with zero failures" (ReviewOutcome.items
  // contract) — counting it as a clean pass would silently deflate the arm's recall.
  const scored = armRows.filter((r) => isTerminal(r));
  const unresolved = armRows.length - scored.length;
  const s = score(labels, scored, staged);
  console.error(
    `ARM ${arm}: tierA ${s.hitsA}/${s.nA} · tierB ${s.hitsB}/${s.nB} · predicted issues ${s.predicted} · judge tasks ${scored.length}${unresolved > 0 ? ` (+${unresolved} error/inconclusive EXCLUDED from scoring — re-run to re-drive)` : ''} · wall ${(armRows.reduce((a, r) => a + r.ms, 0) / 1000) | 0}s (sum)`,
  );
}
// Persist EVERY checkpointed row for this diff, not only this invocation's arms — a later
// single-arm run must not clobber earlier arms' rows out of the results file. Rows carry their
// model (absent = historical sonnet) so consumers can separate experimental conditions. The
// write is tmp+rename so a kill mid-write cannot tear the file for every later reader.
// A legacy (pre-identity) row is admissible only when its task shape is membership-FIXED — the
// whole-diff tasks keyed with chunk -1 (`whole` arms and every arm's cross-file lens). A legacy
// bare-index chunk row's file membership under the current packer is unknowable (see
// CheckpointRow.identity): its task re-drives under a membership-keyed key, and admitting the
// orphaned row here would merge the membership-unknown verdict BESIDE its re-driven replacement.
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
const resultsPath = path.join(OUT, `results-${DIFF_SHA!.slice(0, 12)}.json`);
const resultsTmp = `${resultsPath}.tmp.${process.pid}`;
writeFileSync(
  resultsTmp,
  JSON.stringify(
    { diff: DIFF_SHA, base, arms: ARMS, model: MODEL, labels, rows: allRows },
    null,
    2,
  ),
);
renameSync(resultsTmp, resultsPath);
console.error(`results → ${path.join(OUT, `results-${DIFF_SHA!.slice(0, 12)}.json`)}`);
