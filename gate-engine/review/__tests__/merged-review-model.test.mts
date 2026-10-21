import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetReviewBaseContext } from '../evidence/base-context.mts';
import { emitMergedLensResults } from '../lens/merge-results.mts';
import {
  FOUR_WAY_LENS_GROUPS,
  lensGroupId,
  planReviewWork,
  type ReviewTask,
} from '../lens/split.mts';
import { settleReviewOutcome, type SettleCtx } from '../recovery/settle.mts';
import { REVIEWERS, type ReviewerSelection } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { ReviewGateTiming } from '../telemetry/timing.mts';

// The correctness review_result names the model that judged, never review.model (the cascade
// default), including when a cache-replayed lens part with no model leads the merge.

interface WireEvent {
  type: string;
  status?: string;
  model?: string;
  lens_parts?: { lens: string; model?: string }[];
}

const PIN = 'pin-x';
const CASCADE_DEFAULT = 'cfg-default';
const NAME = 'correctness-reviewer';
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+let shared = 0;\n';
const keyOf = (name: string, diff: string, salt: string) => `${name}|${diff}|${salt}`;

const correctness = REVIEWERS.find((r) => r.name === NAME);
if (!correctness) throw new Error('fixture: correctness-reviewer missing from REVIEWERS');
// What selectReviewers hands the gate: the correctness reviewer carrying its resolved pin.
const sel: ReviewerSelection = { reviewer: { ...correctness, model: PIN }, files: ['src/a.ts'] };

let cwd = '';
let savedSink: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'merged-review-model-'));
  execSync('git init -q', { cwd });
  savedSink = process.env.DEVKIT_GATE_EVENTS;
  process.env.DEVKIT_GATE_EVENTS = join(cwd, 'events.jsonl');
  resetReviewBaseContext();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedSink === undefined) delete process.env.DEVKIT_GATE_EVENTS;
  else process.env.DEVKIT_GATE_EVENTS = savedSink;
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ctx = (splitParts: SettleCtx['splitParts']): SettleCtx => ({
  cwd,
  firstModel: CASCADE_DEFAULT,
  progressFile: null,
  running: [],
  completed: [],
  splitParts,
  timing: new ReviewGateTiming(),
  verifyAssets: (o) => o,
});

function outcome(status: string, model?: string): ReviewOutcome {
  const o: ReviewOutcome = { name: NAME, status, reason: 'r', escalated: false };
  if (model) o.model = model;
  return o;
}

function reviewResult(): WireEvent {
  const rows = readFileSync(join(cwd, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      // SAFETY: the sink is written only by emitGateEvent in this test; WireEvent reads it optionally.
      return JSON.parse(l) as WireEvent;
    })
    .filter((e) => e.type === 'review_result');
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Plan a four-way split with the first lens group already cached, settle every live group with
 * `live(task)`, then merge — the production order, so the replayed group leads `parts`. */
function resumeSplit(live: (t: ReviewTask) => ReviewOutcome): WireEvent {
  const planWith = (cache: Record<string, { at: string }>) =>
    planReviewWork([sel], [DIFF], cache, new Map(), keyOf, FOUR_WAY_LENS_GROUPS, null);
  const plan = planWith({ [planWith({}).tasks[0].key]: { at: 'n' } });
  expect(plan.tasks).toHaveLength(FOUR_WAY_LENS_GROUPS.length - 1);
  const c = ctx(plan.splitParts);
  for (const t of plan.tasks) settleReviewOutcome(c, t, live(t), 1);
  emitMergedLensResults(c.splitParts, CASCADE_DEFAULT);
  return reviewResult();
}

describe('merged correctness review_result model', () => {
  it('an all-PASS resume led by a cache-replayed group names the pin, not review.model', () => {
    const row = resumeSplit(() => outcome('pass', PIN));
    expect(row.status).toBe('pass');
    expect(row.model).toBe(PIN);
    // A replayed group keeps no lens model: readers infer "replayed" from its absence.
    expect(row.lens_parts?.[0]).not.toHaveProperty('model');
    expect(row.lens_parts?.slice(1).map((p) => p.model)).toEqual([PIN, PIN, PIN]);
  });

  it('a resume where no live judge ran (engine error) still names the pin', () => {
    const row = resumeSplit(() => outcome('inconclusive'));
    expect(row.status).toBe('inconclusive');
    expect(row.model).toBe(PIN);
  });

  it("a FAIL keeps the failing group's own model", () => {
    const last = lensGroupId(FOUR_WAY_LENS_GROUPS[FOUR_WAY_LENS_GROUPS.length - 1]);
    const row = resumeSplit((t) =>
      t.group === last ? outcome('fail', 'fail-m') : outcome('pass', PIN),
    );
    expect(row.status).toBe('fail');
    expect(row.model).toBe('fail-m');
  });

  it('an unsplit correctness review where no judge ran names the pin', () => {
    const plan = planReviewWork([sel], [DIFF], {}, new Map(), keyOf, null, null);
    settleReviewOutcome(ctx(plan.splitParts), plan.tasks[0], outcome('inconclusive'), 1);
    expect(reviewResult().model).toBe(PIN);
  });
});
