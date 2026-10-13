/** BENCH_CORRECTNESS_MODEL moves the correctness pin end to end: the run's identity and the model
 *  every correctness judge is spawned with. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const OVERRIDE = 'claude-sonnet-5-5';
const moduleUrl = (file: string) =>
  JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', file)).href);

// bench.mts pins its models while it is imported, so each case loads it in a process of its own.
const PROBE = `
const bench = await import(${moduleUrl('bench.mts')});
const guard = await import(${moduleUrl('corpus/chunk-guard.mts')});
const reviewer = bench.BENCH_REVIEWERS.find((r) => r.name === 'correctness-reviewer');
const env = {};
guard.pinBenchModels(env);
const models = [];
if (process.env.PROBE_RUN_ROW) {
  const row = bench.loadRows(reviewer, { only: 'corr-only-selector-silent-drop' })[0];
  const exec = async ({ args = [] }) => {
    models.push(args[args.indexOf('--model') + 1]);
    return 'VERDICT: PASS — bench stub';
  };
  await bench.runRow(row, { model: 'haiku', cascade: false, exec });
}
console.log(JSON.stringify({
  effective: guard.effModel(reviewer),
  shipped: reviewer.model,
  ambient: process.env.GUARD_CORRECTNESS_MODEL ?? null,
  pinned: env.GUARD_CORRECTNESS_MODEL ?? null,
  models,
}));`;

function loadBench(model?: string, runRow = false) {
  const env = { ...process.env };
  delete env.GUARD_CORRECTNESS_MODEL;
  delete env.GUARD_REVIEW_ESCALATION_MODEL;
  delete env.BENCH_CORRECTNESS_MODEL;
  if (model !== undefined) env.BENCH_CORRECTNESS_MODEL = model;
  if (runRow) env.PROBE_RUN_ROW = '1';
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', PROBE], {
    env,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
}

describe('BENCH_CORRECTNESS_MODEL', () => {
  it('keys the run on the override and spawns every correctness judge with it', () => {
    const bench = loadBench(OVERRIDE, true);
    expect(bench).toMatchObject({ effective: OVERRIDE, ambient: OVERRIDE, pinned: OVERRIDE });
    expect(bench.models.length).toBeGreaterThan(0);
    expect(new Set(bench.models)).toEqual(new Set([OVERRIDE]));
  });

  it.each([undefined, '', '   '])('leaves the shipped pin in place for %j', (value) => {
    const bench = loadBench(value);
    expect(bench.effective).toBe(bench.shipped);
    expect(bench).toMatchObject({ ambient: null, pinned: null });
  });
});
