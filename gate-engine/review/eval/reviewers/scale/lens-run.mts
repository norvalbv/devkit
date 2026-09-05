/** The reusable half of scale-bench (assets, task planning, checkpoint, bounded run loop) so an
 * external-PR bench drives the identical loop without the telemetry-DB coupling. Bench-only. */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readPrivateFile } from '../../../../critique/immutable-file.mts';
import { researchOutputDirectory, reviewAssetProjections } from './materialize.mts';
import { execJudgeAsync } from '../../../../judge/run-judge.mts';
import { readTranscript } from '../../../../judge/transcript-store.mts';
import type { GuardConfig } from '../../../../config.mts';
import { runCascade } from '../../../cascade/reviewer.mts';
import { reviewCaptureItemSchema } from '../../../evidence/items.mts';
import { identityBytesByPath, packDiffIntoChunks } from '../../../lens/chunk.mts';
import { deriveLensReviewer, lensGroupId, resolveLensGroups } from '../../../lens/split.mts';
import type { ChecklistReviewer, ReviewerSelection } from '../../../reviewers.mts';
import {
  gateJudgeEnv,
  withStagedFiles,
  type ReviewCapture,
  type ReviewOutcome,
} from '../../../runtime.mts';

// ── checkpoint ───────────────────────────────────────────────────────────────────────────────────
export interface LensTaskScope {
  lenses: string[];
  files: string[];
}
export interface ParentReplay {
  id: string;
  expectedTaskKeys: string[];
}
export interface CheckpointRow {
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
  /** sha256-12 of {base, assetsSha, issueCap}. Absent on legacy rows (reusable only for whole-diff
   * tasks); present-but-mismatched rows are segregated and re-driven. */
  identity?: string;
  base?: string;
  capture?: ReviewCapture;
  scope?: LensTaskScope;
  parentReplay?: ParentReplay;
}

/** Only a real verdict is terminal: 'error'/'inconclusive' rows (a flaky judge, a killed run)
 * are re-driven on resume instead of silently scoring as a clean zero-issue pass. */
export function isTerminal(row: CheckpointRow | undefined): row is CheckpointRow {
  return row !== undefined && (row.status === 'pass' || row.status === 'fail');
}

export interface LensCheckpoint {
  done: Map<string, CheckpointRow>;
  /** Lines a kill tore mid-append; those tasks re-run, which is strictly safer than bricking
   * every future resume. */
  tornLines: number;
  checkpoint: (row: CheckpointRow) => void;
  /** A row is reusable when it's a real verdict AND either predates identity tracking (legacy)
   * or was judged under this exact run's identity. */
  reusable: (key: string, identity: string) => boolean;
}

export function openLensCheckpoint(ckptPath: string): LensCheckpoint {
  const directory = researchOutputDirectory(path.dirname(ckptPath));
  const filename = path.basename(ckptPath);
  const checkpointPath = path.join(directory, filename);
  const done = new Map<string, CheckpointRow>();
  let tornLines = 0;
  // A kill mid-append can leave the file without a trailing newline; the next append must not
  // glue its row onto that torn fragment (which would tear the NEW row too).
  let needsNewline = false;
  const existing = readPrivateFile(directory, filename);
  if (existing !== null) {
    const raw = existing.toString('utf8');
    needsNewline = raw.length > 0 && !raw.endsWith('\n');
    for (const line of raw.trim().split('\n'))
      if (line.trim()) {
        try {
          // SAFETY: the checkpoint is append-only and written exclusively by checkpoint() below.
          const row = JSON.parse(line) as CheckpointRow;
          done.set(row.key, row);
        } catch {
          tornLines += 1;
        }
      }
  }
  return {
    done,
    tornLines,
    checkpoint: (row) => {
      if (researchOutputDirectory(directory) !== directory)
        throw new Error('private research output directory changed');
      const descriptor = openSync(
        checkpointPath,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        if (!fstatSync(descriptor).isFile()) throw new Error('checkpoint must be a regular file');
        appendFileSync(descriptor, `${needsNewline ? '\n' : ''}${JSON.stringify(row)}\n`);
      } finally {
        closeSync(descriptor);
      }
      needsNewline = false;
      done.set(row.key, row);
    },
    reusable: (key, identity) => {
      const row = done.get(key);
      return isTerminal(row) && (row.identity === undefined || row.identity === identity);
    },
  };
}

// ── projected assets ─────────────────────────────────────────────────────────────────────────────
/** Project the staged brief + skills into the worktree. Mandatory: agentBody reads
 * `<wt>/.claude/agents/<name>.md` and the judge's Bash prefix is the checklist script. */
export function syncReviewAssets(devkitRoot: string, wt: string): void {
  const root = path.resolve(wt);
  const projections = reviewAssetProjections(devkitRoot, root);
  for (const { source, destination, recursive } of projections) {
    const stat = lstatSync(source);
    if (recursive ? !stat.isDirectory() : !stat.isFile())
      throw new Error('review asset source must be a regular file or directory');
    for (
      let ancestor = path.dirname(destination);
      ancestor !== root;
      ancestor = path.dirname(ancestor)
    ) {
      const ancestorStat = lstatSync(ancestor, { throwIfNoEntry: false });
      if (ancestorStat && !ancestorStat.isDirectory())
        throw new Error('review asset projection ancestor must be a real directory');
    }
  }
  for (const { source, destination, recursive } of projections) {
    rmSync(destination, { recursive, force: true });
    cpSync(source, destination, { recursive });
  }
}

