import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexCommandLines } from '../codex/commands.mts';
import { unwrapCodexResult } from '../codex/result.mts';
import { execJudge, execJudgeAsync } from '../run-judge.mts';

// The item shape codex-rs/exec/src/exec_events.rs emits for `codex exec --json` (CommandExecutionItem).
interface CommandFields {
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
}

function command(event: string, id: string, cmd: string, rest: CommandFields): string {
  const item = { id, type: 'command_execution', command: cmd, aggregated_output: '', ...rest };
  return JSON.stringify({ type: event, item });
}

const PASSING = command('item.completed', 'c1', "bash -lc 'git diff --stat'", {
  aggregated_output: 'SECRET=hunter2',
  exit_code: 0,
  status: 'completed',
});
const FAILING = command('item.completed', 'c2', "bash -lc 'bunx vitest run'", {
  aggregated_output: `FAIL x.test.mts\n${'y'.repeat(5000)}`,
  exit_code: 1,
  status: 'failed',
});
const STARTED = command('item.started', 'c3', "bash -lc 'ps aux'", { status: 'in_progress' });
const VERDICT = JSON.stringify({
  type: 'item.completed',
  item: { id: 'm1', type: 'agent_message', text: 'VERDICT: PASS' },
});
const TURN_FAILED = JSON.stringify({
  type: 'turn.failed',
  error: { message: 'usage limit reached' },
});

// Captured VERBATIM from `codex exec --json` (codex-cli 0.162.1, gpt-5.6-terra, 2026-10-12).
const REAL_STREAM = [
  '{"type":"thread.started","thread_id":"01a12dbb-5a28-7392-8c0a-4e2a74720e2d"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Running the two commands in order."}}',
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello'","aggregated_output":"hello\\n","exit_code":0,"status":"completed"}}`,
  `{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'ls /definitely-missing-dir'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'ls /definitely-missing-dir'","aggregated_output":"ls: /definitely-missing-dir: No such file or directory\\n","exit_code":1,"status":"failed"}}`,
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":57541,"cached_input_tokens":36352,"cache_write_input_tokens":0,"output_tokens":216,"reasoning_output_tokens":34}}',
].join('\n');

