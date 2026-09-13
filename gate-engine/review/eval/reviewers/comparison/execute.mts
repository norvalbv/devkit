// @ts-nocheck — BENCH-ONLY; fixed-roster execution with private synchronous receipts.
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { execJudgeAsync } from '../../../../judge/run-judge.mts';
import { hashLocalModuleClosure } from '../../module-closure-hash.mts';
import { preflightPlans } from '../corpus/chunk-guard.mts';
import { runProbe, runRow } from '../corpus/row.mts';
import { researchOutputDirectory } from '../scale/materialize.mts';
import { GROUPS, MODEL, ROOT, canonical, schedule, sha256, validatePacket } from './manifest.mts';

export function census(comparison, phase) {
  const source = phase === 'scored' ? comparison.rows : comparison.probes;
  const plans = preflightPlans(
    source.map((row) => ({ ...row, reviewer: 'correctness-reviewer' })),
    { cap: 400, groups: GROUPS },
  );
  const facts = new Map(plans.map((p) => [p.id, p]));
  const cells = schedule(comparison, phase).map((cell) => {
    const sourceRow = source.find((r) => r.id === cell.id);
    const record = {
      ...cell,
      plan: facts.get(cell.id),
      sourceSha256: sha256(canonical(sourceRow)),
    };
    if (phase === 'scored') record.expected = sourceRow.expected;
    return record;
  });
  return { phase, cells, taskCount: cells.reduce((n, c) => n + c.plan.taskCount, 0) };
}
export function executionIdentity(comparison) {
  return {
    protocolSha256: comparison.protocolSha256,
    runnerSha256: hashLocalModuleClosure([
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./cli.mts', import.meta.url)),
    ]),
    lockSha256: sha256(readFileSync(path.join(ROOT, 'bun.lock'))),
    runtime: process.version,
    platform: process.platform,
    architecture: process.arch,
    historicalSources: comparison.historicalSources,
    assets: Object.fromEntries(
      Object.entries(comparison.assets).map(([arm, asset]) => [arm, asset.sha256]),
    ),
    packets: Object.fromEntries([...comparison.packets].map(([id, packet]) => [id, packet.sha256])),
  };
}
export function validateBudget(budget) {
  for (const key of ['maxCalls', 'maxElapsedMs', 'judgeTimeoutMs'])
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0)
      throw new Error(`positive integer budget required: ${key}`);
  if (budget.judgeTimeoutMs > 1_800_000) throw new Error('judge timeout exceeds native ceiling');
}
/** Exclusive run directory; append-only receipts, never load/salvage an earlier attempt. */
export function openEvidence(output) {
  const parent = researchOutputDirectory(path.dirname(path.resolve(output)));
  const directory = path.join(parent, path.basename(output));
  mkdirSync(directory, { mode: 0o700 });
  const fd = openSync(path.join(directory, 'events.private.jsonl'), 'wx', 0o600);
  return {
    directory,
    write: (event) => appendFileSync(fd, `${JSON.stringify(event)}\n`),
    document: (name, value) =>
      writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      }),
    close: () => closeSync(fd),
  };
}
/** Native delegate guard also checks deadlines AFTER fixture setup and before each spawn. */
export function guardedExec({
  cell,
  packet,
  budget,
  state,
  write,
  delegate = execJudgeAsync,
  now = () => performance.now(),
}) {
  return async (opts) => {
    const remaining = state.deadline - now();
    if (state.stopped || remaining <= 0 || state.calls >= budget.maxCalls || !(opts.timeout > 0)) {
      state.stopped ||= 'budget-exhausted';
      throw new Error(state.stopped);
    }
    z.string().parse(opts.input);
    const args = z.array(z.string()).parse(opts.args);
    const modelIndex = args.indexOf('--model');
    if (
      modelIndex < 0 ||
      args.filter((arg) => arg === '--model').length !== 1 ||
      args[modelIndex + 1] !== MODEL
    )
      throw new Error('unexpected effective model');
    const input = packet === null ? opts.input : `${opts.input}\n\n${packet}`;
    const timeout = Math.floor(Math.min(opts.timeout, remaining, budget.judgeTimeoutMs));
    if (!(timeout > 0)) throw new Error('budget exhausted before dispatch');
    const attempt = state.calls + 1,
      started = now();
    const receipt = {
      kind: 'call',
      dispatched: false,
      cell: cell.key,
      attempt,
      args: opts.args,
      nativeInput: opts.input,
      input,
      nativeInputSha256: sha256(opts.input),
      inputSha256: sha256(input),
      timeout,
      lens: opts.lens ?? null,
      stagedFiles: opts.env?.DEVKIT_REVIEW_STAGED_FILES ?? null,
      model: MODEL,
      capability: null,
      outage: null,
      usage: null,
      usageStatus: 'unavailable-through-native-delegate',
      output: null,
      error: null,
    };
    const persist = (event) => {
      try {
        write(event);
      } catch (error) {
        state.stopped = 'evidence-write-failed';
        throw error;
      }
    };
    persist({ ...receipt, kind: 'call-start', at: new Date().toISOString() });
    try {
      receipt.timeout = Math.floor(
        Math.min(opts.timeout, state.deadline - now(), budget.judgeTimeoutMs),
      );
      if (!(receipt.timeout > 0)) {
        state.stopped = 'budget-exhausted';
        throw new Error('budget exhausted during call-start persistence');
      }
      state.calls += 1;
      receipt.dispatched = true;
      receipt.output = await delegate({
        ...opts,
        input,
        timeout: receipt.timeout,
        onMcpPrepared: (value) => {
          receipt.capability = value;
          opts.onMcpPrepared?.(value);
        },
        onOutage: (value) => {
          receipt.outage = value;
          if (value.permanent) state.stopped = 'permanent-provider-outage';
          opts.onOutage?.(value);
        },
      });
      return receipt.output;
    } catch (error) {
      receipt.error = String(error);
      throw error;
    } finally {
      persist({ ...receipt, ms: now() - started, at: new Date().toISOString() });
    }
  };
}
export function summarizeCells(roster, outcomes) {
  const cells = roster.cells.map((cell) => {
    const result = outcomes.get(cell.key);
    return { ...cell, outcome: result ?? null, complete: result?.execution?.complete === true };
  });
  const summary = {
    phase: roster.phase,
    planned: cells.length,
    attempted: outcomes.size,
    complete: cells.filter((c) => c.complete).length,
    missing: cells.filter((c) => !c.outcome).length,
    incomplete: cells.filter((c) => c.outcome && !c.complete).length,
    cells,
  };
  if (roster.phase === 'scored')
    summary.verdictProxies = ['B', 'P', 'L'].map((arm) => {
      const armCells = cells.filter((c) => c.arm === arm);
      return {
        arm,
        planned: armCells.length,
        complete: armCells.filter((c) => c.complete).length,
        expectedFail: armCells.filter((c) => c.expected === 'FAIL').length,
        expectedPass: armCells.filter((c) => c.expected === 'PASS').length,
        matched: armCells.filter((c) => c.complete && c.outcome.okFinal).length,
        bugBlocked: armCells.filter(
          (c) => c.complete && c.outcome.expected === 'FAIL' && c.outcome.okFinal,
        ).length,
        repairAccepted: armCells.filter(
          (c) => c.complete && c.outcome.expected === 'PASS' && c.outcome.okFinal,
        ).length,
      };
    });
  return summary;
}
/** A persistence failure stops paid dispatch. No outcome, including FAIL, is retried. */
export async function runComparison(
  comparison,
  roster,
  budget,
  evidence,
  { delegate, now = () => performance.now(), identity = executionIdentity(comparison) } = {},
) {
  validateBudget(budget);
  if (budget.maxCalls > roster.taskCount)
    throw new Error('call budget exceeds fixed first-pass roster');
  const started = now(),
    state = { deadline: started + budget.maxElapsedMs, calls: 0, stopped: null };
  const outcomes = new Map();
  evidence.document('registration.private.json', {
    schemaVersion: 1,
    identity,
    roster,
    budget,
    authorized: true,
    model: MODEL,
    cap: 400,
    groups: GROUPS,
    cascade: false,
    concurrency: 1,
    issueCap: 3,
    retries: 0,
    cacheReuse: false,
    at: new Date().toISOString(),
    interpretation:
      'Exposed guardrail verdict proxies only; no factual precision, probe scores, candidate promotion or production effect.',
  });
  for (const cell of roster.cells) {
    if (state.stopped || now() >= state.deadline || state.calls >= budget.maxCalls) {
      state.stopped ||= 'budget-exhausted';
      break;
    }
    const source = (cell.phase === 'scored' ? comparison.rows : comparison.probes).find(
      (r) => r.id === cell.id,
    );
    if (!source || sha256(canonical(source)) !== cell.sourceSha256)
      throw new Error('roster source changed after census');
    const packet =
      cell.arm === 'C' ? validatePacket(source, comparison.packets.get(source.id)) : null;
    const exec = guardedExec({ cell, packet, budget, state, write: evidence.write, delegate, now });
    const onTask = (task) => {
      try {
        evidence.write({ kind: 'task', cell: cell.key, task });
      } catch (error) {
        state.stopped = 'evidence-write-failed';
        throw error;
      }
    };
    const options = {
      model: MODEL,
      cascade: false,
      cap: 400,
      groups: GROUPS,
      assetOverrides: comparison.assets[cell.arm].overrides,
      fullItems: true,
      judgeTimeoutMs: budget.judgeTimeoutMs,
      exec,
      onTask,
    };
    let result;
    try {
      result = await (cell.phase === 'scored'
        ? runRow(source, options)
        : runProbe(source, options));
    } catch (error) {
      result = { id: cell.id, error: String(error), execution: null };
    }
    outcomes.set(cell.key, result);
    evidence.write({ kind: 'cell', cell: cell.key, result });
    console.error(
      `comparison: ${cell.key} ${result.finalStatus ?? result.status ?? 'error'} (${outcomes.size}/${roster.cells.length}, ${state.calls} calls)`,
    );
  }
  const report = {
    schemaVersion: 1,
    ...summarizeCells(roster, outcomes),
    calls: state.calls,
    elapsedMs: now() - started,
    stopped: state.stopped,
  };
  evidence.document('report.private.json', report);
  return report;
}
