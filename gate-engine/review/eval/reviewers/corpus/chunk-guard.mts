// @ts-nocheck — BENCH-ONLY; native execution planning and measurement identity.
import { createHash } from 'node:crypto';
import { resolveGuardConfig } from '../../../../config.mts';
import { materializeFixture } from '../../../../decisions/eval/bench.mts';
import { gitCached } from '../../../evidence/staged-git.mts';
import { identityBytesByPath } from '../../../lens/chunk.mts';
import { resolveChunkCap } from '../../../lens/chunk-tasks.mts';
import { resolveLensGroups } from '../../../lens/groups.mts';
import { mergeLensOutcomes, planReviewWork } from '../../../lens/split.mts';
import { parseReviewVerdict, selectReviewers } from '../../../reviewers.mts';
import { FIXTURE_CONFIG } from '../corpus.mts';

// Freeze BEFORE cleanBenchEnv removes GUARD_*; planning, checkpoints and reports use one condition.
export const BENCH_CHUNK_LOC = resolveChunkCap();
export const BENCH_LENS_GROUPS = resolveLensGroups();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function executionHash({
  gateHash,
  model,
  cascade,
  escalationModel,
  cap = BENCH_CHUNK_LOC,
  groups = BENCH_LENS_GROUPS,
}) {
  return hash({
    version: 2,
    gateHash,
    model,
    cascade,
    escalationModel: cascade ? escalationModel : null,
    cap,
    groups,
  });
}

/** Same planner and scoped selections as production, with an explicitly inert telemetry emitter. */
export function planFixture(sel, cwd, { cap = BENCH_CHUNK_LOC, groups = BENCH_LENS_GROUPS } = {}) {
  const diff = gitCached(cwd, [], sel.files);
  const { tasks } = planReviewWork(
    [sel],
    [diff],
    {},
    new Map(),
    (...key) => hash(key),
    groups,
    cap,
    () => {},
  );
  const chunks = new Set(tasks.filter((t) => t.chunk).map((t) => t.chunk.index));
  return {
    tasks,
    facts: {
      identityBytes: [...identityBytesByPath(diff).values()].reduce((a, b) => a + b, 0),
      chunkCount: chunks.size,
      taskCount: tasks.length,
      cap,
      groups,
      planHash: hash(tasks.map((t) => t.key)),
    },
  };
}

/** Zero-judge census of the actual staged selection, including empty-diff rejection. */
export function preflightPlans(rows, options = {}) {
  return rows.map((row) => {
    const fx = materializeFixture({
      repo: {
        base: { ...row.repo.base, 'guard.config.json': JSON.stringify(FIXTURE_CONFIG) },
        staged: row.repo.staged,
      },
    });
    try {
      const sel = selectReviewers(fx.staged, resolveGuardConfig(fx.repo)).find(
        (s) => s.reviewer.name === row.reviewer,
      );
      if (!sel) throw new Error(`${row.id}: no staged selection for ${row.reviewer}`);
      return { id: row.id, reviewer: row.reviewer, ...planFixture(sel, fx.repo, options).facts };
    } finally {
      fx.cleanup();
    }
  });
}

/** Standalone bench calls must never inherit a ship's production event sink or correlation IDs. */
export function isolateBenchTelemetry(env = process.env) {
  for (const key of [
    'DEVKIT_GATE_EVENTS',
    'DEVKIT_SHIP_ID',
    'DEVKIT_COMMIT_ID',
    'DEVKIT_REVIEW_ID',
    'DEVKIT_AGENT_RUN_ID',
  ])
    delete env[key];
  env.DEVKIT_NO_TELEMETRY = '1';
}

/** Persist native tasks sequentially within the global row pool, including every quality miss.
 * Resume retries incomplete execution only. */
export async function executePlan(plan, run, { saved = new Map(), onTask = () => {} } = {}) {
  const parts = [];
  for (const task of plan.tasks) {
    let held = saved.get(task.key);
    if (!held?.complete) {
      let capture = [];
      let res;
      try {
        ({ res, capture } = await run(task));
      } catch (error) {
        res = { name: task.sel.reviewer.name, status: 'error', reason: String(error) };
      }
      const first = capture.find((c) => !c.label.endsWith(':escalate'));
      const complete =
        !!first &&
        parseReviewVerdict(first.out).verdict !== null &&
        (res.status === 'pass' || res.status === 'fail');
      held = {
        key: task.key,
        group: task.group ?? null,
        chunk: task.chunk ?? null,
        files: task.sel.files,
        stateFile: task.sel.reviewer.stateFile,
        res,
        capture,
        complete,
      };
      onTask(held);
    }
    parts.push(held);
  }
  return {
    cas: mergeLensOutcomes(
      parts.map((p) => p.res),
      plan.tasks[0].sel.reviewer.name,
    ),
    capture: parts.flatMap((p) => p.capture),
    parts,
    complete: parts.every((p) => p.complete),
  };
}
