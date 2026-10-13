/**
 * A headless claude judge whose tool call is refused exits 0 and says so only in prose. The spawn
 * layer reads the envelope's `permission_denials` so the refusal is measured, not inferred.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execJudge, execJudgeAsync } from '../run-judge.mts';

const ENV_KEYS = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'PATH'];
const saved: Record<string, string | undefined> = {};
let dir: string;
let sink: string;

const denial = (command: string) => ({
  tool_name: 'Bash',
  tool_use_id: 'toolu_x',
  tool_input: { command },
});

/** A `claude` on PATH that prints one result envelope, or `bare` text when no envelope is given. */
function fakeClaude(permissionDenials?: unknown[], bare?: string): void {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const out = path.join(dir, 'stdout.txt');
  writeFileSync(
    out,
    bare ??
      JSON.stringify({
        type: 'result',
        result: 'no findings\nVERDICT: PASS',
        permission_denials: permissionDenials,
      }),
  );
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\ncat '${out}'\n`, {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${saved.PATH}`;
}

interface JudgeExecRow {
  type?: string;
  outcome?: string;
  permission_denials?: number;
  denials_ref?: string;
}

function rows(): JudgeExecRow[] {
  return readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

const stored = (ref: string | undefined): string =>
  readFileSync(path.join(path.dirname(sink), ref ?? 'missing-ref'), 'utf8');

const opts = {
  label: 'review:correctness-reviewer',
  args: ['-p', 'q', '--model', 'claude-haiku-5-5'],
  timeout: 20_000,
  transcript: false,
};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(path.join(tmpdir(), 'permission-denials-'));
  sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-denied';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('permission denials on a claude judge spawn', () => {
  const ABSOLUTE = 'node /abs/.claude/skills/correctness/scripts/checklist.mjs generate';

  it('both spawn paths hand the refused calls to the caller before they return the verdict', async () => {
    fakeClaude([denial(ABSOLUTE), denial('vitest run')]);
    for (const run of [execJudge, execJudgeAsync]) {
      let heard: string[] | undefined;
      const text = await run({ ...opts, onPermissionDenials: (denied) => (heard = denied) });
      expect(text).toBe('no findings\nVERDICT: PASS');
      expect(heard).toEqual([`Bash: ${ABSOLUTE}`, 'Bash: vitest run']);
    }
  });

  it('judge_exec carries the count and a sidecar ref, never the command text', async () => {
    fakeClaude([denial(ABSOLUTE)]);
    await execJudgeAsync({ ...opts, lens: 'state-transitions' });
    const [row] = rows();
    expect(row).toMatchObject({ type: 'judge_exec', outcome: 'ok', permission_denials: 1 });
    expect(row.denials_ref).toBe(
      path.join('transcripts', 'ship-denied', 'review-correctness-reviewer.denied.txt'),
    );
    expect(JSON.stringify(row)).not.toContain('checklist.mjs');
    expect(stored(row.denials_ref)).toBe(`lens: state-transitions\nBash: ${ABSOLUTE}\n`);
  });

  // The sink appends atomically only under 4096 bytes: bound the row itself, not the element count.
  it('twenty long refusals leave the judge_exec row small', async () => {
    fakeClaude(Array.from({ length: 20 }, (_, i) => denial(`node /${'p'.repeat(400)}/${i}.mjs`)));
    await execJudgeAsync(opts);
    expect(rows()[0].permission_denials).toBe(20);
    expect(Buffer.byteLength(readFileSync(sink, 'utf8'))).toBeLessThan(1024);
    expect(stored(rows()[0].denials_ref).trim().split('\n')).toHaveLength(20);
  });

  it('a spawn that refused nothing records a measured zero and stores no sidecar', async () => {
    fakeClaude([]);
    let heard: string[] | undefined;
    await execJudgeAsync({ ...opts, onPermissionDenials: (denied) => (heard = denied) });
    expect(heard).toEqual([]);
    expect(rows()[0].permission_denials).toBe(0);
    expect(rows()[0]).not.toHaveProperty('denials_ref');
  });

  // A plain commit can run with no telemetry sink; the gate's reason must not depend on one.
  it('with telemetry off the caller still hears the refused calls', async () => {
    fakeClaude([denial(ABSOLUTE)]);
    delete process.env.DEVKIT_GATE_EVENTS;
    delete process.env.DEVKIT_SHIP_ID;
    let heard: string[] | undefined;
    await execJudgeAsync({ ...opts, onPermissionDenials: (denied) => (heard = denied) });
    expect(heard).toEqual([`Bash: ${ABSOLUTE}`]);
  });

  it('concurrent lens parts sharing one judge label keep separate sidecars', async () => {
    fakeClaude([denial(ABSOLUTE)]);
    const lenses = ['concurrency-races', 'state-transitions'];
    await Promise.all(lenses.map((lens) => execJudgeAsync({ ...opts, lens })));
    const refs = rows().map((row) => row.denials_ref);
    expect(new Set(refs).size).toBe(2);
    expect(refs.map((ref) => stored(ref).split('\n')[0]).sort()).toEqual(
      lenses.map((lens) => `lens: ${lens}`),
    );
  });

  it('output without a denial list is not measured: no field, no callback', async () => {
    fakeClaude(undefined, 'VERDICT: PASS');
    let fired = false;
    expect(await execJudgeAsync({ ...opts, onPermissionDenials: () => (fired = true) })).toBe(
      'VERDICT: PASS',
    );
    expect(fired).toBe(false);
    expect(rows()[0]).not.toHaveProperty('permission_denials');
  });
});
