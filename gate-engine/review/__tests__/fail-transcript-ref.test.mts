import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIFF_HEADER, OUTPUT_HEADER, readTranscript } from '../../judge/transcript-store.mts';
import { loadCache } from '../cache.mts';
import { resetReviewBaseContext } from '../evidence/base-context.mts';
import type { ChunkAssignment } from '../lens/chunk.mts';
import { emitMergedLensResults } from '../lens/merge-results.mts';
import {
  deriveLensReviewer,
  FOUR_WAY_LENS_GROUPS,
  type LensPart,
  planReviewWork,
  type ReviewTask,
} from '../lens/split.mts';
import { settleReviewOutcome, type SettleCtx } from '../recovery/settle.mts';
import { hasChecklist, REVIEWERS } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { ReviewGateTiming } from '../telemetry/timing.mts';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+let shared = 0;\n';
const guard = REVIEWERS.find((r) => r.name === 'commit-guard');
const correctness = REVIEWERS.find((r) => r.name === 'correctness-reviewer');
if (!guard || !correctness || !hasChecklist(correctness))
  throw new Error('fixture: commit-guard and correctness-reviewer must exist');
const keyOf = (name: string, diff: string, salt: string) => `${name}|${diff}|${salt}`;
const guardTask = (cwd: string): ReviewTask =>
  planReviewWork(
    [{ reviewer: guard, files: ['src/a.ts'] }],
    [DIFF],
    loadCache(cwd),
    new Map(),
    keyOf,
    null,
    null,
  ).tasks[0];

const outcome = (name: string, status: 'pass' | 'fail'): ReviewOutcome => ({
  name,
  status,
  reason: 'r',
  escalated: false,
  transcript: `VERDICT: ${status.toUpperCase()} — r`,
});

const ctx = (cwd: string): SettleCtx => ({
  cwd,
  firstModel: 'haiku',
  progressFile: null,
  running: [],
  completed: [],
  splitParts: new Map(),
  timing: new ReviewGateTiming(),
  verifyAssets: (o) => o,
});

