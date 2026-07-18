/**
 * The exec-level `judge_exec` telemetry contract: every `claude -p` invocation through
 * execJudge/execJudgeAsync appends ONE spend/outage line to the gate-events sink, and (opt-in)
 * persists the input+output transcript — regardless of whether the calling gate has its own
 * gate-level emitter. Uses the same ship-path envs as gate-events.test.mts (vitest.setup sets
 * DEVKIT_NO_TELEMETRY=1 suite-wide, so DEVKIT_GATE_EVENTS + DEVKIT_SHIP_ID opt these tests in).
 *
 * The success path spawns a real subprocess via a fake `claude` on a prepended PATH (the judge
 * binary name is hardcoded), so the whole exec→emit pipeline runs; outage paths strip PATH so the
 * spawn ENOENTs deterministically.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execJudge, execJudgeAsync } from '../run-judge.mts';
import { DIFF_HEADER, OUTPUT_HEADER } from '../transcript-store.mts';

const ENV_KEYS = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'PATH'];
const saved: Record<string, string | undefined> = {};
let dir: string;
let sink: string;

function fakeClaude(script: string): void {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'claude');
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\n${script}`, { mode: 0o755 });
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

function events(): Record<string, unknown>[] {
  try {
    return readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(path.join(tmpdir(), 'judge-exec-telemetry-'));
  writeFileSync(path.join(dir, 'seed'), ''); // mkdtemp only; keeps dir non-empty on some tmpfs
  sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-jx';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('judge_exec telemetry', () => {
  it('success emits one ok event with model/duration/sizes AND a transcript by default', () => {
    fakeClaude('echo FIT');
    const out = execJudge({
      label: 'vision',
      args: ['-p', '--model', 'opus', 'judge this'],
      input: 'CHANGED PATHS:\nx.ts',
      timeout: 30000,
    });
    expect(out?.trim()).toBe('FIT');
    const [ev] = events();
    expect(ev).toMatchObject({
      type: 'judge_exec',
      judge: 'vision',
      model: 'opus',
      outcome: 'ok',
      ship_id: 'ship-jx',
    });
    expect(typeof ev.duration_ms).toBe('number');
    expect(ev.input_chars).toBe('CHANGED PATHS:\nx.ts'.length);
    expect(ev.output_chars).toBeGreaterThan(0);
    expect(typeof ev.transcript_ref).toBe('string'); // collected by default
  });

  it('transcript: false suppresses the transcript (gates with their own gate-level store)', () => {
    fakeClaude('echo FIT');
    execJudge({
      label: 'review:api-security-reviewer',
      args: ['-p', '--model', 'haiku', 'x'],
      input: 'y',
      timeout: 30000,
      transcript: false,
    });
    const [ev] = events();
    expect(ev.outcome).toBe('ok');
    expect(ev.transcript_ref).toBeUndefined();
  });

  it('default transcript persists input+output and stamps transcript_ref', () => {
    fakeClaude('echo OUT');
    execJudge({
      label: 'sentry-advisory',
      args: ['-p', '--model', 'haiku', 'judge'],
      input: 'the diff body',
      timeout: 30000,
    });
    const [ev] = events();
    expect(typeof ev.transcript_ref).toBe('string');
    const stored = readFileSync(path.join(path.dirname(sink), ev.transcript_ref as string), 'utf8');
    expect(stored).toContain(DIFF_HEADER);
    expect(stored).toContain('the diff body');
    expect(stored).toContain(OUTPUT_HEADER);
    expect(stored).toContain('OUT');
  });

  it('spawn failure (no claude on PATH) emits a transient outage event, still returns null', () => {
    process.env.PATH = dir; // no claude anywhere on this PATH
    const out = execJudge({ label: 'vision', args: ['-p', '--model', 'opus', 'x'], input: 'y' });
    expect(out).toBeNull();
    const [ev] = events();
    expect(ev).toMatchObject({ type: 'judge_exec', judge: 'vision', outcome: 'transient' });
    expect(ev.transcript_ref).toBeUndefined();
  });

  it('empty output emits an empty-outcome event', async () => {
    fakeClaude('printf ""');
    const out = await execJudgeAsync({
      label: 'review:completeness',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: 30000,
    });
    expect(out).toBeNull();
    const [ev] = events();
    expect(ev).toMatchObject({
      type: 'judge_exec',
      outcome: 'empty',
      judge: 'review:completeness',
    });
  });

  it('async success emits ok exactly once', async () => {
    fakeClaude('echo SKIP');
    const out = await execJudgeAsync({
      label: 'sentry-advisory',
      args: ['-p', '--model', 'haiku', 'x'],
      input: 'y',
      timeout: 30000,
    });
    expect(out?.trim()).toBe('SKIP');
    const evs = events().filter((e) => e.type === 'judge_exec');
    expect(evs).toHaveLength(1);
    expect(evs[0].outcome).toBe('ok');
  });

  it('repeated labels (multi-sample vote) store one transcript PER sample — no misattribution', () => {
    fakeClaude('echo "MONITOR sample-$$"'); // $$ = pid → distinct output per invocation
    const opts = {
      label: 'sentry-advisory',
      args: ['-p', '--model', 'haiku', 'x'],
      input: 'the diff',
      timeout: 30000,
      transcript: true,
    };
    execJudge(opts);
    execJudge(opts);
    const evs = events().filter((e) => e.type === 'judge_exec');
    expect(evs).toHaveLength(2);
    const refs = evs.map((e) => e.transcript_ref as string);
    expect(refs[0]).not.toBe(refs[1]); // distinct files, not a shared overwritten one
    const base = path.dirname(sink);
    const bodies = refs.map((r) => readFileSync(path.join(base, r), 'utf8'));
    expect(bodies[0]).not.toBe(bodies[1]); // each event resolves to ITS OWN sample's output
  });

  it('a transcript already on disk (prior PROCESS, same run id) is never overwritten', () => {
    // Simulates the retried/amended-commit interleaving: process P1 wrote the bare-label file and
    // its event line durably references it; this process (P2, fresh state) must land elsewhere.
    const existing = path.join(path.dirname(sink), 'transcripts', 'ship-jx', 'vision.txt');
    mkdirSync(path.dirname(existing), { recursive: true });
    writeFileSync(existing, 'P1 output — referenced by an already-appended event');
    fakeClaude('echo FIT');
    execJudge({
      label: 'vision',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'p2 diff',
      timeout: 30000,
      transcript: true,
    });
    expect(readFileSync(existing, 'utf8')).toContain('P1 output'); // untouched
    const [ev] = events();
    expect(ev.transcript_ref).not.toBe(path.join('transcripts', 'ship-jx', 'vision.txt'));
    const stored = readFileSync(path.join(path.dirname(sink), ev.transcript_ref as string), 'utf8');
    expect(stored).toContain('p2 diff');
  });

  it('telemetry failure never breaks the judge (unwritable sink)', () => {
    const notADir = path.join(dir, 'file');
    writeFileSync(notADir, 'x');
    process.env.DEVKIT_GATE_EVENTS = path.join(notADir, 'events.jsonl');
    fakeClaude('echo FIT');
    const out = execJudge({ label: 'vision', args: ['-p', '--model', 'opus', 'x'], input: 'y' });
    expect(out?.trim()).toBe('FIT'); // judge contract untouched by the sink error
  });
});
