/** A refused MODEL (codex's 400 on a ChatGPT free plan) is a permanent outage of its own kind:
 *  never retried, recorded on judge_exec, remedied by moving the model rather than auth/quota. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyJudgeOutage, type JudgeOutage } from '../outage/classify.mts';
import { remedyCause, strictRemedy, unavailableMessage } from '../outage/wording.mts';
import { execJudge } from '../run-judge.mts';

/** codex 0.162.1's stderr, verbatim, when a free plan asks for gpt-5.6-sol. */
const REFUSAL =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}';

describe('classifyJudgeOutage — model refused by the plan', () => {
  it('reads the real 400 as model-unavailable, permanent, with the provider sentence kept', () => {
    const outage = classifyJudgeOutage({ status: 1, stderr: REFUSAL });
    expect(outage).toMatchObject({ kind: 'model-unavailable', permanent: true });
    expect(outage.detail).toContain('is not supported when using Codex');
  });

  it('reads the older {"detail"} envelope of the same refusal the same way', () => {
    const stderr = `{"detail":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}`;
    expect(classifyJudgeOutage({ status: 1, stderr })).toMatchObject({
      kind: 'model-unavailable',
      permanent: true,
    });
  });

  // A refused MODEL only: any other 400 must not reach the move-the-model remedy.
  it.each([
    `{"detail":"Unsupported value: 'xhigh' is not supported with the 'gpt-5.6-sol' model."}`,
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid value for temperature: model does not support this parameter."}}',
  ])('a different 400 is not read as a refused model: %s', (stderr) => {
    expect(classifyJudgeOutage({ status: 1, stderr }).kind).not.toBe('model-unavailable');
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
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, 'claude');
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho '${REFUSAL}' >&2\nexit 1`, {
      mode: 0o755,
    });
    chmodSync(fake, 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('persists the kind and excerpt to judge_exec, and hands the refused model to the caller', () => {
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
    const [ev] = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ev).toMatchObject({ type: 'judge_exec', outcome: 'model-unavailable', model: 'opus' });
    expect(ev.outage_detail).toContain('is not supported');
  });
});
