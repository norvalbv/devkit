/** decisions-brief bench: fixtures, delivery parity with the shipped hooks, the stub, the child
 * process contract, checkpoint identity, scoring and the report contrast. Zero LLM calls. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOOK_REGISTRATIONS } from '../../../cli/lib/install/hook-registration-ledger/registrations.mts';
import { packageDir } from '../../../cli/lib/fs-helpers.mts';
import { parseBaseline } from '../../eval/adapters.mts';
import {
  childArgv,
  childEnv,
  decisionHookScripts,
  gateFiles,
  gateHash,
  loadTask,
  MODEL,
  outcome,
  READ_ON_TOOLS,
  runCommand,
  setupScratch,
  validateTask,
} from '../eval/brief/bench.mts';
import {
  type Baseline,
  manifest,
  planJobs,
  progressRows,
  reportLines,
  rowId,
  type Run,
  summarize,
} from '../eval/brief/score.mts';
import { openCheckpoint, readProgress } from '../eval/checkpoint.mts';
import { mcnemarMidP } from '../eval/compare.mts';

const specs = manifest();
const target = loadTask('q1-fetch-unknown');
const made: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const scratchFor = (hooks: boolean) => {
  const dir = setupScratch(target.dir, hooks);
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every PreToolUse command in the scratch settings, run the way Claude Code runs a hook. */
function fireEdit(scratch: string, stamp: string, file: string) {
  const settings = JSON.parse(readFileSync(join(scratch, '.claude', 'settings.json'), 'utf8'));
  const input = JSON.stringify({
    session_id: `bench-test-${Math.random().toString(36).slice(2)}`,
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: join(scratch, file) },
  });
  const env = childEnv(scratch, stamp, target.dir);
  for (const entry of settings.hooks.PreToolUse)
    for (const hook of entry.hooks)
      spawnSync('sh', ['-c', hook.command], { cwd: scratch, input, env, encoding: 'utf8' });
  return readProgress(join(stamp, 'tap.jsonl')).filter(
    (row) => row.registration === 'decisions:scope-brief',
  );
}

describe('fixtures', () => {
  it.each(Object.keys(specs))('%s fails to pass in the bench scratch setup', (id) => {
    expect(validateTask(id)).toEqual([]);
  });

  it('the default plan is 8 clause tasks x 3 arms plus 9 floor tasks x 2 arms', () => {
    expect(planJobs(specs, 5)).toHaveLength(210);
    expect(planJobs(specs, 1).some((job) => specs[job.task].role === 'probe')).toBe(false);
  });
});

describe('delivery parity with the shipped hooks', () => {
  it('copies the hook scripts byte for byte and registers HOOK_REGISTRATIONS.decisions via the tap', () => {
    const scratch = scratchFor(true);
    expect(decisionHookScripts().sort()).toEqual([
      'decision-edit-guard.mjs',
      'decision-scope-brief.mjs',
      'edit-targets-lib.mjs',
    ]);
    for (const name of decisionHookScripts())
      expect(readFileSync(join(scratch, '.claude', 'hooks', name))).toEqual(
        readFileSync(join(packageDir(), 'agents-hooks', name)),
      );
    const settings = JSON.parse(readFileSync(join(scratch, '.claude', 'settings.json'), 'utf8'));
    const tap = join(packageDir(), 'gate-engine', 'decisions', 'eval', 'brief', 'tap.mts');
    const expected: Record<
      string,
      { matcher: string; hooks: { type: string; command: string }[] }[]
    > = {};
    for (const { event, matcher, registrationId, command } of HOOK_REGISTRATIONS.decisions) {
      expect(command).not.toContain("'");
      const tapped = `node '${tap}' '${registrationId}' '${command}'`;
      (expected[event] ??= []).push({ matcher, hooks: [{ type: 'command', command: tapped }] });
    }
    expect(settings).toEqual({ hooks: expected });
  });

  it('a governed edit yields slugs naming the target; an ungoverned file yields none', () => {
    const scratch = scratchFor(true);
    const [governed] = fireEdit(scratch, tempDir('brief-stamp-'), target.file);
    expect(governed).toMatchObject({ tool: 'Edit', rel: target.file, outage: false });
    expect(governed.slugs).toContain(target.slug);
    expect(governed.briefChars).toBeGreaterThan(0);
    const [ungoverned] = fireEdit(scratch, tempDir('brief-stamp-'), 'package.json');
    expect(ungoverned).toMatchObject({ rel: 'package.json', slugs: [], briefChars: 0 });
  });

  it('a stub that exits 1 yields the outage notice and no slugs', () => {
    const scratch = scratchFor(true);
    writeFileSync(join(scratch, 'node_modules', '.bin', 'guard-decisions'), '#!/bin/sh\nexit 1\n');
    const [row] = fireEdit(scratch, tempDir('brief-stamp-'), target.file);
    expect(row).toMatchObject({ outage: true, slugs: [] });
  });
});

