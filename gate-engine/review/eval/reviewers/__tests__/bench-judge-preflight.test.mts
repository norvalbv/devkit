/** The reviewer bench refuses a run whose judges cannot answer before any task is spent, and labels
 *  a provider-caused inconclusive row as an outage rather than an engine error. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PreflightDeps } from '../../../../../cli/lib/ship/preflight/judge.mts';
import { BenchAbort } from '../../../../decisions/eval/bench.mts';
import { benchJudgeRoles, preflightBenchJudges } from '../corpus/judge-preflight.mts';
import { isOutagePart } from '../corpus/row.mts';
import { progressFile } from '../progress.mts';

const SOL = 'gpt-5.6-sol';
const NOW = 1_800_000_000_000;

const deps = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({
  resolvable: () => true,
  codexOut: () => false,
  claudeOut: () => false,
  rateLimits: async () => null,
  ...over,
});

/** The free-plan reply this machine returned: a fetched model list without the pinned model. */
const freePlan = {
  reached: false,
  onCredits: false,
  planType: 'free',
  models: ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  visibleModels: ['gpt-6-luna', 'gpt-5.6-terra'],
};

const run = (
  roles: { role: string; model: string }[],
  over: Partial<PreflightDeps> = {},
  claudeVersion = () => true,
) => preflightBenchJudges(roles, process.cwd(), { judge: deps(over), claudeVersion, now: NOW });

async function abortOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BenchAbort) return error;
    throw error;
  }
  throw new Error('expected the preflight to abort');
}

describe('preflightBenchJudges', () => {
  it('refuses a pinned codex model the plan does not serve, naming the bench knob', async () => {
    const error = await abortOf(
      run([{ role: 'correctness', model: SOL }], { rateLimits: async () => freePlan }),
    );
    expect(error.code).toBe(2);
    expect(error.message).toContain(`correctness: ${SOL} via `);
    expect(error.message).toContain(
      'not served on this free plan (serves: gpt-6-luna, gpt-5.6-terra)',
    );
    expect(error.message).toContain('BENCH_CORRECTNESS_MODEL');
  });

  it('refuses a usage-locked account and says when it resets', async () => {
    const locked = {
      reached: true,
      onCredits: false,
      planType: 'pro',
      resetsAt: NOW + 2 * 3600_000,
    };
    const error = await abortOf(
      run([{ role: 'correctness', model: SOL }], { rateLimits: async () => locked }),
    );
    expect(error.message).toMatch(/usage limit reached, resets in 2h/);
  });

  it('proceeds when the provider proved nothing (no plan in the reply)', async () => {
    const statuses = await run([{ role: 'correctness', model: SOL }], {
      rateLimits: async () => ({ reached: false, onCredits: false, models: [] }),
    });
    expect(statuses.map((s) => s.state)).toEqual(['ok']);
  });

  it('refuses a logged-out codex, which would fail every task the same way', async () => {
    const error = await abortOf(
      run([{ role: 'correctness', model: SOL }], { codexOut: () => true }),
    );
    expect(error.message).toContain('is not authenticated');
  });

  it('proceeds on a reachable claude judge and refuses a missing or broken one', async () => {
    const roles = [{ role: 'review', model: 'sonnet' }];
    expect((await run(roles)).map((s) => s.state)).toEqual(['ok']);
    const missing = await abortOf(run(roles, { resolvable: () => false }));
    expect(missing.message).toContain('review: sonnet via claude — `claude` is not installed');
    expect(missing.message).toContain('BENCH_MODEL');
    const broken = await abortOf(run(roles, {}, () => false));
    expect(broken.message).toContain('`claude` is not installed or does not run');
  });
});

