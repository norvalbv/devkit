/** Exactly-once terminal telemetry for a managed `devkit review` invocation. */

import { emitGateEvent } from '../../../../../gate-engine/judge/gate-events.mts';
import { runDirectReviewCli } from '../run-direct.mts';

const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function nonNegativeInteger(value: string | undefined, label: string): number {
  if (value === undefined || !NON_NEGATIVE_INTEGER.test(value)) {
    return fail(`${label} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fail(`${label} is too large`);
  return parsed;
}

function runCli(args: string[]): void {
  if (args[0] !== 'emit' || args.length !== 6) {
    fail('usage: run-result emit <exit-code> <duration-seconds> <log-path> <timed-out>');
  }
  const exitCode = nonNegativeInteger(args[1], 'exit code');
  const durationSeconds = nonNegativeInteger(args[2], 'duration');
  const logPath = args[3] as string;
  const timedOut = args[4] === 'true' ? true : args[4] === 'false' ? false : null;
  // The final reserved argument makes accidental calls from an older four-field shell fail closed.
  if (args[5] !== 'devkit-review-run-result-v1') fail('invalid run-result protocol');
  if (!logPath || logPath.includes('\0')) fail('log path is invalid');
  if (timedOut === null) fail('timed-out must be true or false');

  emitGateEvent({
    type: 'review_run_result',
    exit_code: exitCode,
    timed_out: timedOut,
    duration_s: durationSeconds,
    log_path: logPath,
  });
}

runDirectReviewCli(import.meta.url, runCli);
