/** BENCH_CORRECTNESS_MODEL moves the correctness pin end to end: the run's identity and the model
 *  every correctness judge is spawned with. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRows } from '../corpus.mts';

const OVERRIDE = 'claude-sonnet-5-5';

async function loadBench(model?: string) {
  vi.resetModules();
  if (model) vi.stubEnv('BENCH_CORRECTNESS_MODEL', model);
  return { ...(await import('../bench.mts')), ...(await import('../corpus/chunk-guard.mts')) };
}

const correctnessOf = (reviewers: ReadonlyArray<{ name: string; model?: string }>) =>
  reviewers.find((r) => r.name === 'correctness-reviewer');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('BENCH_CORRECTNESS_MODEL', () => {
  it('keys the run on the override and spawns every correctness judge with it', async () => {
    const bench = await loadBench(OVERRIDE);
    const reviewer = correctnessOf(bench.BENCH_REVIEWERS);
    expect(bench.effModel(reviewer)).toBe(OVERRIDE);

    const env: NodeJS.ProcessEnv = {};
    bench.pinBenchModels(env);
    expect(env.GUARD_CORRECTNESS_MODEL).toBe(OVERRIDE);
    vi.stubEnv('GUARD_CORRECTNESS_MODEL', env.GUARD_CORRECTNESS_MODEL);

    const row = loadRows(reviewer, { only: 'corr-only-selector-silent-drop' })[0];
    const models: string[] = [];
    const exec = async (opts: { args?: string[] }) => {
      const args = opts.args ?? [];
      models.push(args[args.indexOf('--model') + 1]);
      return 'VERDICT: PASS — bench stub';
    };
    await bench.runRow(row, { model: 'haiku', cascade: false, exec });
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set([OVERRIDE]));
  });

  it('leaves the shipped pin in place when unset', async () => {
    const bench = await loadBench();
    const reviewer = correctnessOf(bench.BENCH_REVIEWERS);
    expect(bench.effModel(reviewer)).toBe(reviewer?.model);

    const env: NodeJS.ProcessEnv = {};
    bench.pinBenchModels(env);
    expect(env.GUARD_CORRECTNESS_MODEL).toBeUndefined();
  });
});
