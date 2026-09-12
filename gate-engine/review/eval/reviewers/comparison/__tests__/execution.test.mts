import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProbe, runRow, scoreRow } from '../../corpus/row.mts';
import {
  GROUPS,
  MODEL,
  ROOT,
  PREPARATION,
  loadComparison,
  schedule,
  validatePacket,
  sha256,
} from '../manifest.mts';
import { census, guardedExec, openEvidence, runComparison, summarizeCells } from '../execute.mts';
const comparison = loadComparison();
const row = comparison.rows[0];
const probe = comparison.probes[0];
const fail = async () => 'VERDICT: FAIL — controlled test finding';
const budget = { maxCalls: 8, maxElapsedMs: 60_000, judgeTimeoutMs: 30_000 };

describe('native execution and scoring boundary', () => {
  it('retains ordinary scoring and complete native task captures', async () => {
    const tasks = [];
    const result = await runRow(row, {
      exec: fail,
      cascade: false,
      groups: GROUPS,
      cap: 400,
      fullItems: true,
      onTask: (t) => tasks.push(t),
    });
    expect(result).toMatchObject({
      expected: 'FAIL',
      okFinal: true,
      execution: { complete: true, taskCount: 4 },
    });
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.capture[0].out.includes('controlled test finding'))).toBe(true);
  });
  it('rejects probes before scorer or native dispatch and rejects gold metadata on probes', async () => {
    const exec = vi.fn(fail);
    await expect(runRow(probe, { exec })).rejects.toThrow(/probes/);
    expect(() => scoreRow(probe, [], {})).toThrow(/probes/);
    for (const field of ['expected', 'reviewer', 'expectItems', 'holdout', 'control'])
      await expect(runProbe({ ...probe, [field]: 'hidden' }, { exec })).rejects.toThrow(/metadata/);
    expect(exec).not.toHaveBeenCalled();
    const result = await runProbe(probe, { exec, cascade: false, groups: GROUPS });
    expect(result).toMatchObject({ scoring: 'forbidden-unanchored-probe', status: 'fail' });
    expect(result).not.toHaveProperty('okFinal');
    expect(result).not.toHaveProperty('expected');
  });
  it('injects only independent instruction assets, without changing staged source', async () => {
    const inputs = [];
    for (const arm of ['B', 'P', 'L']) {
      await runRow(row, {
        cascade: false,
        groups: GROUPS,
        assetOverrides: comparison.assets[arm].overrides,
        exec: async (opts) => {
          inputs.push({ arm, input: opts.input, prompt: opts.args[1] });
          return fail();
        },
      });
    }
    expect(inputs.filter((x) => x.arm === 'B').map((x) => x.input)).toEqual(
      inputs.filter((x) => x.arm === 'L').map((x) => x.input),
    );
    expect(inputs[0].prompt).not.toBe(inputs[4].prompt);
    expect(inputs[4].prompt).not.toBe(inputs[8].prompt);
    await expect(
      runRow(row, { exec: fail, assetOverrides: { 'guard.config.json': '{}' } }),
    ).rejects.toThrow(/asset/);
  });
  it('propagates synchronous task-persistence failure', async () => {
    const exec = vi.fn(fail);
    await expect(
      runRow(row, {
        exec,
        cascade: false,
        groups: GROUPS,
        onTask: () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('frozen preparation, input and execution budgets', () => {
  it('counts both partitions and keeps every family together with reversed arm order', () => {
    const scored = census(comparison, 'scored');
    expect(scored.cells).toHaveLength(48);
    expect(scored.taskCount).toBe(192);
    expect(schedule(comparison, 'exploratory')).toHaveLength(56);
    expect(scored.cells.slice(0, 6).map((c) => c.arm)).toEqual(['B', 'B', 'P', 'P', 'L', 'L']);
    expect(scored.cells.slice(24, 30).map((c) => c.arm)).toEqual(['L', 'L', 'P', 'P', 'B', 'B']);
    expect(() => schedule(comparison, 'all')).toThrow();
  });
  it('rejects altered packets or packet files present in the staged diff', () => {
    const packet = comparison.packets.get(probe.id);
    expect(validatePacket(probe, packet)).toBe(packet.text);
    expect(() => validatePacket(probe, { ...packet, text: packet.text + 'answer' })).toThrow();
    const staged = {
      ...probe.repo.staged,
      [packet.files[0].path]: probe.repo.base[packet.files[0].path],
    };
    expect(() => validatePacket({ ...probe, repo: { ...probe.repo, staged } }, packet)).toThrow(
      /unchanged/,
    );
  });
  it('preserves native input and args, appends only source, records failures and capability', async () => {
    const records = [],
      state = { deadline: 1000, calls: 0, stopped: null };
    const opts = {
      input: 'native diff',
      args: ['-p', 'native brief', '--model', MODEL],
      timeout: 100,
      env: {},
      lens: 'state',
    };
    const delegate = vi.fn(async (forwarded) => {
      forwarded.onMcpPrepared('capability-hash');
      forwarded.onOutage({ kind: 'quota' });
      return null;
    });
    const exec = guardedExec({
      cell: { key: 'test' },
      packet: 'source packet',
      budget,
      state,
      write: (r) => records.push(r),
      delegate,
      now: () => 10,
    });
    await exec(opts);
    expect(delegate.mock.calls[0][0]).toMatchObject({
      input: 'native diff\n\nsource packet',
      args: opts.args,
    });
    expect(records[1]).toMatchObject({
      nativeInput: 'native diff',
      output: null,
      capability: 'capability-hash',
      outage: { kind: 'quota' },
      usage: null,
    });
  });
  it('never delegates with zero timeout, exhausted deadline or exceeded call budget', async () => {
    const delegate = vi.fn(fail);
    for (const [timeout, deadline, calls] of [
      [0, 1000, 0],
      [100, 0, 0],
      [100, 1000, 8],
    ]) {
      const exec = guardedExec({
        cell: { key: 'test' },
        packet: null,
        budget,
        state: { deadline, calls },
        write: () => {},
        delegate,
        now: () => 10,
      });
      await expect(exec({ timeout })).rejects.toThrow();
    }
    expect(delegate).not.toHaveBeenCalled();
  });
  it('stops subsequent dispatch after evidence loss and does not manufacture a successful cell', async () => {
    const state = { deadline: 1000, calls: 0, stopped: null },
      delegate = vi.fn(fail);
    const exec = guardedExec({
      cell: { key: 'test' },
      packet: null,
      budget,
      state,
      delegate,
      now: () => 10,
      write: () => {
        throw new Error('disk full');
      },
    });
    await expect(exec({ input: 'source', args: ['--model', MODEL], timeout: 100 })).rejects.toThrow(
      'disk full',
    );
    expect(state.stopped).toBe('evidence-write-failed');
    expect(delegate).not.toHaveBeenCalled();
  });
  it('retains missing cells and never computes exploratory quality scores', () => {
    const roster = {
      phase: 'exploratory',
      cells: [
        { key: 'one', arm: 'B' },
        { key: 'two', arm: 'C' },
      ],
    };
    const report = summarizeCells(roster, new Map([['one', { execution: { complete: false } }]]));
    expect(report).toMatchObject({ planned: 2, complete: 0, missing: 1, incomplete: 1 });
    expect(report).not.toHaveProperty('verdictProxies');
  });
  it('runs every quality miss once with fresh native captures', async () => {
    const all = census(comparison, 'scored'),
      roster = { ...all, cells: all.cells.slice(0, 2), taskCount: 8 };
    const records = [],
      documents = new Map(),
      delegate = vi.fn(fail);
    const evidence = {
      write: (r) => records.push(r),
      document: (name, value) => documents.set(name, value),
    };
    const report = await runComparison(comparison, roster, budget, evidence, {
      delegate,
      identity: { test: true },
    });
    expect(delegate).toHaveBeenCalledTimes(8);
    expect(report).toMatchObject({ planned: 2, complete: 2, calls: 8 });
    expect(records.filter((r) => r.kind === 'task')).toHaveLength(8);
    expect(documents.has('registration.private.json')).toBe(true);
  });
});

it('rejects changed preparation artifacts before any judge can start', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'comparison-pins-'));
  try {
    for (const name of ['.git', 'gate-engine', 'agents', 'skills', 'guard.config.json'])
      symlinkSync(path.join(ROOT, name), path.join(root, name));
    const dir = path.join(root, PREPARATION);
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(path.join(ROOT, PREPARATION), dir, { recursive: true });
    const patch = path.join(dir, 'agent.patch');
    writeFileSync(patch, readFileSync(patch, 'utf8') + '\n');
    expect(() => loadComparison(root)).toThrow(/hash mismatch/);
    const protocolPath = path.join(dir, 'protocol.json');
    const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
    protocol.arms.find((arm) => arm.id === 'P').patchSha256 = sha256(readFileSync(patch));
    writeFileSync(protocolPath, JSON.stringify(protocol));
    expect(() => loadComparison(root)).toThrow(/frozen PR605 protocol/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses an existing evidence directory and preserves its original registration', () => {
  const parent = mkdtempSync(path.join(homedir(), '.devkit', 'research', 'comparison-test-'));
  try {
    const output = path.join(parent, 'run'),
      evidence = openEvidence(output);
    evidence.document('registration.private.json', { original: true });
    evidence.close();
    expect(() => openEvidence(output)).toThrow();
    expect(
      JSON.parse(readFileSync(path.join(output, 'registration.private.json'), 'utf8')),
    ).toEqual({ original: true });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
it('preserves planned bug and repair denominators when nothing completes', () => {
  const roster = census(comparison, 'scored');
  const report = summarizeCells(roster, new Map());
  expect(report.missing).toBe(48);
  expect(
    report.verdictProxies.every(
      (a) => a.expectedFail === 8 && a.expectedPass === 8 && a.matched === 0,
    ),
  ).toBe(true);
});

it('rejects missing and duplicate model flags even when argv starts with the model name', async () => {
  const delegate = vi.fn(fail);
  for (const args of [[MODEL], ['--model', MODEL, '--model', 'other'], ['--model']]) {
    const exec = guardedExec({
      cell: { key: 'test' },
      packet: null,
      budget,
      state: { deadline: 1000, calls: 0 },
      write: () => {},
      delegate,
      now: () => 10,
    });
    await expect(exec({ input: 'source', timeout: 100, args })).rejects.toThrow(/model/);
  }
  expect(delegate).not.toHaveBeenCalled();
});
it('rechecks the deadline after a slow call-start write and does not dispatch', async () => {
  let clock = 10;
  const records = [],
    state = { deadline: 100, calls: 0, stopped: null },
    delegate = vi.fn(fail);
  const exec = guardedExec({
    cell: { key: 'test' },
    packet: null,
    budget,
    state,
    delegate,
    now: () => clock,
    write: (r) => {
      records.push(r);
      clock = 101;
    },
  });
  await expect(exec({ input: 'source', args: ['--model', MODEL], timeout: 100 })).rejects.toThrow(
    /persistence/,
  );
  expect(delegate).not.toHaveBeenCalled();
  expect(state.calls).toBe(0);
  expect(state.stopped).toBe('budget-exhausted');
  expect(records.at(-1)).toMatchObject({ dispatched: false, output: null });
});
it('stops future dispatches after a permanent provider outage', async () => {
  const state = { deadline: 1000, calls: 0, stopped: null },
    delegate = vi.fn(async (opts) => {
      opts.onOutage({ kind: 'quota', permanent: true });
      return null;
    });
  const exec = guardedExec({
    cell: { key: 'test' },
    packet: null,
    budget,
    state,
    delegate,
    write: () => {},
    now: () => 10,
  });
  const opts = { input: 'source', args: ['--model', MODEL], timeout: 100 };
  await exec(opts);
  await expect(exec(opts)).rejects.toThrow('permanent-provider-outage');
  expect(delegate).toHaveBeenCalledTimes(1);
});
it('passes an integer timeout when the monotonic clock has fractional milliseconds', async () => {
  const delegate = vi.fn(fail);
  const exec = guardedExec({
    cell: { key: 'test' },
    packet: null,
    budget,
    state: { deadline: 1000.5, calls: 0 },
    delegate,
    write: () => {},
    now: () => 10.7,
  });
  await exec({ input: 'source', args: ['--model', MODEL], timeout: 2000 });
  expect(delegate.mock.calls[0][0].timeout).toBe(989);
});