describe('benchJudgeRoles', () => {
  const correctness = { name: 'correctness-reviewer', model: SOL };
  const backend = { name: 'backend-reviewer' };
  const opts = {
    effModel: (r: { model?: string }) => r.model ?? 'sonnet',
    effCascade: (r: { model?: string }) => !r.model,
    escalationModel: 'opus',
  };

  it('probes only reviewers with selected rows, so a filtered run never checks an idle pin', () => {
    const plan = [
      { reviewer: correctness, rows: [] },
      { reviewer: backend, rows: [{}] },
    ];
    expect(benchJudgeRoles(plan, opts)).toEqual([
      { role: 'review', model: 'sonnet' },
      { role: 'escalation', model: 'opus' },
    ]);
  });

  it('adds no escalator for a single-pass pin, and moves with the correctness override', () => {
    const plan = [{ reviewer: correctness, rows: [{}] }];
    expect(benchJudgeRoles(plan, opts)).toEqual([{ role: 'correctness', model: SOL }]);
    const override = { ...opts, effModel: () => 'claude-haiku-5-5' };
    expect(benchJudgeRoles(plan, override)).toEqual([
      { role: 'correctness', model: 'claude-haiku-5-5' },
    ]);
  });
});

describe('isOutagePart', () => {
  const part = (
    inconclusiveCause: string,
    reason = 'judge model is not available on this account',
  ) => ({
    res: { status: 'inconclusive', inconclusiveCause, reason },
  });

  it('reads a provider cause from the structured field, whatever the wording', () => {
    expect(isOutagePart(part('model-unavailable'))).toBe(true);
    expect(isOutagePart(part('rate-limited'))).toBe(true);
  });

  it('still reads an outage from the wording when the cascade recorded no cause', () => {
    const exhausted = 'reviewer checklist contract failed after one retry — judge outage';
    expect(isOutagePart({ res: { status: 'inconclusive', reason: exhausted } })).toBe(true);
  });

  it('leaves a timeout or a response-contract miss as an engine error', () => {
    expect(isOutagePart(part('timeout', 'judge timed out'))).toBe(false);
    expect(isOutagePart(part('response-contract', 'no VERDICT line'))).toBe(false);
    expect(isOutagePart({ res: { status: 'error', reason: 'judge outage' } })).toBe(false);
  });
});

/** A stand-in codex whose app-server answers like this machine's free plan; it cannot judge. */
const FAKE_CODEX = `#!/bin/sh
case "$1" in
  login) echo "Logged in using ChatGPT" ;;
  app-server)
    echo '{"id":1,"result":{"userAgent":"codex/0.162.1"}}'
    echo '{"id":2,"result":{"rateLimits":{"planType":"free","primary":{"usedPercent":10}}}}'
    echo '{"id":3,"result":{"data":[{"id":"gpt-6-luna"},{"id":"gpt-5.6-terra"}]}}'
    sleep 5 ;;
  *) echo "fake codex cannot judge" >&2; exit 1 ;;
esac
`;

describe('bench.mts run — the preflight is wired before any task', () => {
  it('a refused pin exits 2 with no task planned and keeps a --fresh checkpoint', () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'bench-fake-codex-'));
    writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
    // A model name of its own keys a checkpoint no real run shares.
    const model = `preflight-test-${process.pid}`;
    const checkpoint = progressFile(model, true);
    writeFileSync(checkpoint, '{}\n');
    try {
      const bench = fileURLToPath(new URL('../bench.mts', import.meta.url));
      const args = ['run', 'correctness', '--only', 'corr-reclaim-permissive', '--fresh'];
      const result = spawnSync(process.execPath, [bench, ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BENCH_MODEL: model,
          BENCH_CASCADE: 'on',
          BENCH_CORRECTNESS_MODEL: '',
        },
      });
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(2);
      expect(output).toContain(`correctness: ${SOL} via codex — not served on this free plan`);
      expect(output).not.toContain('first-pass tasks');
      expect(existsSync(checkpoint)).toBe(true);
    } finally {
      rmSync(checkpoint, { force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  }, 90_000);
});
