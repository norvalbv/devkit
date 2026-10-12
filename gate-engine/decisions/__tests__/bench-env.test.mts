/** cleanBenchEnv, and the rule that every catalog bench whose imports reach a judge isolates its
 * telemetry before that judge runs. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localModuleClosureFiles } from '../../review/eval/module-closure-hash.mts';
import { cleanBenchEnv } from '../eval/bench-env.mts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const RUN_JUDGE = path.join(REPO, 'gate-engine/judge/run-judge.mts');
const ISOLATION_CALL_RE = /\b(?:cleanBenchEnv|isolateBenchTelemetry|silenceBenchTelemetry)\(/;

/** The runners whose import closure reaches `judge` while their own source never isolates. */
function unisolatedRunners(runners: string[], judge: string): string[] {
  return runners.filter(
    (runner) =>
      localModuleClosureFiles([runner]).includes(judge) &&
      !ISOLATION_CALL_RE.test(readFileSync(runner, 'utf8')),
  );
}

function catalogRunners(): string[] {
  const catalog: { suites: { runner: string | null }[] } = JSON.parse(
    readFileSync(path.join(REPO, 'docs/benchmarks/catalog.json'), 'utf8'),
  );
  const runners = catalog.suites.flatMap(({ runner }) =>
    runner?.startsWith('gate-engine/') ? [runner] : [],
  );
  // The edge-cases suite has no runner; its labeller is the stage that calls a judge.
  runners.push('gate-engine/edge-cases/eval/label.mts');
  return [...new Set(runners)].map((runner) => path.join(REPO, runner));
}

describe('cleanBenchEnv', () => {
  it('strips every GUARD_*/FRINK_* and the GIT_* control vars; keeps BENCH_*', () => {
    const env = {
      GUARD_DECISION_NO_LLM: '1',
      GUARD_DECISIONS_DIR: '/elsewhere',
      FRINK_NO_LOG: '1',
      GIT_DIR: '/host/.git',
      GIT_WORK_TREE: '/host',
      BENCH_MODEL: 'sonnet',
      PATH: '/usr/bin',
      DEVKIT_GATE_EVENTS: '/production/gate-events.jsonl',
    };
    const stripped = cleanBenchEnv(env);
    expect(stripped.sort()).toEqual([
      'FRINK_NO_LOG',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GUARD_DECISIONS_DIR',
      'GUARD_DECISION_NO_LLM',
    ]);
    expect(env.BENCH_MODEL).toBe('sonnet');
    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('DEVKIT_GATE_EVENTS');
    expect(env).toMatchObject({ DEVKIT_NO_TELEMETRY: '1', DEVKIT_RUN_ORIGIN: 'bench' });
  });
});

describe('catalog benches isolate their telemetry', () => {
  it('every runner whose imports reach run-judge.mts calls an isolation helper', () => {
    const runners = catalogRunners();
    const judged = runners.filter((runner) =>
      localModuleClosureFiles([runner]).includes(RUN_JUDGE),
    );
    // Pins the walker: these reach the judge, so an empty closure cannot pass this test vacuously.
    expect(judged).toEqual(
      expect.arrayContaining(
        [
          'gate-engine/sentry/eval/bench.mts',
          'gate-engine/decisions/eval/recall/bench.mts',
          'gate-engine/edge-cases/eval/label.mts',
        ].map((runner) => path.join(REPO, runner)),
      ),
    );
    expect(unisolatedRunners(runners, RUN_JUDGE)).toEqual([]);
  });

  it('flags a runner that reaches a judge without isolating (negative control)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-isolation-'));
    try {
      const judge = path.join(dir, 'run-judge.mts');
      writeFileSync(judge, 'export const execJudge = () => null;\n');
      const leaky = path.join(dir, 'leaky.mts');
      writeFileSync(leaky, "import { execJudge } from './run-judge.mts';\nexecJudge();\n");
      const isolated = path.join(dir, 'isolated.mts');
      writeFileSync(
        isolated,
        "import { execJudge } from './run-judge.mts';\nisolateBenchTelemetry();\nexecJudge();\n",
      );
      expect(unisolatedRunners([leaky, isolated], judge)).toEqual([leaky]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
