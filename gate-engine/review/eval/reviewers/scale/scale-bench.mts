/**
 * Scale-track probe runner: one REAL archived ship diff, reviewed by the real cascade under two
 * arms — `whole` (today's shape: every lens over the whole diff) and `chunk:<loc>` (the packer in
 * lens/chunk.mts slices the diff; each slice gets the non-cross-file lenses; writer-reader-contracts
 * always judges the whole diff). Labels are telemetry-mined (labels.mts): issues later attempts
 * found in code this diff already staged.
 *
 * CHECKPOINTABLE: every judge outcome appends to <out>/checkpoint.jsonl keyed
 * (diff, arm, chunk, lensGroup); a re-run skips completed keys, so a usage-limit kill resumes free.
 * WRITES NOTHING to the repo, the telemetry sink, or any verdict store: gate-event env is cleared,
 * the target checkout is a throwaway git worktree, and results live under --out (local only).
 *
 * Usage:
 *   bun scale-bench.mts --diff <sha256> --repo <path> --branch <name> \
 *     --arms whole,chunk:1000 [--dry-run] [--out <dir>] [--model sonnet]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execJudgeAsync } from '../../../../judge/run-judge.mts';
import { readTranscript } from '../../../../judge/transcript-store.mts';
import { cleanMaterialized, materialize } from './materialize.mts';
import { resolveGuardConfig } from '../../../../config.mts';
import { runCascade } from '../../../cascade/reviewer.mts';
import { stagedFiles } from '../../../evidence/staged-git.mts';
import { identityBytesByPath, packDiffIntoChunks } from '../../../lens/chunk.mts';
import { deriveLensReviewer, lensGroupId, resolveLensGroups } from '../../../lens/split.mts';
import {
  type ChecklistReviewer,
  type ReviewerSelection,
  selectReviewers,
} from '../../../reviewers.mts';
import { gateJudgeEnv, withStagedFiles } from '../../../runtime.mts';
import {
  extractLocations,
  type IssueLocation,
  linesMatch,
  mineLabels,
  readArchivedDiff,
  resolveToStaged,
  type ScaleLabel,
} from './labels.mts';

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  // A flag with no value (end of argv, or the next token is another flag) must NOT silently
  // consume its neighbour or bypass the fallback.
  if (value === undefined || value.startsWith('--')) return fallback;
  return value;
}
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

// No telemetry, no ship identity, no verdict stores: this is a bench, not a gate run.
// Deleting DEVKIT_GATE_EVENTS alone only re-routes emitGateEvent to the DEFAULT sink —
// DEVKIT_NO_TELEMETRY=1 is what actually silences it (run-context.mts telemetrySink()).
process.env.DEVKIT_NO_TELEMETRY = '1';
delete process.env.DEVKIT_GATE_EVENTS;
delete process.env.DEVKIT_SHIP_ID;
delete process.env.DEVKIT_RUN_MODE;

// ── checkpoint ───────────────────────────────────────────────────────────────────────────────────
interface CheckpointRow {
  key: string;
  diff: string;
  /** Absent on historical sonnet rows (their keys carry no model prefix). */
  model?: string;
  arm: string;
  chunk: number;
  group: string;
  status: string;
  reason: string;
  issues: Array<{ lens: string; text: string }>;
  ms: number;
  at: string;
  /** sha256-12 of {base, briefSha, issueCap} — the execution condition this verdict was judged
   * under. Absent on rows written before identity tracking (legacy). Legacy reuse is safe only
   * where a task's file membership is structurally fixed: whole-diff tasks (chunk -1) keep their
   * old keys and load; chunk tasks now key on membership (see planTasks), so a legacy chunk row's
   * bare-index key never matches and is re-driven — its membership under the current packer is
   * unknowable. Present but MISMATCHED means the materialized base, projected reviewer brief, or
   * issue cap changed since this row was written; the row is then segregated (not reused) and its
   * task is re-driven. */
  identity?: string;
}
mkdirSync(OUT, { recursive: true });
const CKPT = path.join(OUT, 'checkpoint.jsonl');
/** Only a real verdict is terminal: 'error'/'inconclusive' rows (a flaky judge, a killed run)
 * are re-driven on resume instead of silently scoring as a clean zero-issue pass. A type guard so
 * callers narrow away the `| undefined` instead of asserting it. */
function isTerminal(row: CheckpointRow | undefined): row is CheckpointRow {
  return row !== undefined && (row.status === 'pass' || row.status === 'fail');
}

const done = new Map<string, CheckpointRow>();
let tornLines = 0;
if (existsSync(CKPT))
  for (const line of readFileSync(CKPT, 'utf8').trim().split('\n'))
    if (line.trim()) {
      try {
        // SAFETY: checkpoint.jsonl is append-only and written exclusively by checkpoint() below with CheckpointRow rows.
        const row = JSON.parse(line) as CheckpointRow;
        done.set(row.key, row);
      } catch {
        // A kill mid-append tears at most the trailing line; skipping it re-drives that task,
        // which is strictly safer than bricking every future resume.
        tornLines += 1;
      }
    }
