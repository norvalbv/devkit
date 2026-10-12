/** A healthy quota is not a usable model: a ChatGPT free plan refuses gpt-5.6-sol while its rate
 *  limits read fine, so the preflight checks each codex judge model against `model/list`. */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CodexRateLimits,
  parseModelListReply,
  readCodexRateLimits,
} from '../../gate-engine/judge/codex/rate-limits.mts';
import { judgeReachability, renderPreflight } from '../lib/ship/preflight/judge.mts';

/** Model ids `model/list {includeHidden:true}` returned on a free plan (codex 0.162.1). */
const FREE_PLAN_DATA = [
  { id: 'gpt-6-luna', model: 'gpt-6-luna', hidden: false },
  { id: 'gpt-reserve', model: 'gpt-reserve', hidden: true },
  { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', hidden: false },
];
type ListedModel = (typeof FREE_PLAN_DATA)[number];
const listReply = (data: ListedModel[], nextCursor: string | null = null): string =>
  JSON.stringify({ id: 3, result: { data, nextCursor } });

const ENV_KEYS = [
  'GUARD_REVIEW_MODEL',
  'FRINK_REVIEW_MODEL',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CORRECTNESS_MODEL',
  'GUARD_CORRECTNESS_CHUNK',
  'GUARD_SENTRY_MODEL',
  'FRINK_SENTRY_MODEL',
  'GUARD_CODEX_BIN',
] as const;
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function repo(review: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'judge-preflight-models-'));
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  writeFileSync(
    join(dir, '.devkit', 'config.json'),
    JSON.stringify({ components: { guards: ['review'] } }),
  );
  writeFileSync(join(dir, 'guard.config.json'), JSON.stringify({ review }));
  return dir;
}

const reach = (limits: CodexRateLimits | null, review: Record<string, string>) =>
  judgeReachability(repo(review), {
    resolvable: () => true,
    codexOut: () => false,
    claudeOut: () => false,
    rateLimits: async () => limits,
  });

const HEALTHY: CodexRateLimits = { reached: false, onCredits: false, usedPercent: 10 };
const SOL_ON_CORRECTNESS = {
  model: 'gpt-5.6-terra@high',
  escalationModel: 'gpt-5.6-terra',
  correctnessModel: 'gpt-5.6-sol',
};

describe('parseModelListReply', () => {
  it('collects every id, hidden included, and the non-hidden subset as move targets', () => {
    expect(parseModelListReply(listReply(FREE_PLAN_DATA))).toEqual({
      models: ['gpt-6-luna', 'gpt-reserve', 'gpt-5.6-terra'],
      visibleModels: ['gpt-6-luna', 'gpt-5.6-terra'],
    });
  });

  it.each([
    ['an error reply (a codex without model/list)', '{"id":3,"error":{"code":-32601}}'],
    ['a partial page', listReply(FREE_PLAN_DATA, 'next')],
  ])('%s answers but proves nothing', (_, line) => {
    expect(parseModelListReply(line)).toEqual({});
  });

  it('ignores every other id', () => {
    expect(parseModelListReply(JSON.stringify({ id: 2, result: { data: [] } }))).toBeNull();
  });
});

describe('judgeReachability — model availability', () => {
  const fetched = parseModelListReply(listReply(FREE_PLAN_DATA)) ?? {};

  it('flags a configured model the fetched list omits, and renders its role knob and targets', async () => {
    const statuses = await reach({ ...HEALTHY, planType: 'free', ...fetched }, SOL_ON_CORRECTNESS);
    expect(statuses.map((s) => [s.role, s.state])).toEqual([
      ['review', 'ok'],
      ['escalation', 'ok'],
      ['correctness', 'unavailable'],
    ]);
    const out = renderPreflight(statuses).join('\n');
    expect(out).toContain(
      'correctness: gpt-5.6-sol via codex — NOT AVAILABLE ON THIS ACCOUNT (plan free)',
    );
    expect(out).toContain('This plan does not serve gpt-5.6-sol, so re-running will not help');
    expect(out).toContain(
      'correctness via GUARD_CORRECTNESS_MODEL (with GUARD_CORRECTNESS_CHUNK=off)',
    );
    expect(out).toContain('model the account serves: gpt-6-luna, gpt-5.6-terra.');
  });

  it('strips the @effort suffix before matching', async () => {
    const statuses = await reach({ ...HEALTHY, planType: 'free', ...fetched }, SOL_ON_CORRECTNESS);
    expect(statuses[0]).toMatchObject({ model: 'gpt-5.6-terra@high', state: 'ok' });
  });

  it('makes no claim without a planType: codex may be serving its bundled catalog', async () => {
    const statuses = await reach({ ...HEALTHY, ...fetched }, SOL_ON_CORRECTNESS);
    expect(statuses.every((s) => s.state === 'ok')).toBe(true);
  });

  it('makes no claim when the list proved nothing', async () => {
    const statuses = await reach({ ...HEALTHY, planType: 'free' }, SOL_ON_CORRECTNESS);
    expect(statuses.every((s) => s.state === 'ok')).toBe(true);
  });
});

describe('readCodexRateLimits — the model/list leg of the spawn', () => {
  async function withFake(body: string, timeout: number): Promise<CodexRateLimits | null> {
    const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
    const bin = join(dir, 'codex');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    process.env.GUARD_CODEX_BIN = bin;
    return readCodexRateLimits(timeout);
  }
  const LIMITS = `echo '{"id":2,"result":{"rateLimits":{"planType":"free","primary":{"usedPercent":10}}}}'`;

  it('resolves as soon as both replies arrive, carrying the models', async () => {
    const started = Date.now();
    const snap = await withFake(
      [LIMITS, `echo '${listReply(FREE_PLAN_DATA)}'`, 'sleep 30'].join('\n'),
      10_000,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(snap).toMatchObject({
      planType: 'free',
      models: ['gpt-6-luna', 'gpt-reserve', 'gpt-5.6-terra'],
    });
  });

  it('keeps the rate-limit answer when model/list never replies', async () => {
    const snap = await withFake([LIMITS, 'sleep 30'].join('\n'), 700);
    expect(snap).toMatchObject({ planType: 'free', usedPercent: 10 });
    expect(snap?.models).toBeUndefined();
  });
});