/** Hash EVERY projected review asset — the brief AND both skills dirs — since all of them shape
 * the judge's behavior; a brief-only hash let a skills edit reuse stale verdicts. */
export function projectedAssetsSha(root: string): string {
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

/** A verdict is reusable only under the SAME condition it was judged under: base commit, projected
 * assets, and the issue-disclosure cap. */
export function runIdentity(o: { base: string; wt: string; issueCap: string }): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ base: o.base, assetsSha: projectedAssetsSha(o.wt), issueCap: o.issueCap }),
    )
    .digest('hex')
    .slice(0, 12);
}

// ── task planning ────────────────────────────────────────────────────────────────────────────────
export interface LensTask {
  key: string;
  arm: string;
  chunk: number;
  group: readonly string[];
  files: string[];
  evidenceBytes: number;
}

/** One task per (chunk, lens group). `keyPrefix` is the caller's identity prefix; chunk tasks key on
 * FILE MEMBERSHIP (packing can re-home files), whole-diff tasks on -1; writer-reader stays whole. */
export function planLensTasks(o: {
  arm: string;
  sel: ReviewerSelection;
  diffText: string;
  keyPrefix: string;
}): LensTask[] {
  const groups = resolveLensGroups();
  if (!groups)
    throw new Error(
      'lens split is off (GUARD_CORRECTNESS_SPLIT) — the probe mirrors production with it on',
    );
  const bytes = identityBytesByPath(o.diffText);
  const sum = (files: string[]): number => files.reduce((a, f) => a + (bytes.get(f) ?? 0), 0);
  // Singleton lens groups only (the shipped 4-lens split): a merged group would drag sibling
  // lenses out of the chunk arms, so refuse it.
  if (groups.some((g) => g.length !== 1))
    throw new Error(
      `lens-run requires singleton lens groups (standard 4-lens split); got ${JSON.stringify(groups)}`,
    );
  const isCross = (g: readonly string[]): boolean => g[0] === 'writer-reader-contracts';
  const filesSha = (files: string[]): string =>
    createHash('sha256').update(files.join('\0')).digest('hex').slice(0, 12);
  const mk = (chunk: number, group: readonly string[], files: string[]): LensTask => ({
    key: `${o.keyPrefix}|${o.arm}|${chunk}${chunk >= 0 ? `:${filesSha(files)}` : ''}|${lensGroupId(group)}`,
    arm: o.arm,
    chunk,
    group,
    files,
    evidenceBytes: Math.min(sum(files), 60_000),
  });
  if (o.arm === 'whole') return groups.map((g) => mk(-1, g, o.sel.files));
  const m = o.arm.match(/^chunk:(\d+)$/);
  if (!m) throw new Error(`unknown arm ${o.arm}`);
  const plan = packDiffIntoChunks(o.sel.files, o.diffText, Number(m[1]) * 40);
  const tasks: LensTask[] = [];
  plan.chunks.forEach((files, i) => {
    for (const g of groups) if (!isCross(g)) tasks.push(mk(i, g, files));
  });
  const cross = groups.find(isCross);
  if (cross) tasks.push(mk(-1, cross, o.sel.files));
  return tasks;
}

/** The same dollar anchor scale-bench prints before every run: $0.55 per judge task plus $0.03
 * per KB of evidence. Informational; a caller gates on it, the loop does not. */
export function estimateUsd(tasks: readonly LensTask[]): number {
  return tasks.reduce((acc, t) => acc + 0.55 + 0.03 * (t.evidenceBytes / 1024), 0);
}

// ── run loop ─────────────────────────────────────────────────────────────────────────────────────
export interface RunLensWaveOpts {
  tasks: readonly LensTask[];
  sel: ReviewerSelection;
  wt: string;
  cfg: GuardConfig;
  /** Bench-arm model override: the production pin (reviewer.model) would silently win inside
   * cascadeVerdict, so a non-default model replaces it. Bench-only; never production. */
  model: string;
  issueCap: string;
  identity: string;
  diffSha: string;
  base?: string;
  /** A fresh private output directory identifies one measurement; stable across checkpoint resume. */
  measurementNamespace?: string;
  ckpt: LensCheckpoint;
  log?: (line: string) => void;
  /** Max judges in flight within one chunk wave (default 2). Each judge is a full CLI process;
   * four at once was measured to crowd out the owner's machine. */
  concurrency?: number;
}