if (tornLines > 0)
  console.error(`checkpoint: skipped ${tornLines} torn line(s) — those tasks re-run`);
const checkpoint = (row: CheckpointRow): void => {
  appendFileSync(CKPT, `${JSON.stringify(row)}\n`);
  done.set(row.key, row);
};

// ── materialize the diff onto its base commit in a throwaway worktree ───────────────────────────
/** Accept a local branch, a remote branch, or a PR head — telemetry branch names are local-first. */

/** The probe judges TOMORROW's engine: project the staged brief + skills over the consumer copies. */
function syncReviewAssets(devkitRoot: string, wt: string): void {
  cpSync(
    path.join(devkitRoot, 'agents', 'correctness-reviewer.md'),
    path.join(wt, '.claude', 'agents', 'correctness-reviewer.md'),
  );
  cpSync(
    path.join(devkitRoot, 'skills', 'correctness'),
    path.join(wt, '.claude', 'skills', 'correctness'),
    { recursive: true },
  );
  cpSync(
    path.join(devkitRoot, 'skills', '_devkit'),
    path.join(wt, '.claude', 'skills', '_devkit'),
    { recursive: true },
  );
}

// ── task planning ────────────────────────────────────────────────────────────────────────────────
interface Task {
  key: string;
  arm: string;
  chunk: number;
  group: readonly string[];
  files: string[];
  evidenceBytes: number;
}
function planTasks(arm: string, sel: ReviewerSelection, diffText: string): Task[] {
  const groups = resolveLensGroups();
  if (!groups)
    throw new Error(
      'lens split is off (GUARD_CORRECTNESS_SPLIT) — the probe mirrors production with it on',
    );
  const bytes = identityBytesByPath(diffText);
  const sum = (files: string[]): number => files.reduce((a, f) => a + (bytes.get(f) ?? 0), 0);
  // The pre-registered shape needs singleton lens groups (the shipped 4-lens split): only the
  // writer-reader-contracts LENS stays whole-diff. A config that merges it into a wider group
  // would silently drag sibling lenses out of the chunk arms, so refuse it instead.
  if (groups.some((g) => g.length !== 1))
    throw new Error(
      `scale-bench requires singleton lens groups (standard 4-lens split); got ${JSON.stringify(groups)}`,
    );
  const isCross = (g: readonly string[]): boolean => g[0] === 'writer-reader-contracts';
  // A chunk task's key carries its FILE MEMBERSHIP, not just its index: chunk composition is a
  // product of the packing algorithm, so a packing change (e.g. the quoted/spaced-path byte-lookup
  // fix) can re-home files across indexes for the identical (files, diff) input. Keying on
  // membership makes such a row MISS and re-drive instead of attributing a verdict judged against
  // different files — including legacy (pre-identity) rows, whose bare-index keys can never match.
  // Whole-diff tasks (chunk -1) omit it: their membership is the full staged set, independent of
  // packing, which keeps legacy whole/cross rows loadable.
  const filesSha = (files: string[]): string =>
    createHash('sha256').update(files.join('\0')).digest('hex').slice(0, 12);
  const mk = (chunk: number, group: readonly string[], files: string[]): Task => ({
    key: `${MODEL === 'sonnet' ? '' : `${MODEL}|`}${DIFF_SHA}|${arm}|${chunk}${chunk >= 0 ? `:${filesSha(files)}` : ''}|${lensGroupId(group)}`,
    arm,
    chunk,
    group,
    files,
    evidenceBytes: Math.min(sum(files), 60_000),
  });
  if (arm === 'whole') return groups.map((g) => mk(-1, g, sel.files));
  const m = arm.match(/^chunk:(\d+)$/);
  if (!m) throw new Error(`unknown arm ${arm}`);
  const plan = packDiffIntoChunks(sel.files, diffText, Number(m[1]) * 40);
  const tasks: Task[] = [];
  plan.chunks.forEach((files, i) => {
    for (const g of groups) if (!isCross(g)) tasks.push(mk(i, g, files));
  });
  const cross = groups.find(isCross);
  if (cross) tasks.push(mk(-1, cross, sel.files));
  return tasks;
}

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
// A checkpointed verdict is only reusable under the SAME review condition it was judged under.
// `base` (which commit the diff materialized onto), the projected correctness-reviewer.md brief,
// and the issue-disclosure cap all change what a judge sees or is allowed to say — reusing a row
// from a different combination of these would silently record a stale verdict as part of this run.
/** Hash EVERY projected review asset — the brief AND both skills dirs — since all of them shape
 * the judge's behavior; a brief-only hash let a skills edit reuse stale verdicts. */
