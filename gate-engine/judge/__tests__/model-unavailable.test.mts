/** A refused MODEL (codex's 400 on a ChatGPT free plan) is a permanent outage of its own kind:
 *  never retried, recorded on judge_exec, remedied by moving the model rather than auth/quota. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyJudgeOutage, type JudgeOutage } from '../outage/classify.mts';
import { remedyCause, strictRemedy, unavailableMessage } from '../outage/wording.mts';
import { execJudge, execJudgeAsync } from '../run-judge.mts';

/** codex 0.162.1's stderr, verbatim, when a free plan asks for gpt-5.6-sol. */
const REFUSAL =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}';

describe('classifyJudgeOutage — model refused by the plan', () => {
  it('reads the real 400 as model-unavailable, permanent, with the provider sentence kept', () => {
    const outage = classifyJudgeOutage({ status: 1, stderr: REFUSAL });
    expect(outage).toMatchObject({ kind: 'model-unavailable', permanent: true });
    expect(outage.detail).toContain('is not supported when using Codex');
  });

  it.each([
    'Error: model_not_found',
    'The model `gpt-x` does not exist or you do not have access to it.',
  ])('matches the not-found wording too: %s', (stderr) => {
    expect(classifyJudgeOutage({ status: 1, stderr }).kind).toBe('model-unavailable');
  });

  it('a usage limit still wins: its reset time is the remedy that works', () => {
    const stderr = `You've hit your usage limit. ${REFUSAL}`;
    expect(classifyJudgeOutage({ status: 1, stderr }).kind).toBe('rate-limited');
  });
});

/** claude 2.1.302, verbatim, for `-p --output-format json --model claude-nonexistent-9-9`
 *  (usage fields trimmed). */
const CLAUDE_SENTENCE =
  "There's an issue with the selected model (claude-nonexistent-9-9). It may not exist or you may not have access to it.";
const claudeEnvelope = (over: { api_error_status?: number; result?: string } = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 404,
    total_cost_usd: 0,
    result: CLAUDE_SENTENCE,
    ...over,
  });
const CLAUDE_ENVELOPE = claudeEnvelope();
const CLAUDE_STDERR =
  '[claude-code:unrecognized_model] {"model":"claude-nonexistent-9-9","query_source":"sdk"}\n';
const DIFF = 'diff --git a/src/secret.ts b/src/secret.ts\n+const token = "do-not-leak";';

describe('classifyJudgeOutage — claude refuses the model', () => {
  it('reads the 404 envelope as model-unavailable, retryable, detail = the sentence alone', () => {
    const outage = classifyJudgeOutage({
      status: 1,
      stdout: CLAUDE_ENVELOPE,
      stderr: CLAUDE_STDERR,
    });
    expect(outage).toEqual({
      kind: 'model-unavailable',
      permanent: false,
      detail: CLAUDE_SENTENCE,
    });
  });

  it('another api status is never read, so its result text cannot reach telemetry', () => {
    const stdout = claudeEnvelope({ api_error_status: 500, result: `${DIFF}\n${CLAUDE_SENTENCE}` });
    const outage = classifyJudgeOutage({ status: 1, stdout, stderr: CLAUDE_STDERR });
    expect(outage.kind).toBe('transient');
    expect(outage.detail).not.toContain('do-not-leak');
  });

  // Outside the envelope the sentence must not reach the permanent regex: it would skip the retry.
  it('the sentence on stderr alone is never a permanent model refusal', () => {
    const outage = classifyJudgeOutage({ status: 1, stderr: CLAUDE_SENTENCE });
    expect(outage).toMatchObject({ kind: 'transient', permanent: false });
  });

  it('plain stdout carrying the sentence and a diff is ignored', () => {
    const outage = classifyJudgeOutage({ status: 1, stdout: `${DIFF}\n${CLAUDE_SENTENCE}` });
    expect(outage.kind).toBe('transient');
    expect(outage.detail).toBeUndefined();
  });

  it('the claude remedy promises no preflight list and no hopeless re-run', () => {
    const remedy = strictRemedy('model-unavailable', 'claude');
    expect(remedy).toContain('may not exist or the account cannot use it');
    expect(remedy).not.toMatch(/ship preflight|re-running cannot succeed|auth\/quota/);
    const line = unavailableMessage('review:x', { status: 1, stdout: CLAUDE_ENVELOPE }, 1000);
    expect(line).toContain('the model may not exist or the account cannot use it');
  });
});