describe('codexCommandLines', () => {
  it('reads a real codex stream: started/completed pairs collapse, no whitespace-only tail line', () => {
    expect(codexCommandLines(REAL_STREAM)).toEqual([
      "[exit 0] /bin/zsh -lc 'echo hello'",
      "[exit 1] /bin/zsh -lc 'ls /definitely-missing-dir'\n    ls: /definitely-missing-dir: No such file or directory",
    ]);
    expect(unwrapCodexResult(REAL_STREAM)).toBe('DONE');
  });

  it('lists every command, output only for a failed one and capped at 200 chars', () => {
    const lines = codexCommandLines([PASSING, FAILING, VERDICT].join('\n'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[exit 0] bash -lc 'git diff --stat'");
    expect(lines[1]).toMatch(
      /^\[exit 1\] bash -lc 'bunx vitest run'\n {4}FAIL x\.test\.mts\n {4}y+$/,
    );
    expect(lines[1].length).toBeLessThan(260);
  });

  it('a command the judge was killed during reads as in_progress, superseded once it completes', () => {
    expect(codexCommandLines(STARTED)).toEqual(["[in_progress] bash -lc 'ps aux'"]);
    const done = command('item.completed', 'c3', "bash -lc 'ps aux'", { exit_code: 0 });
    expect(codexCommandLines([STARTED, done].join('\n'))).toEqual(["[exit 0] bash -lc 'ps aux'"]);
  });

  it('leaves the verdict text and non-codex output untouched', () => {
    expect(unwrapCodexResult([PASSING, FAILING, VERDICT].join('\n'))).toBe('VERDICT: PASS');
    expect(codexCommandLines('{"type":"result","result":"VERDICT: PASS"}')).toEqual([]);
  });
});

describe('commands_ref on judge_exec', () => {
  const ENV_KEYS = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'GUARD_CODEX_BIN', 'PATH'];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let sink: string;

  function fakeBin(name: string, lines: string[]): string {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const stream = path.join(dir, `${name}.jsonl`);
    writeFileSync(stream, `${lines.join('\n')}\n`);
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\ncat >/dev/null\ncat '${stream}'\n`, { mode: 0o755 });
    return file;
  }

  interface JudgeExecRow {
    outcome?: string;
    lens?: string;
    transcript_ref?: string;
    commands_ref?: string;
  }

  function lastEvent(): JudgeExecRow {
    const rows = readFileSync(sink, 'utf8').trim().split('\n');
    return JSON.parse(rows[rows.length - 1]);
  }

  function stored(ref: string | undefined): string {
    return readFileSync(path.join(path.dirname(sink), ref ?? 'missing-ref'), 'utf8');
  }

  const codexOpts = {
    label: 'review:correctness-reviewer',
    args: ['-p', 'q', '--model', 'gpt-5'],
    timeout: 20_000,
    codexReadOnly: true,
    transcript: false,
  };

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(path.join(tmpdir(), 'codex-commands-'));
    sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-cmd';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a reviewer with transcript:false still gets its commands stored beside review-<name>.txt', async () => {
    process.env.GUARD_CODEX_BIN = fakeBin('codex-ok', [PASSING, FAILING, VERDICT]);
    const out = await execJudgeAsync({ ...codexOpts, lens: 'concurrency-races' });
    expect(out).toBe('VERDICT: PASS');
    const ev = lastEvent();
    expect(ev).toMatchObject({ outcome: 'ok', lens: 'concurrency-races' });
    expect(ev.transcript_ref).toBeUndefined();
    expect(ev.commands_ref).toBe(
      path.join('transcripts', 'ship-cmd', 'review-correctness-reviewer.commands.txt'),
    );
    const text = stored(ev.commands_ref);
    expect(text).toMatch(/^lens: concurrency-races\n\[exit 0\] .*git diff/);
    expect(text).toContain('vitest run');
    expect(text).not.toContain('hunter2');
  });

  it('a failed turn and a killed judge keep the commands they ran', async () => {
    process.env.GUARD_CODEX_BIN = fakeBin('codex-failed', [FAILING, TURN_FAILED]);
    expect(await execJudgeAsync(codexOpts)).toBeNull();
    expect(lastEvent().outcome).toBe('rate-limited');
    expect(stored(lastEvent().commands_ref)).toContain('[exit 1]');

    const killed = fakeBin('codex-killed', [PASSING, STARTED]);
    writeFileSync(killed, `${readFileSync(killed, 'utf8')}sleep 10\n`);
    process.env.GUARD_CODEX_BIN = killed;
    // Both spawn paths: reviewers run async, where the partial stdout arrives via the callback.
    for (const run of [execJudge, execJudgeAsync]) {
      expect(await run({ ...codexOpts, timeout: 3000 })).toBeNull();
      expect(lastEvent().outcome).toBe('timeout');
      expect(stored(lastEvent().commands_ref)).toContain("[in_progress] bash -lc 'ps aux'");
    }
  });

  it('concurrent lens parts sharing one reviewer label never overwrite each other', async () => {
    process.env.GUARD_CODEX_BIN = fakeBin('codex-lens', [FAILING, VERDICT]);
    const lenses = ['concurrency-races', 'state-transitions'];
    await Promise.all(lenses.map((lens) => execJudgeAsync({ ...codexOpts, lens })));
    const rows = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const refs = rows.map((r: JudgeExecRow) => r.commands_ref);
    expect(new Set(refs).size).toBe(2);
    const headers = refs.map((ref: string | undefined) => stored(ref).split('\n')[0]);
    expect(headers.sort()).toEqual(lenses.map((l) => `lens: ${l}`));
  });

  it('a claude judge stores its tool calls from the event stream, a killed one up to the kill', async () => {
    const use = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
      parent_tool_use_id: null,
    });
    const ran = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET=hunter2' }] },
    });
    const verdict = JSON.stringify({ type: 'result', subtype: 'success', result: 'VERDICT: PASS' });
    process.env.PATH = `${path.join(dir, 'bin')}:${process.env.PATH}`;
    const claude = { label: 'review:x', args: ['-p', 'q'], timeout: 20_000 };
    fakeBin('claude', [use, ran, verdict]);
    expect(execJudge(claude)).toBe('VERDICT: PASS');
    expect(stored(lastEvent().commands_ref)).toBe('[ok] Bash: ls\n');

    // Most judges run tool-less: no call means no sidecar, not an empty file per run.
    fakeBin('claude', [verdict]);
    expect(execJudge(claude)).toBe('VERDICT: PASS');
    expect(lastEvent()).not.toHaveProperty('commands_ref');

    // Exit 0 without a result: an outage, and the stream (file bodies included) is stored nowhere.
    fakeBin('claude', [use, ran]);
    expect(execJudge(claude)).toBeNull();
    expect(lastEvent()).toMatchObject({ outcome: 'transient' });
    expect(lastEvent().transcript_ref).toBeUndefined();

    const killed = fakeBin('claude', [use]);
    writeFileSync(killed, `${readFileSync(killed, 'utf8')}sleep 10\n`);
    for (const run of [execJudge, execJudgeAsync]) {
      expect(await run({ ...claude, timeout: 3000 })).toBeNull();
      expect(lastEvent().outcome).toBe('timeout');
      expect(stored(lastEvent().commands_ref)).toBe('[no result] Bash: ls\n');
    }
  });
});