describe('stub guard-decisions', () => {
  const stub = (scratch: string, stamp: string, args: string[], extra = {}) =>
    spawnSync(join(scratch, 'node_modules', '.bin', 'guard-decisions'), args, {
      env: { ...childEnv(scratch, stamp, target.dir), ...extra },
      encoding: 'utf8',
    });

  it('answers scoped-targets from brief.json for governed files only, and is silent on --brief-again', () => {
    const scratch = scratchFor(false);
    const stamp = tempDir('brief-stamp-');
    const governed = stub(scratch, stamp, [
      'scoped-targets',
      '--files',
      target.file,
      '--brief',
      'Edit,3,320',
    ]);
    expect(JSON.parse(governed.stdout).map((axis: { slug: string }) => axis.slug)).toContain(
      target.slug,
    );
    const other = stub(scratch, stamp, [
      'scoped-targets',
      '--files',
      'package.json',
      '--brief',
      'Edit,3,320',
    ]);
    expect(JSON.parse(other.stdout)).toEqual([]);
    const again = stub(scratch, stamp, [
      'scoped-targets',
      '--files',
      target.file,
      '--brief-again',
      'Edit,5',
    ]);
    expect(again).toMatchObject({ status: 0, stdout: '' });
  });

  it('shows a known slug, exits 1 on an unknown one, and logs the caller', () => {
    const scratch = scratchFor(false);
    const stamp = tempDir('brief-stamp-');
    const known = stub(scratch, stamp, ['show', target.slug], { BENCH_CALLER: 'hook' });
    expect(known.status).toBe(0);
    expect(known.stdout).toContain(target.bindingText);
    expect(stub(scratch, stamp, ['show', 'no-such-slug']).status).toBe(1);
    const callers = readProgress(join(stamp, 'stub.jsonl')).map((call) => call.caller);
    expect(callers).toEqual(['hook', 'agent']);
  });
});

describe('child process contract', () => {
  it('puts the stub first on PATH, ahead of a global guard-decisions', () => {
    const scratch = scratchFor(false);
    const stamp = tempDir('brief-stamp-');
    const globalBin = tempDir('brief-global-');
    writeFileSync(join(globalBin, 'guard-decisions'), '#!/bin/sh\necho GLOBAL\n', { mode: 0o755 });
    const parent = {
      ...process.env,
      PATH: `${globalBin}:${process.env.PATH}`,
      BENCH_CALLER: 'hook',
    };
    const env = childEnv(scratch, stamp, target.dir, parent);
    expect(env.PATH.startsWith(join(scratch, 'node_modules', '.bin'))).toBe(true);
    const shown = spawnSync('sh', ['-c', `guard-decisions show ${target.slug}`], {
      cwd: scratch,
      env,
      encoding: 'utf8',
    });
    expect(shown.stdout).toContain('**Ruling:**');
    expect(shown.stdout).not.toContain('GLOBAL');
    expect(readProgress(join(stamp, 'stub.jsonl'))).toEqual([
      { caller: 'agent', argv: ['show', target.slug] },
    ]);
  });

  it('forces the isolation env even when the parent disagrees', () => {
    const parent = {
      PATH: '/usr/bin',
      DEVKIT_NO_TELEMETRY: '0',
      DEVKIT_GATE_EVENTS: '/sink.jsonl',
    };
    const env = childEnv('/scratch', '/stamp', '/task', parent);
    expect(env).toMatchObject({
      CLAUDE_PROJECT_DIR: '/scratch',
      DEVKIT_NO_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    });
    expect(env).not.toHaveProperty('DEVKIT_GATE_EVENTS');
  });

  it('passes identical argv in every arm except the read-on allowedTools list', () => {
    const [none, brief, readOn] = (['none', 'brief-only', 'read-on'] as const).map((arm) =>
      childArgv(arm, 'fix it'),
    );
    expect(none).toEqual(brief);
    expect(readOn).toEqual([...brief, '--allowedTools', ...READ_ON_TOOLS]);
    expect(brief).toEqual(
      expect.arrayContaining(['-p', 'fix it', '--model', MODEL, '--strict-mcp-config']),
    );
    expect(readOn.join(' ')).not.toContain('--permission-prompts');
  });
});

