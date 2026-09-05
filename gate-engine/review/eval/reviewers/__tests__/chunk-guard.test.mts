/** Native parity, incomplete-task recovery and workload census; no live judge calls. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { materializeFixture } from '../../../../decisions/eval/bench.mts';
import { gitCached } from '../../../evidence/staged-git.mts';
import { planReviewWork } from '../../../lens/split.mts';
import { BENCH_REVIEWERS, runRow, validateRow } from '../bench.mts';
import {
  BENCH_LENS_GROUPS,
  executePlan,
  executionHash,
  isolateBenchTelemetry,
  planFixture,
  preflightPlans,
} from '../corpus/chunk-guard.mts';
import { loadRows, rowHash } from '../corpus.mts';
import {
  archiveProgress,
  loadProgress,
  progressFile,
  salvageMap,
  taskSalvage,
  withBenchmarkRun,
} from '../progress.mts';
const reviewer = BENCH_REVIEWERS.find((r) => r.name === 'correctness-reviewer');
const large = loadRows(reviewer, { only: 'corr-only-selector-silent-drop' })[0];
const small = loadRows(reviewer, { only: 'corr-lock-timeout-runs-unlocked' })[0];

describe('native benchmark planning', () => {
  it('reuses identical native selections, scoped commands and chunks without telemetry', () => {
    const fx = materializeFixture({ repo: large.repo });
    const eventDir = mkdtempSync(path.join(tmpdir(), 'bench-planner-events-'));
    const sink = path.join(eventDir, 'events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    try {
      const sel = { reviewer, files: fx.staged };
      const diff = gitCached(fx.repo, [], sel.files);
      const native = planReviewWork(
        [sel],
        [diff],
        {},
        new Map(),
        (...x) => x.join('|'),
        BENCH_LENS_GROUPS,
        400,
      );
      const events = readFileSync(sink, 'utf8');
      expect(
        events
          .trim()
          .split('\n')
          .map(JSON.parse)
          .filter((e) => e.type === 'review_chunk_plan'),
      ).toHaveLength(1);
      const bench = planFixture(sel, fx.repo, { cap: 400 });
      expect(readFileSync(sink, 'utf8')).toBe(events);
      const contract = (t) => ({
        sel: t.sel,
        group: t.group,
        chunk: t.chunk,
        diffText: t.diffText,
      });
      expect(bench.tasks.map(contract)).toEqual(native.tasks.map(contract));
      expect(bench.facts).toMatchObject({ chunkCount: 3, taskCount: 10 });
      expect(bench.tasks.filter((t) => !t.chunk).map((t) => t.group)).toEqual([
        'writer-reader-contracts',
      ]);
      expect(new Set(bench.tasks.map((t) => t.sel.reviewer.stateFile)).size).toBe(10);
      expect(planFixture(sel, fx.repo, { cap: null }).tasks).toHaveLength(4);
      expect(planFixture(sel, fx.repo, { groups: null }).tasks).toHaveLength(1);
    } finally {
      fx.cleanup();
      rmSync(eventDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
  it('censuses four large rows and validates actual derived checklist artifacts', () => {
    const census = preflightPlans(loadRows(reviewer));
    expect(census.filter((p) => p.chunkCount > 1)).toHaveLength(4);
    expect(census.reduce((sum, p) => sum + p.taskCount, 0)).toBe(608);
    expect(validateRow(large).problems).toEqual([]);
    expect(validateRow(small).problems).toEqual([]);
    expect(() =>
      preflightPlans([{ ...small, repo: { base: small.repo.base, staged: small.repo.base } }]),
    ).toThrow(/no staged selection/);
  });
  it('runs every planned task with the scoped staged-file environment', async () => {
    const envs = [];
    const result = await runRow(large, {
      exec: async (opts) => {
        envs.push(JSON.parse(opts.env.DEVKIT_REVIEW_STAGED_FILES));
        return 'VERDICT: FAIL — test';
      },
    });
    expect(result.execution.complete).toBe(true);
    expect(result.execution.taskCount).toBe(10);
    expect(result.execution.tasks.map((t) => t.files)).toEqual(envs);
    expect(result.execution.tasks.every((t) => t.calls === 1)).toBe(true);
    expect(result.firstVerdict).toBe('FAIL');
  });
  it('removes an inherited explicit production sink as well as correlation IDs', () => {
    const env = {
      DEVKIT_GATE_EVENTS: '/production',
      DEVKIT_SHIP_ID: 'ship',
      DEVKIT_COMMIT_ID: 'commit',
      DEVKIT_REVIEW_ID: 'review',
      DEVKIT_AGENT_RUN_ID: 'agent',
      KEEP: 'yes',
    };
    isolateBenchTelemetry(env);
    expect(env).toEqual({ KEEP: 'yes', DEVKIT_NO_TELEMETRY: '1' });
  });
});

describe('task evidence and recovery', () => {
  const plan = {
    tasks: Array.from({ length: 7 }, (_, i) => ({
      key: `k${i}`,
      group: `g${i}`,
      sel: { reviewer, files: [`src/f${i}.ts`] },
    })),
  };
  const outcome = (status) => ({
    res: { name: reviewer.name, status },
    capture: [{ label: 'review:correctness-reviewer', out: `VERDICT: ${status.toUpperCase()}` }],
  });
  it('retains quality misses and resumes only two unfinished tasks after an interruption', async () => {
    const ledger = [];
    const interrupted = vi.fn(async () => outcome('fail'));
    await expect(
      executePlan(plan, interrupted, {
        onTask: (task) => {
          ledger.push(task);
          if (ledger.length === 5) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const resumed = vi.fn(async () => outcome('pass'));
    const measured = await executePlan(plan, resumed, {
      saved: new Map(ledger.map((t) => [t.key, t])),
    });
    expect(interrupted).toHaveBeenCalledTimes(5);
    expect(resumed).toHaveBeenCalledTimes(2);
    expect(measured.parts).toHaveLength(7);
    expect(measured.complete).toBe(true);
    expect(measured.cas.status).toBe('fail');
  });
  it('a FAIL cannot hide an error or a malformed sibling', async () => {
    for (const bad of [
      { res: { name: reviewer.name, status: 'error' }, capture: [] },
      {
        res: { name: reviewer.name, status: 'inconclusive', reason: 'invalid checklist' },
        capture: [{ label: 'review:correctness-reviewer', out: 'VERDICT: FAIL' }],
      },
      {
        res: { name: reviewer.name, status: 'inconclusive' },
        capture: [{ label: 'review:correctness-reviewer', out: 'no verdict' }],
      },
    ]) {
      const measured = await executePlan(plan, async (t) =>
        t.key === 'k1' ? bad : outcome('fail'),
      );
      expect(measured.cas.status).toBe('fail');
      expect(measured.complete).toBe(false);
      expect(measured.parts[1].complete).toBe(false);
    }
  });
  it('invalidates row and task salvage on every execution-condition change', () => {
    const condition = {
      gateHash: 'runner+planner',
      model: 'sol',
      cascade: true,
      escalationModel: 'escalator',
      cap: 400,
      groups: BENCH_LENS_GROUPS,
    };
    const identity = executionHash(condition);
    const entries = [
      {
        reviewer: reviewer.name,
        gateHash: condition.gateHash,
        executionHash: identity,
        rowHash: rowHash(small),
        res: { id: small.id, subcause: null },
      },
      {
        kind: 'task',
        executionHash: identity,
        rowHash: rowHash(small),
        task: { key: 'k', complete: true },
      },
    ];
    expect(taskSalvage(entries, small, identity).size).toBe(1);
    expect(
      salvageMap(
        entries,
        reviewer.name,
        { gateHash: condition.gateHash, executionHash: identity },
        [small],
      ).size,
    ).toBe(1);
    for (const changed of [
      { cap: null },
      { groups: null },
      { model: 'other' },
      { cascade: false },
      { escalationModel: 'other' },
      { gateHash: 'new runner' },
    ]) {
      const next = executionHash({ ...condition, ...changed });
      expect(next).not.toBe(identity);
      expect(taskSalvage(entries, small, next).size).toBe(0);
      expect(
        salvageMap(entries, reviewer.name, { gateHash: condition.gateHash, executionHash: next }, [
          small,
        ]).size,
      ).toBe(0);
    }
  });
});

it('archives raw failed and completed attempts without offering them to the next run', () => {
  const model = `archive-control-${crypto.randomUUID()}`;
  const active = progressFile(model, false);
  const attempts = [
    { kind: 'task', task: { complete: false, capture: ['protocol error'] } },
    { kind: 'task', task: { complete: true, capture: ['quality miss'] } },
  ];
  const bytes = attempts.map(JSON.stringify).join('\n') + '\n';
  let archived;
  try {
    writeFileSync(active, bytes);
    archived = archiveProgress(model, false);
    expect(readFileSync(archived, 'utf8')).toBe(bytes);
    expect(loadProgress(model, false)).toEqual([]);
  } finally {
    rmSync(active, { force: true });
    if (archived) rmSync(archived, { force: true });
  }
});

it('holds one benchmark owner through suspension and releases it before a subsequent run', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bench-owner-'));
  const lock = path.join(root, 'run.lock');
  const barrier = Promise.withResolvers<void>();
  let first;
  try {
    first = withBenchmarkRun(async () => {
      await barrier.promise;
      return 'archived';
    }, lock);
    const second = vi.fn(async () => 'should not judge');
    await expect(withBenchmarkRun(second, lock)).rejects.toThrow(
      'Another reviewer benchmark is in progress',
    );
    expect(second).not.toHaveBeenCalled();
    barrier.resolve();
    await expect(first).resolves.toBe('archived');
    await expect(withBenchmarkRun(async () => 'next run', lock)).resolves.toBe('next run');
  } finally {
    barrier.resolve();
    await first;
    rmSync(root, { recursive: true, force: true });
  }
});
