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
import { execJudge, execJudgeAsync, recordAgentRun } from '../run-judge.mts';
import { DIFF_HEADER, OUTPUT_HEADER, readTranscript } from '../transcript-store.mts';

const ENV_KEYS = [
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_JUDGE_MCP_CONFIG',
  'DEVKIT_SHIP_ID',
  'GUARD_CODEX_BIN',
  'PATH',
];
const saved: Record<string, string | undefined> = {};
let dir: string;
let sink: string;

// A plain SIGTERM (Node's execFile/execFileSync default killSignal) can be trapped/ignored by the
// child, leaving `timeout` a best-effort request instead of a guaranteed bound. Ignores SIGTERM and
// sleeps well past any cap used below — without a SIGKILL killSignal this would run the full sleep.
const TRAP_AND_SLEEP = "trap '' TERM\nsleep 5\necho SHOULD_NOT_REACH";

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
  it('strictly disables inherited MCP servers for an unprofiled judge', () => {
    fakeClaude('printf \'%s\\n\' "$*"');
    const out = execJudge({
      label: 'detect',
      args: ['-p', 'judge this'],
      timeout: 30000,
    });
    expect(out).toContain('--mcp-config {"mcpServers":{}} --strict-mcp-config');
  });

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

  // sc-2538: a missing binary is `absent`, not `transient` — it is also PERMANENT, so the review
  // cascade stops paying a second spawn to rediscover that the CLI is still not installed.
  it('spawn failure (no claude on PATH) emits an ABSENT outage event, still returns null', () => {
    process.env.PATH = dir; // no claude anywhere on this PATH
    const out = execJudge({
      label: 'vision',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: 30000,
    });
    expect(out).toBeNull();
    const [ev] = events();
    expect(ev).toMatchObject({ type: 'judge_exec', judge: 'vision', outcome: 'absent' });
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
    let preparedFingerprint = '';
    const out = await execJudgeAsync({
      label: 'sentry-advisory',
      args: ['-p', '--model', 'haiku', 'x'],
      input: 'y',
      timeout: 30000,
      onMcpPrepared: (fingerprint) => {
        preparedFingerprint = fingerprint;
      },
    });
    expect(out?.trim()).toBe('SKIP');
    expect(preparedFingerprint).toMatch(/^[a-f0-9]{64}$/);
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
    const out = execJudge({
      label: 'vision',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: 30000,
    });
    expect(out?.trim()).toBe('FIT'); // judge contract untouched by the sink error
  });
});