describe('checkpoint identity', () => {
  it('gateHash moves with any harness or hook byte and with the decisions registrations', () => {
    const files = gateFiles();
    expect(files.map((file) => basename(file)).sort()).toEqual(
      [
        'bench.mts',
        'decision-edit-guard.mjs',
        'decision-scope-brief.mjs',
        'edit-targets-lib.mjs',
        'stub.mts',
        'tap.mts',
      ].sort(),
    );
    const dir = tempDir('brief-hash-');
    const copies = files.map((file, i) => {
      const copy = join(dir, `${i}-${basename(file)}`);
      copyFileSync(file, copy);
      return copy;
    });
    const seen = new Set([gateHash(copies)]);
    for (const copy of copies) {
      writeFileSync(copy, `${readFileSync(copy, 'utf8')}\n`);
      seen.add(gateHash(copies));
    }
    const [first, ...rest] = HOOK_REGISTRATIONS.decisions;
    seen.add(gateHash(copies, [{ ...first, matcher: 'Edit' }, ...rest]));
    expect(seen.size).toBe(copies.length + 2);
  });

  it('replays a row only under its own hash, and never an outage', () => {
    const dir = tempDir('brief-progress-');
    const open = (hash: string) =>
      openCheckpoint('brief', { config: 'm|v', gateHash: hash, corpusHash: 'c', dir });
    open('old').record({ id: 'a@none#0', got: 0 });
    open('old').record({ id: 'b@none#0', got: 'NULL' });
    expect(open('new').take('a@none#0')).toBeUndefined();
    expect(open('old').take('a@none#0')).toMatchObject({ got: 0 });
    expect(open('old').take('b@none#0')).toBeUndefined();
  });

  it('maps an error result, a non-zero exit, a timeout and a killed check to NULL', () => {
    const check = () => 1;
    const done = { code: 0, json: {}, timedOut: false };
    expect(outcome({ code: 0, json: { is_error: true }, timedOut: false }, check)).toBe('NULL');
    expect(outcome({ code: 1, json: {}, timedOut: false }, check)).toBe('NULL');
    expect(outcome({ code: null, json: null, timedOut: true }, check)).toBe('NULL');
    expect(outcome(done, () => null)).toBe('NULL');
    expect([0, 1, 2, 3].map((status) => outcome(done, () => status))).toEqual([0, 1, 2, 2]);
  });

  it('report reads a progress file whose last line is torn, dropping only that line', () => {
    const dir = tempDir('brief-progress-');
    const hashes = { gateHash: 'g', corpusHash: 'c' };
    openCheckpoint('brief', { config: 'm|v', ...hashes, dir }).record({ id: 'a@none#0', got: 0 });
    const file = join(dir, 'progress-brief.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"sub":"brief","res":{"id":"b@no`);
    expect(progressRows(file, hashes)).toEqual([{ id: 'a@none#0', got: 0 }]);
  });
});

/** K=5 synthetic rows: none-arm clause runs break the rule, everything else keeps it. */
function synthetic(edit: (run: Run) => Partial<Run> = () => ({})): Run[] {
  return planJobs(specs, 5).map((job) => {
    const run: Run = {
      ...job,
      id: rowId(job),
      got: job.arm === 'none' && specs[job.task].role === 'clause' ? 1 : 0,
      editedTarget: job.arm !== 'none',
      briefed: job.arm !== 'none',
      outageNotice: false,
      clauseShown: false,
      agentReads: job.arm === 'read-on' ? 1 : 0,
      model: MODEL,
      claudeVersion: '2.1.296',
    };
    return { ...run, ...edit(run) };
  });
}

describe('scoring', () => {
  it('publishes exactly 4 metrics with a 0.15 noise floor and cells without ok', () => {
    const { baseline, failures } = summarize(synthetic(), 5);
    expect(failures).toEqual([]);
    expect(baseline.metrics.map((metric) => [metric.id, metric.noiseFloor])).toEqual([
      ['clause-kept-brief-only', 0.15],
      ['clause-kept-read-on', 0.15],
      ['floor-good-brief-only', 0.15],
      ['clause-shown-brief-only', 0.15],
    ]);
    expect(Object.keys(baseline.rows)).toHaveLength(42);
    expect(Object.values(baseline.rows).some((cell) => 'ok' in cell)).toBe(false);
    const parsed = parseBaseline('deterministic', baseline);
    expect(parsed.acceptance.accepted).toBe(true);
    expect(parsed.metrics.every((metric) => metric.noiseFloor === 0.15)).toBe(true);
  });

  it.each([
    ['a cell is short of K', (runs: Run[]) => runs.slice(1), /fewer than K=5/],
    [
      'the none-arm clause screen fails',
      (runs: Run[]) => runs.map((run) => (run.arm === 'none' ? { ...run, got: 0 as const } : run)),
      /clause kept above 10%/,
    ],
    [
      'a hook-arm edit got only the outage notice',
      (runs: Run[]) =>
        runs.map((run, i) => (i === 1 ? { ...run, briefed: false, outageNotice: true } : run)),
      /no brief naming the target/,
    ],
    [
      'rows span two claude versions',
      (runs: Run[]) => runs.map((run, i) => (i === 0 ? { ...run, claudeVersion: '2.1.297' } : run)),
      /more than one model or claude version/,
    ],
  ])('floorsMet is false when %s', (_label, mutate, reason) => {
    const { baseline, failures } = summarize(mutate(synthetic()), 5);
    expect(baseline.floorsMet).toBe(false);
    expect(failures.join('\n')).toMatch(reason);
    expect(parseBaseline('deterministic', baseline).acceptance.accepted).toBe(false);
  });
});

describe('report', () => {
  const base = summarize(synthetic(), 5).baseline;
  const better = (run: Run) =>
    run.arm === 'brief-only' ? { got: 0 as const, clauseShown: true } : {};

  it('8 clusters up and none down is improved, with the cluster mid-p', () => {
    const before: Baseline = summarize(
      synthetic((run) =>
        run.arm === 'brief-only' && specs[run.task].role === 'clause' ? { got: 1 } : {},
      ),
      5,
    ).baseline;
    const lines = reportLines(summarize(synthetic(better), 5).baseline, before);
    const row = lines.find((line) => line.startsWith('clause-kept-brief-only'));
    expect(row).toContain(`clusters +8/−0, mid-p ${mcnemarMidP(0, 8).toFixed(3)}`);
    expect(row).toMatch(/Δ 100\.0 pts.*: improved$/);
    expect(lines.find((line) => line.startsWith('clause-kept-read-on'))).toMatch(/: flat$/);
  });

  it('a 25-point gain carried by 2 clusters is flat; the same drop is regressed', () => {
    const readOnKept = (tasks: string[]) => (run: Run) =>
      run.arm === 'read-on' && specs[run.task].role === 'clause' && !tasks.includes(run.task)
        ? { got: 1 as const }
        : {};
    const before = summarize(synthetic(readOnKept([])), 5).baseline;
    const after = summarize(
      synthetic(readOnKept(['q1-abstain-prefusion', 'q2-fallow'])),
      5,
    ).baseline;
    const row = (lines: string[]) => lines.find((line) => line.startsWith('clause-kept-read-on'));
    expect(row(reportLines(after, before))).toMatch(
      /Δ 25\.0 pts, clusters \+2\/−0, mid-p 0\.250: flat$/,
    );
    expect(row(reportLines(before, after))).toMatch(/Δ -25\.0 pts.*: regressed$/);
  });

  it('refuses a contrast across a model or CLI change', () => {
    const head = summarize(
      synthetic(() => ({ claudeVersion: '2.1.300' })),
      5,
    ).baseline;
    expect(() => reportLines(head, base)).toThrow(/model or CLI differs/);
  });
});

describe('run', () => {
  it('without --yes prints the 210-session plan and spawns nothing', async () => {
    const spawnFn = vi.fn();
    const log = vi.fn();
    expect(await runCommand({}, spawnFn, log)).toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/210 sessions \(K=5\)[\s\S]*dry run/);
  });
});