let cwd = '';
beforeEach(() => {
  vi.stubEnv('DEVKIT_SHIP_ID', 'ship-test');
  cwd = mkdtempSync(join(tmpdir(), 'fail-transcript-ref-'));
  execSync('git init -q', { cwd });
  vi.stubEnv('DEVKIT_GATE_EVENTS', join(cwd, 'events.jsonl'));
  resetReviewBaseContext();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

const printed = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
const refLines = () =>
  printed().filter((l) => l.includes('reviewed diff: guard-review transcript'));
const storedDiff = (ref: string) =>
  readTranscript(ref)?.split(`${OUTPUT_HEADER}`)[0].replace(`${DIFF_HEADER}\n`, '').trimEnd();

describe('a failing reviewer names the transcript holding the diff it judged', () => {
  it('prints a resolvable ref for an unsplit FAIL', () => {
    settleReviewOutcome(ctx(cwd), guardTask(cwd), outcome('commit-guard', 'fail'), 1);
    const ref = 'transcripts/ship-test/review-commit-guard.txt';
    expect(refLines()).toEqual([
      `guard-review: commit-guard — reviewed diff: guard-review transcript ${ref}`,
    ]);
    expect(storedDiff(ref)).toBe(DIFF.trimEnd());
  });

  it('names no transcript off a run with telemetry off', () => {
    for (const id of ['DEVKIT_SHIP_ID', 'DEVKIT_REVIEW_ID', 'DEVKIT_AGENT_RUN_ID'])
      vi.stubEnv(id, '');
    vi.stubEnv('DEVKIT_NO_TELEMETRY', '1');
    vi.stubEnv('DEVKIT_GATE_EVENTS', '');
    settleReviewOutcome(ctx(cwd), guardTask(cwd), outcome('commit-guard', 'fail'), 1);
    expect(printed().some((l) => l.includes('guard-review transcript'))).toBe(false);
  });

  it('prints one ref for a split FAIL, at the merge rather than per part', () => {
    const c = ctx(cwd);
    const task = { ...guardTask(cwd), splitOf: 'commit-guard', group: 'g' };
    settleReviewOutcome(c, task, outcome('commit-guard', 'fail'), 1);
    settleReviewOutcome(c, { ...task, group: 'h' }, outcome('commit-guard', 'pass'), 1);
    expect(refLines()).toEqual([]);
    emitMergedLensResults(c.splitParts, 'sonnet');
    expect(refLines()).toHaveLength(1);
  });

  it('prints nothing new for a merged PASS', () => {
    const task = { ...guardTask(cwd), splitOf: 'commit-guard', group: 'g' };
    // SAFETY: the merge reads only res/secs/task, which this literal supplies.
    const part = { res: outcome('commit-guard', 'pass'), secs: 1, task } as LensPart;
    emitMergedLensResults(new Map([['commit-guard', [part]]]), 'sonnet');
    expect(refLines()).toEqual([]);
  });
});

describe('a chunked reviewer stores its whole diff, not whichever chunk settled first', () => {
  const sliceA = 'diff --git a/src/a.ts b/src/a.ts\n+a\n';
  const sliceB = 'diff --git a/src/b.ts b/src/b.ts\n+b\n';
  const assign = (index: number): ChunkAssignment => ({
    index,
    filesSha: `sha${index}`,
    count: 2,
    capBytes: 16_000,
    planHash: 'plan',
  });
  const part = (
    lens: string,
    diffText: string,
    status: 'pass' | 'fail',
    chunk?: ChunkAssignment,
  ) => {
    const sel = {
      reviewer: deriveLensReviewer(correctness, [lens]),
      files: ['src/a.ts', 'src/b.ts'],
    };
    const task: ReviewTask = { sel, key: lens, diffText, base: sel, splitOf: correctness.name };
    if (chunk) task.chunk = chunk;
    // SAFETY: the merge reads only res/secs/task, which this literal supplies.
    return { res: outcome(correctness.name, status), secs: 1, task } as LensPart;
  };

  it('composes the transcript from the un-chunked whole-diff part', () => {
    const parts = [
      part('state-transitions', sliceB, 'fail', assign(1)),
      part('state-transitions', sliceA, 'pass', assign(0)),
      part('writer-reader-contracts', sliceA + sliceB, 'pass'),
    ];
    emitMergedLensResults(new Map([[correctness.name, parts]]), 'sonnet');
    const ref = `transcripts/ship-test/review-${correctness.name}.txt`;
    expect(refLines()).toEqual([
      `guard-review: ${correctness.name} — reviewed diff: guard-review transcript ${ref}`,
    ]);
    expect(storedDiff(ref)).toBe((sliceA + sliceB).trimEnd());
  });

  // Catches a planner change that drops the un-chunked part: the merge would silently store a slice.
  it('holds for the real chunk plan, settled through the lens hold in completion order', () => {
    const segment = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,400 @@\n` +
      Array.from({ length: 400 }, (_, i) => `+const v${i} = '${'x'.repeat(30)}';\n`).join('');
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const diff = files.map(segment).join('');
    const { tasks } = planReviewWork(
      [{ reviewer: correctness, files }],
      [diff],
      {},
      new Map(),
      keyOf,
      FOUR_WAY_LENS_GROUPS,
      400,
    );
    const chunked = tasks.filter((t) => t.chunk);
    expect(new Set(chunked.map((t) => t.chunk?.index)).size).toBeGreaterThan(1);
    const last = chunked.at(-1);
    const c = ctx(cwd);
    if (last) settleReviewOutcome(c, last, outcome(correctness.name, 'fail'), 1);
    for (const t of tasks.filter((t) => t !== last))
      settleReviewOutcome(c, t, outcome(correctness.name, 'pass'), 1);
    emitMergedLensResults(c.splitParts, 'sonnet');
    expect(refLines()).toHaveLength(1);
    expect(storedDiff(`transcripts/ship-test/review-${correctness.name}.txt`)).toBe(diff.trimEnd());
  });
});
