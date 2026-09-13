#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY; explicit execution and immutable private results.
import { cleanBenchEnv } from '../../../../decisions/eval/bench.mts';
import { isolateBenchTelemetry } from '../corpus/chunk-guard.mts';
import { withBenchmarkRun } from '../progress.mts';
import { loadComparison } from './manifest.mts';
import { census, openEvidence, runComparison, validateBudget } from './execute.mts';
const args = process.argv.slice(2);
const [command, phase, output, ...rest] = args;
const usage =
  'comparison/cli.mts census <scored|exploratory> | run <phase> <new-private-directory> --execute --max-calls N --max-minutes N --judge-minutes N';
try {
  if (!['census', 'run'].includes(command) || !['scored', 'exploratory'].includes(phase))
    throw new Error(usage);
  cleanBenchEnv();
  isolateBenchTelemetry();
  process.env.GUARD_REVIEW_MAX_ISSUES_PER_LENS = '3';
  const comparison = loadComparison(),
    roster = census(comparison, phase);
  if (command === 'census') {
    if (args.length !== 2) throw new Error(usage);
    console.log(JSON.stringify(roster, null, 2));
  } else {
    if (
      !output ||
      rest.length !== 7 ||
      rest[0] !== '--execute' ||
      rest[1] !== '--max-calls' ||
      rest[3] !== '--max-minutes' ||
      rest[5] !== '--judge-minutes'
    )
      throw new Error(usage);
    const budget = {
      maxCalls: Number(rest[2]),
      maxElapsedMs: Number(rest[4]) * 60_000,
      judgeTimeoutMs: Number(rest[6]) * 60_000,
    };
    validateBudget(budget);
    await withBenchmarkRun(async () => {
      const evidence = openEvidence(output);
      try {
        const report = await runComparison(comparison, roster, budget, evidence);
        console.log(
          JSON.stringify({
            planned: report.planned,
            complete: report.complete,
            calls: report.calls,
            stopped: report.stopped,
          }),
        );
        if (report.complete !== report.planned) process.exitCode = 2;
      } finally {
        evidence.close();
      }
    });
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
}