/** Legacy full/event/sidecar copies are inspectable, but never promoted to exact evidence. */
export function outcomeCapture(
  res: ReviewOutcome,
  readSidecar: (ref: string) => string | null = readTranscript,
): ReviewCapture {
  if (res.capture) return res.capture;
  const capture: ReviewCapture = {
    version: 1,
    provenance: 'missing-invalid',
    items: [],
    artifact: res.itemArtifact,
  };
  let items: unknown = res.itemsFull ?? res.items;
  if (!items && res.itemsRef) {
    try {
      const raw = readSidecar(res.itemsRef);
      items = raw ? JSON.parse(raw) : undefined;
    } catch {
      return capture;
    }
  }
  if (!Array.isArray(items)) return capture;
  let valid = true;
  for (const [itemIndex, it] of items.entries()) {
    const item = legacyCaptureItemSchema.safeParse(it);
    if (!item.success) {
      valid = false;
      continue;
    }
    capture.items.push({
      itemIndex: item.data.itemIndex ?? itemIndex,
      lens: item.data.lens,
      status: item.data.status,
      issues: item.data.issues ?? [],
      disposition: item.data.disposition,
    });
  }
  if (valid) capture.provenance = 'capped-fallback';
  return capture;
}

const legacyCaptureItemSchema = reviewCaptureItemSchema.extend({
  itemIndex: z.number().int().nonnegative().optional(),
  issues: z.array(z.string()).optional(),
  rationale: z.string().optional(),
});

function parentReplay(o: RunLensWaveOpts, arm: string): ParentReplay | undefined {
  if (!o.measurementNamespace) return undefined;
  const expectedTaskKeys = o.tasks
    .filter((t) => t.arm === arm)
    .map((t) => t.key)
    .sort();
  const id = createHash('sha256')
    .update(
      JSON.stringify({
        namespace: path.resolve(o.measurementNamespace),
        diff: o.diffSha,
        model: o.model,
        arm,
        identity: o.identity,
        expectedTaskKeys,
      }),
    )
    .digest('hex');
  return { id, expectedTaskKeys };
}

/** Drive every not-yet-checkpointed task of ONE arm: chunks sequentially, at most `concurrency`
 * lenses in flight. Each verdict checkpoints as it lands; returns every row of the arm. */
export async function runLensWave(
  o: RunLensWaveOpts,
  executeCascade: typeof runCascade = runCascade,
): Promise<CheckpointRow[]> {
  const log = o.log ?? ((line: string) => console.error(line));
  const chunksInOrder = [...new Set(o.tasks.map((t) => t.chunk))];
  const limit = Math.max(1, o.concurrency ?? 2);
  for (const chunk of chunksInOrder) {
    const wave = o.tasks.filter((t) => t.chunk === chunk && !o.ckpt.reusable(t.key, o.identity));
    let next = 0;
    const runOne = async (t: LensTask): Promise<void> => {
      let derived: ChecklistReviewer = deriveLensReviewer(
        // SAFETY: planReviewWork only emits selections for checklist reviewers; correctness is one.
        o.sel.reviewer as ChecklistReviewer,
        t.group,
      );
      if (o.model && o.model !== derived.model)
        // SAFETY: spread of a ChecklistReviewer with only its model overridden keeps the shape.
        derived = Object.freeze({ ...derived, model: o.model }) as ChecklistReviewer;
      const started = Date.now();
      const res = await executeCascade(
        { reviewer: derived, files: t.files },
        {
          cwd: o.wt,
          cfg: o.cfg,
          exec: execJudgeAsync,
          firstModel: o.model,
          // gateJudgeEnv carries DEVKIT_CHECKLIST_KEEP=1 (else a PASS voids to 'artifact missing',
          // sc-1438); the issue cap is pinned so a shell override cannot change the budget.
          judgeEnv: {
            ...withStagedFiles(gateJudgeEnv(false, o.cfg), derived, t.files),
            GUARD_REVIEW_MAX_ISSUES_PER_LENS: o.issueCap,
          },
          recovery: 'final',
          fullItems: true, // bank the full finding text (sc-2493: 525/531 banked texts were stubs)
        },
      );
      const capture = outcomeCapture(res);
      o.ckpt.checkpoint({
        key: t.key,
        diff: o.diffSha,
        model: o.model,
        arm: t.arm,
        chunk: t.chunk,
        group: lensGroupId(t.group),
        status: res.status,
        reason: (res.reason ?? '').slice(0, 400),
        issues: capture.items.flatMap((it) => it.issues.map((text) => ({ lens: it.lens, text }))),
        ms: Date.now() - started,
        at: new Date().toISOString(),
        identity: o.identity,
        base: o.base,
        capture,
        scope: { lenses: [...t.group], files: [...t.files] },
        parentReplay: parentReplay(o, t.arm),
      });
      log(`  done ${t.key} → ${res.status} (${((Date.now() - started) / 1000) | 0}s)`);
    };
    // Bounded pool: at most `limit` judges in flight, lenses still parallel within the bound.
    await Promise.all(
      Array.from({ length: Math.min(limit, wave.length) }, async () => {
        while (next < wave.length) {
          const t = wave[next];
          next += 1;
          await runOne(t);
        }
      }),
    );
  }
  return o.tasks.map((t) => o.ckpt.done.get(t.key)).filter((r): r is CheckpointRow => Boolean(r));
}