describe('timeout kill signal (sc-1317)', () => {
  it('async: a child that traps SIGTERM is still killed at the timeout cap', async () => {
    fakeClaude(TRAP_AND_SLEEP);
    const startedAt = Date.now();
    const out = await execJudgeAsync({
      label: 'review:completeness',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: 300,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(out).toBeNull();
    // Well short of the 5s sleep — proves SIGKILL fired rather than a trapped, ignored SIGTERM.
    expect(elapsedMs).toBeLessThan(3000);
    const [ev] = events();
    expect(ev).toMatchObject({ type: 'judge_exec', outcome: 'timeout' });
  });

  it('sync: a child that traps SIGTERM is still killed at the timeout cap', () => {
    fakeClaude(TRAP_AND_SLEEP);
    const startedAt = Date.now();
    const out = execJudge({
      label: 'vision',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: 300,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(out).toBeNull();
    expect(elapsedMs).toBeLessThan(3000);
    const [ev] = events();
    expect(ev).toMatchObject({ type: 'judge_exec', outcome: 'timeout' });
  });

  it('async: output written just before the SIGKILL is discarded, never returned as a verdict', async () => {
    // A killed process still hands the callback whatever partial stdout it had buffered — the code
    // must treat ANY kill as a hard failure (return null) regardless of what's sitting in that
    // buffer, never mistake a truncated-but-plausible-looking verdict for a real one.
    fakeClaude("trap '' TERM\necho 'VERDICT: PASS - looks fine'\nsleep 5\necho SHOULD_NOT_REACH");
    const out = await execJudgeAsync({
      label: 'review:completeness',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: 300,
    });
    expect(out).toBeNull();
  });

  it('two concurrent timed-out calls resolve independently with correctly attributed telemetry', async () => {
    // Mirrors the review gate's real shape (run-review.mts fans out one execJudgeAsync per domain
    // reviewer concurrently) — a shared module-level kill path must not let one call's timeout
    // block/misattribute another's outcome.
    fakeClaude(TRAP_AND_SLEEP);
    const startedAt = Date.now();
    const [a, b] = await Promise.all([
      execJudgeAsync({
        label: 'review:api-security-reviewer',
        args: ['-p', '--model', 'opus', 'x'],
        input: 'y',
        timeout: 300,
      }),
      execJudgeAsync({
        label: 'review:correctness-reviewer',
        args: ['-p', '--model', 'opus', 'x'],
        input: 'y',
        timeout: 300,
      }),
    ]);
    const elapsedMs = Date.now() - startedAt;
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(elapsedMs).toBeLessThan(3000); // both killed promptly, not serialized behind the 5s sleep
    const evs = events().filter((e) => e.type === 'judge_exec');
    expect(evs).toHaveLength(2);
    expect(evs.every((e) => e.outcome === 'timeout')).toBe(true);
    const judges = evs.map((e) => e.judge).sort();
    expect(judges).toEqual(['review:api-security-reviewer', 'review:correctness-reviewer']);
  });
});

describe('timeout boundary values (sc-1317 follow-up)', () => {
  it('async: an out-of-range timeout (-1) resolves null instead of rejecting the promise', async () => {
    // execFile validates `timeout` and THROWS SYNCHRONOUSLY for a negative value; unlike its sync
    // twin (wrapped in try/catch), execJudgeAsync had no guard around the execFile() call itself, so
    // that synchronous throw became a REJECTED promise — breaking the documented "never throws,
    // always resolves null" contract for any caller that awaits it without its own try/catch (e.g.
    // completeness.mts's `await exec(...)`, which sits outside its own try/catch block).
    fakeClaude('echo FIT');
    await expect(
      execJudgeAsync({
        label: 'vision',
        args: ['-p', '--model', 'opus', 'x'],
        input: 'y',
        timeout: -1,
      }),
    ).resolves.toBeNull();
  });

  it('sync: an out-of-range timeout (-1) returns null instead of throwing', () => {
    fakeClaude('echo FIT');
    expect(() =>
      execJudge({
        label: 'vision',
        args: ['-p', '--model', 'opus', 'x'],
        input: 'y',
        timeout: -1,
      }),
    ).not.toThrow();
  });

  it('timeout: 0 disables the cap (Node semantics) rather than killing instantly', async () => {
    fakeClaude('echo FIT');
    const out = await execJudgeAsync({
      label: 'vision',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: 0,
    });
    expect(out?.trim()).toBe('FIT');
  });

  it('timeout: Number.MAX_SAFE_INTEGER overflows Node\'s 32-bit timer to ~1ms, not "no timeout"', async () => {
    // A caller who thinks "pass a huge number" is a safe way to soften/disable the cap gets the
    // OPPOSITE of what they intended: Node silently clamps an out-of-32-bit-range delay and kills
    // almost immediately. Documented here so nobody relies on that assumption.
    fakeClaude(TRAP_AND_SLEEP); // would run the full 5s if the timeout were honored as "huge"
    const startedAt = Date.now();
    const out = await execJudgeAsync({
      label: 'vision',
      args: ['-p', '--model', 'opus', 'x'],
      input: 'y',
      timeout: Number.MAX_SAFE_INTEGER,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(out).toBeNull();
    expect(elapsedMs).toBeLessThan(3000);
  });
});

/**
 * `recordAgentRun` is the same contract reached WITHOUT a spawn — the entry point for an agent the
 * assistant dispatched itself (prior-art via the Task tool), which no gate ever execs.
 */
describe('recordAgentRun', () => {
  it('emits one judge_exec and stores a transcript the ref resolves to', () => {
    const ref = recordAgentRun({
      label: 'prior-art',
      output: '{"verdict":"DISSOLVE_FRAME"}',
      model: 'opus',
      durationMs: 42_000,
    });
    const [ev, ...rest] = events();
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({
      type: 'judge_exec',
      judge: 'prior-art',
      model: 'opus',
      outcome: 'ok',
      duration_ms: 42_000,
      output_chars: 28,
    });
    expect(ref).toBe(ev?.transcript_ref);
    // The ref must resolve through the SAME reader `guard-review transcript <ref>` uses.
    expect(readTranscript(ref as string)).toContain('{"verdict":"DISSOLVE_FRAME"}');
  });

  it('carries extra keys (the disposition label) without letting them shadow the core shape', () => {
    recordAgentRun({
      label: 'prior-art',
      output: 'x',
      extra: {
        disposition: 'overridden',
        disposition_reason: 'root agent disagreed',
        judge: 'spoof',
      },
    });
    expect(events()[0]).toMatchObject({
      judge: 'prior-art', // core wins — a caller cannot relabel the run out from under the dashboard
      disposition: 'overridden',
      disposition_reason: 'root agent disagreed',
    });
  });

  it('omits duration_ms entirely when unknown, rather than emitting a misleading 0', () => {
    recordAgentRun({ label: 'prior-art', output: 'x' });
    expect(events()[0]).not.toHaveProperty('duration_ms');
  });

  it('classifies a no-output run as empty, never as a silent ok', () => {
    // A blanket 'ok' default would make a dead run indistinguishable from a real success except by
    // inferring from the absent transcript_ref, inflating the label's success rate.
    const ref = recordAgentRun({ label: 'prior-art', model: 'opus' });
    expect(ref).toBeNull();
    expect(events()[0]).toMatchObject({ judge: 'prior-art', outcome: 'empty', output_chars: 0 });
    expect(events()[0]).not.toHaveProperty('transcript_ref');
  });

  it('treats a whitespace-only response as empty — the same predicate execJudge applies', () => {
    expect(recordAgentRun({ label: 'prior-art', output: '  \n\t ' })).toBeNull();
    expect(events()[0]).toMatchObject({ outcome: 'empty' });
  });

  it('an explicit outcome still wins over the derived one', () => {
    recordAgentRun({ label: 'prior-art', output: 'x', outcome: 'transient' });
    expect(events()[0]).toMatchObject({ outcome: 'transient' });
  });

  it('is a silent no-op with no sink — telemetry off must never be an error path', () => {
    // vitest.setup already holds DEVKIT_NO_TELEMETRY=1 suite-wide; dropping the explicit sink is
    // what takes telemetrySink() to undefined. Never restore that env here — afterEach only tracks
    // ENV_KEYS, so clearing it would leak an opted-IN default into every later test file.
    delete process.env.DEVKIT_GATE_EVENTS;
    expect(recordAgentRun({ label: 'prior-art', output: 'x' })).toBeNull();
    expect(events()).toEqual([]);
  });
});

/**
 * sc-1527 — the spend ledger. These spawn a real subprocess through the same fake-`claude` path as
 * the success tests above, so the whole argv → envelope → unwrap → emit pipeline runs rather than a
 * mocked slice of it.
 */
describe('judge spend capture', () => {
  const ENVELOPE = JSON.stringify({
    type: 'result',
    result: 'checked\nVERDICT: PASS',
    session_id: 'sess-abc',
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
    },
  });

  it('records tokens, cost and session_id on the judge_exec line', async () => {
    fakeClaude(`cat <<'EOF'\n${ENVELOPE}\nEOF`);
    await execJudgeAsync({ label: 'review:x', args: ['-p', 'q'], timeout: 20_000 });
    expect(events()[0]).toMatchObject({
      type: 'judge_exec',
      judge: 'review:x',
      outcome: 'ok',
      input_tokens: 11,
      output_tokens: 22,
      cache_creation: 33,
      cache_read: 44,
      cost_usd: 0.25,
      session_id: 'sess-abc',
    });
  });

  // The contract that keeps every existing caller working: the envelope is an implementation detail
  // of the spawn layer, so callers still parse the verdict text they always did.
  it('returns the unwrapped verdict text, never the JSON envelope', async () => {
    fakeClaude(`cat <<'EOF'\n${ENVELOPE}\nEOF`);
    const out = await execJudgeAsync({ label: 'review:x', args: ['-p', 'q'], timeout: 20_000 });
    expect(out).toBe('checked\nVERDICT: PASS');
    expect(out).not.toContain('total_cost_usd');
  });

  it('transcript + output_chars follow the verdict text, not the envelope bytes', async () => {
    fakeClaude(`cat <<'EOF'\n${ENVELOPE}\nEOF`);
    await execJudgeAsync({ label: 'review:x', args: ['-p', 'q'], timeout: 20_000 });
    expect(events()[0]).toMatchObject({ output_chars: 'checked\nVERDICT: PASS'.length });
  });

  it('the sync twin captures spend identically', () => {
    fakeClaude(`cat <<'EOF'\n${ENVELOPE}\nEOF`);
    const out = execJudge({ label: 'decisions:y', args: ['-p', 'q'], timeout: 20_000 });
    expect(out).toBe('checked\nVERDICT: PASS');
    expect(events()[0]).toMatchObject({ judge: 'decisions:y', cost_usd: 0.25, input_tokens: 11 });
  });

  // A judge that works must not start failing because its accounting could not be read.
  it('bare text still succeeds, and books NO usage rather than a free-looking zero', async () => {
    fakeClaude("echo 'VERDICT: PASS'");
    const out = await execJudgeAsync({ label: 'review:x', args: ['-p', 'q'], timeout: 20_000 });
    expect(out).toBe('VERDICT: PASS\n');
    const event = events()[0];
    expect(event).toMatchObject({ outcome: 'ok' });
    expect(event).not.toHaveProperty('cost_usd');
    expect(event).not.toHaveProperty('input_tokens');
  });

  it('an outage books no spend — there was none', async () => {
    process.env.PATH = ''; // spawn ENOENTs deterministically
    await execJudgeAsync({ label: 'review:x', args: ['-p', 'q'], timeout: 20_000 });
    const event = events()[0];
    expect(event).toMatchObject({ outcome: 'absent' });
    expect(event).not.toHaveProperty('cost_usd');
  });
});

describe('judge_exec usage on failure outcomes', () => {
  const ENVELOPE = JSON.stringify({
    type: 'result',
    result: 'VERDICT: PASS',
    usage: {
      input_tokens: 111,
      output_tokens: 22,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    },
    total_cost_usd: 0.5,
    session_id: 'sess-1',
  });

  it('sync: a non-zero exit that already printed its envelope books the spend on the transient row', () => {
    fakeClaude(`printf '%s' '${ENVELOPE}'\nexit 1`);
    const out = execJudge({ label: 'review:x', args: ['-p', 'q'], timeout: 20_000 });
    expect(out).toBeNull();
    const [ev] = events();
    expect(ev).toMatchObject({
      outcome: 'transient',
      input_tokens: 111,
      output_tokens: 22,
      cost_usd: 0.5,
      session_id: 'sess-1',
    });
  });

  it('sync: the SIGKILL at the cap salvages usage from the partial stdout on the timeout row', () => {
    fakeClaude(`printf '%s' '${ENVELOPE}'\ntrap '' TERM\nsleep 5`);
    const out = execJudge({ label: 'review:x', args: ['-p', 'q'], timeout: 700 });
    expect(out).toBeNull();
    const [ev] = events();
    expect(ev).toMatchObject({ outcome: 'timeout', input_tokens: 111, cost_usd: 0.5 });
  });

  it('async: the callback error path books the spend from its own stdout argument', async () => {
    fakeClaude(`printf '%s' '${ENVELOPE}'\nexit 1`);
    const out = await execJudgeAsync({ label: 'review:x', args: ['-p', 'q'], timeout: 20_000 });
    expect(out).toBeNull();
    const [ev] = events();
    expect(ev).toMatchObject({ outcome: 'transient', input_tokens: 111, output_tokens: 22 });
  });

  // The stream's own `turn.failed` message is now CLASSIFIED rather than assumed transient — this
  // fixture's "usage limit reached" is the exact wording the sc-2538 outage produced.
  it('codex: a failed turn whose stream carries turn.completed still books its usage', async () => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, 'codex-fake');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'cat >/dev/null',
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":5,"output_tokens":20,"reasoning_output_tokens":30}}'`,
        `printf '%s\\n' '{"type":"turn.failed","error":{"message":"usage limit reached"}}'`,
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.GUARD_CODEX_BIN = fake;
    const out = await execJudgeAsync({
      label: 'review:x',
      args: ['-p', 'q', '--model', 'gpt-5'],
      timeout: 20_000,
      codexReadOnly: true,
    });
    expect(out).toBeNull();
    const [ev] = events();
    // Codex semantics: input minus cached; output folds reasoning in; subscription billing.
    expect(ev).toMatchObject({
      outcome: 'rate-limited',
      input_tokens: 60,
      output_tokens: 50,
      cache_read: 40,
      billing: 'subscription',
    });
  });

  it('the lens field rides the event beside the shared reviewer label', () => {
    fakeClaude('echo FIT');
    execJudge({
      label: 'review:correctness-reviewer',
      args: ['-p', 'q'],
      timeout: 20_000,
      lens: 'concurrency-races',
    });
    const [ev] = events();
    expect(ev).toMatchObject({
      judge: 'review:correctness-reviewer',
      outcome: 'ok',
      lens: 'concurrency-races',
    });
  });
});
