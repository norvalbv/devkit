import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mts';
import { reportCachedHitNotes } from '../contracts/checklist.mts';
import { resetReviewBaseContext } from '../evidence/base-context.mts';
import { planReviewWork } from '../lens/split.mts';
import { fingerprint, persist, reconcile } from '../overrides.mts';
import { settleReviewOutcome, type SettleCtx } from '../recovery/settle.mts';
import { REVIEWERS } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { ReviewGateTiming } from '../telemetry/timing.mts';

const REVIEWER = 'correctness-reviewer';
const LENS = 'concurrency-races';
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+let shared = 0;\n';
const reviewer = REVIEWERS.find((r) => r.name === REVIEWER);
if (!reviewer) throw new Error('correctness-reviewer must exist');
const sel = { reviewer, files: ['src/a.ts'] };
const keyOf = (name: string, diff: string, salt: string) => `${name}|${diff}|${salt}`;
const plan = (cwd: string) =>
  planReviewWork([sel], [DIFF], loadCache(cwd), new Map(), keyOf, null, null);

const pass = (waivers?: ReviewOutcome['waivers']): ReviewOutcome => ({
  name: REVIEWER,
  status: 'pass',
  reason: '',
  escalated: false,
  waivers,
});

const ctx = (cwd: string): SettleCtx => ({
  cwd,
  firstModel: 'sonnet',
  progressFile: null,
  running: [],
  completed: [],
  splitParts: new Map(),
  timing: new ReviewGateTiming(),
  verifyAssets: (outcome) => outcome,
});

let cwd = '';
const savedSink = process.env.DEVKIT_GATE_EVENTS;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cached-waiver-'));
  execSync('git init -q', { cwd });
  process.env.DEVKIT_GATE_EVENTS = join(cwd, 'events.jsonl'); // keep emits off live telemetry
  resetReviewBaseContext();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
  if (savedSink === undefined) delete process.env.DEVKIT_GATE_EVENTS;
  else process.env.DEVKIT_GATE_EVENTS = savedSink;
});

describe('a PASS earned under a waiver, replayed from the review cache', () => {
  it('names the waiver on replay, and re-judges once the waiver is revoked', () => {
    const fp = fingerprint(REVIEWER, LENS, DIFF);
    persist(cwd, { [fp]: { rationale: 'false positive: a single writer owns `shared`' } });
    const { suppressed, blocking } = reconcile(cwd, REVIEWER, [LENS], DIFF, 'now', {});
    expect(blocking).toEqual([]);

    const fresh = plan(cwd);
    expect(fresh.tasks).toHaveLength(1);
    settleReviewOutcome(ctx(cwd), fresh.tasks[0], pass(suppressed), 1000);

    const replay = plan(cwd);
    expect(replay.tasks).toHaveLength(0);
    reportCachedHitNotes(replay.cachedHits[0]);
    expect(console.error).toHaveBeenCalledWith(
      `guard-review: ${REVIEWER} — ${LENS} overridden [${fp}] (cached PASS)`,
    );

    persist(cwd, {});
    expect(plan(cwd).tasks).toHaveLength(1);
  });

  it('a PASS earned with no waiver replays as before, whatever the store holds', () => {
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], pass(), 1000);
    const replay = plan(cwd);
    expect(replay.tasks).toHaveLength(0);
    expect(replay.cachedHits[0].waivers).toEqual([]);
  });
});