function projectedAssetsSha(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        hash.update(full.slice(root.length));
        hash.update(readFileSync(full));
      }
    }
  };
  hash.update(readFileSync(path.join(root, '.claude', 'agents', 'correctness-reviewer.md')));
  for (const dir of ['correctness', '_devkit']) {
    const skills = path.join(root, '.claude', 'skills', dir);
    if (existsSync(skills)) walk(skills);
  }
  return hash.digest('hex').slice(0, 12);
}
const RUN_IDENTITY = createHash('sha256')
  .update(JSON.stringify({ base, assetsSha: projectedAssetsSha(wt), issueCap: ISSUE_CAP }))
  .digest('hex')
  .slice(0, 12);
/** A row is reusable when it's a real verdict AND either predates identity tracking (legacy —
 * the checkpoint key format is unchanged, so these must keep loading) or was judged under this
 * exact run's identity. Anything else — status not terminal, or a MISMATCHED identity — is
 * treated as not-done and re-driven. */
function reusable(row: CheckpointRow | undefined): boolean {
  return isTerminal(row) && (row.identity === undefined || row.identity === RUN_IDENTITY);
}

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

const allTasks = ARMS.flatMap((a) => planTasks(a, sel, diffText));
const estUsd = allTasks.reduce((acc, t) => acc + 0.55 + 0.03 * (t.evidenceBytes / 1024), 0);
console.error(
  `plan: ${allTasks.length} judge task(s) across arms [${ARMS.join(', ')}], est ~$${estUsd.toFixed(0)} at $0.55+$0.03/KB`,
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
    `  ${t.arm} chunk=${t.chunk} ${lensGroupId(t.group)} files=${t.files.length} evid=${(t.evidenceBytes / 1024).toFixed(1)}KB ${reusable(done.get(t.key)) ? '(checkpointed)' : ''}`,
  );
if (DRY) {
  console.error('dry-run: no judges executed.');
  process.exit(0);
}

const results: CheckpointRow[] = [];
for (const arm of ARMS) {
  const tasks = allTasks.filter((t) => t.arm === arm);
  const chunksInOrder = [...new Set(tasks.map((t) => t.chunk))];
  for (const chunk of chunksInOrder) {
    const wave = tasks.filter((t) => t.chunk === chunk && !reusable(done.get(t.key)));
    // Same-lens state files collide across chunks; chunks run sequentially, lenses within a chunk in parallel.
    await Promise.all(
      wave.map(async (t) => {
        let derived: ChecklistReviewer = deriveLensReviewer(
          // SAFETY: planReviewWork only emits selections for checklist reviewers; correctness is one.
          sel.reviewer as ChecklistReviewer,
          t.group,
        );
        // Bench-arm model override: the production pin (reviewer.model) would silently win inside
        // cascadeVerdict, so a non-default --model replaces it here. Bench-only; never production.
        if (MODEL && MODEL !== derived.model)
          // SAFETY: spread of a ChecklistReviewer with only its model overridden keeps the shape.
          derived = Object.freeze({ ...derived, model: MODEL }) as ChecklistReviewer;
        const started = Date.now();
        const res = await runCascade(
          { reviewer: derived, files: t.files },
          {
            cwd: wt,
            cfg,
            exec: execJudgeAsync,
            firstModel: MODEL,
            // gateJudgeEnv carries DEVKIT_CHECKLIST_KEEP=1 — without it a finishing judge deletes
            // its own artifact and every PASS voids to 'checklist artifact missing' (sc-1438).
            // The issue-slot budget is pinned so an inherited shell override cannot silently
            // change the disclosure cap the pre-registration fixes at 3.
            judgeEnv: {
              ...withStagedFiles(gateJudgeEnv(false, cfg), derived, t.files),
              GUARD_REVIEW_MAX_ISSUES_PER_LENS: ISSUE_CAP,
            },
            recovery: 'final',
          },
        );
        // items spills to an itemsRef sidecar past the event byte budget — a verbose FAIL must
        // not checkpoint as issues:[] (that would score as a clean miss).
        let items = res.items;
        if (!items && res.itemsRef) {
          try {
            const raw = readTranscript(res.itemsRef);
            // SAFETY: the sidecar is written by attachItems as JSON.stringify of the capped items.
            items = raw ? (JSON.parse(raw) as NonNullable<typeof res.items>) : undefined;
          } catch {
            items = undefined;
          }
        }
        checkpoint({
          key: t.key,
          diff: DIFF_SHA!,
          model: MODEL,
          arm: t.arm,
          chunk: t.chunk,
          group: lensGroupId(t.group),
          status: res.status,
          reason: (res.reason ?? '').slice(0, 400),
          issues: (items ?? []).flatMap((it) =>
            (it.issues ?? []).map((text) => ({ lens: it.lens, text: String(text).slice(0, 300) })),
          ),
          ms: Date.now() - started,
          at: new Date().toISOString(),
          identity: RUN_IDENTITY,
        });
        console.error(`  done ${t.key} → ${res.status} (${((Date.now() - started) / 1000) | 0}s)`);
      }),
    );
  }
  const armRows = tasks.map((t) => done.get(t.key)).filter((r): r is CheckpointRow => Boolean(r));
  results.push(...armRows);
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