describe('model-unavailable wording', () => {
  const outage: JudgeOutage = { kind: 'model-unavailable', permanent: true };

  it('maps to its own remedy cause, which names neither auth/quota nor a re-run', () => {
    expect(remedyCause(outage)).toBe('model-unavailable');
    const remedy = strictRemedy('model-unavailable', 'codex');
    expect(remedy).toContain('plan does not serve it, so re-running cannot succeed');
    expect(remedy).toContain('ship preflight');
    expect(remedy).not.toMatch(/auth\/quota|transient/);
  });

  it('the stderr warning says the plan does not serve the model', () => {
    const line = unavailableMessage(
      'review:correctness',
      { status: 1, stderr: REFUSAL },
      1000,
      'codex',
    );
    expect(line).toContain('plan does not serve this model');
    expect(line).not.toContain('offline/quota/absent');
  });
});

/** The judge_exec fields these tests read from the telemetry sink. */
interface JudgeExecEvent {
  type: string;
  outcome: string;
  model?: string;
  outage_detail?: string;
}

describe('model-unavailable through execJudge', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'PATH'];
  let dir: string;
  let sink: string;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(path.join(tmpdir(), 'model-unavailable-'));
    sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-mu';
    process.env.PATH = `${path.join(dir, 'bin')}:${process.env.PATH}`;
  });

  /** A fake `claude` that prints these streams verbatim and exits 1. */
  function fakeClaude(stdout: string, stderr: string): void {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(dir, 'out.txt'), stdout);
    writeFileSync(path.join(dir, 'err.txt'), stderr);
    const fake = path.join(bin, 'claude');
    writeFileSync(
      fake,
      `#!/bin/sh\ncat >/dev/null\ncat '${dir}/out.txt'\ncat '${dir}/err.txt' >&2\nexit 1`,
    );
    chmodSync(fake, 0o755);
  }

  function judgeExecEvent(): JudgeExecEvent {
    const [ev] = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    return ev;
  }
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('persists the kind and excerpt to judge_exec, and hands the refused model to the caller', () => {
    fakeClaude('', `${REFUSAL}\n`);
    const seen: JudgeOutage[] = [];
    const out = execJudge({
      label: 'review:correctness',
      args: ['-p', '--model', 'opus', 'q'],
      timeout: 20_000,
      onOutage: (o) => seen.push(o),
    });
    expect(out).toBeNull();
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'model-unavailable', permanent: true, model: 'opus' }),
    ]);
    expect(judgeExecEvent()).toMatchObject({
      type: 'judge_exec',
      outcome: 'model-unavailable',
      model: 'opus',
      outage_detail: expect.stringContaining('is not supported'),
    });
  });

  it('a claude 404 refusal lands as model-unavailable with only the CLI sentence as detail', () => {
    fakeClaude(`${CLAUDE_ENVELOPE}\n`, CLAUDE_STDERR);
    const seen: JudgeOutage[] = [];
    const out = execJudge({
      label: 'review:correctness',
      args: ['-p', '--model', 'claude-nonexistent-9-9', 'q'],
      timeout: 20_000,
      onOutage: (o) => seen.push(o),
    });
    expect(out).toBeNull();
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'model-unavailable', permanent: false }),
    ]);
    expect(judgeExecEvent()).toMatchObject({
      outcome: 'model-unavailable',
      model: 'claude-nonexistent-9-9',
      outage_detail: CLAUDE_SENTENCE,
    });
  });

  // The review cascade fans out through the async twin, which hands stdout beside the error.
  it('the async twin classifies the same claude refusal identically', async () => {
    fakeClaude(`${CLAUDE_ENVELOPE}\n`, CLAUDE_STDERR);
    const seen: JudgeOutage[] = [];
    const out = await execJudgeAsync({
      label: 'review:correctness',
      args: ['-p', '--model', 'claude-nonexistent-9-9', 'q'],
      timeout: 20_000,
      onOutage: (o) => seen.push(o),
    });
    expect(out).toBeNull();
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'model-unavailable', permanent: false }),
    ]);
    expect(judgeExecEvent()).toMatchObject({
      outcome: 'model-unavailable',
      outage_detail: CLAUDE_SENTENCE,
    });
  });

  // The async twin reads stderr from its execFile callback, not from the thrown error.
  it('the async twin classifies a stderr-only refusal identically', async () => {
    fakeClaude('', `${REFUSAL}\n`);
    const seen: JudgeOutage[] = [];
    const out = await execJudgeAsync({
      label: 'review:correctness',
      args: ['-p', '--model', 'opus', 'q'],
      timeout: 20_000,
      onOutage: (o) => seen.push(o),
    });
    expect(out).toBeNull();
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'model-unavailable', permanent: true, model: 'opus' }),
    ]);
    expect(judgeExecEvent()).toMatchObject({
      outcome: 'model-unavailable',
      outage_detail: expect.stringContaining('is not supported'),
    });
  });
});
