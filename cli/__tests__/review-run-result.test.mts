import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const RUN_RESULT = fileURLToPath(
  new URL('../lib/ship/review/telemetry/run-result.mts', import.meta.url),
);
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function reviewEnvironment(sink: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('DEVKIT_SHIP')) delete environment[name];
  }
  return {
    ...environment,
    DEVKIT_GATE_EVENTS: sink,
    DEVKIT_REVIEW_ID: 'review-test-run',
    DEVKIT_REVIEW_REPO: 'consumer',
    DEVKIT_REVIEW_BRANCH: 'feature/review',
    DEVKIT_RUN_MODE: 'review',
  };
}

describe('review terminal telemetry', () => {
  it('emits exactly one review result with review context and no ship terminal', () => {
    const root = mkTmp('devkit-review-run-result-');
    const sink = join(root, 'telemetry', 'events.jsonl');
    const log = join(root, 'review.log');

    const result = spawnSync(
      process.execPath,
      [RUN_RESULT, 'emit', '124', '17', log, 'true', 'devkit-review-run-result-v1'],
      { encoding: 'utf8', env: reviewEnvironment(sink) },
    );

    expect(result.status, result.stderr).toBe(0);
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'review_run_result',
      exit_code: 124,
      timed_out: true,
      duration_s: 17,
      log_path: log,
      ship_id: 'review-test-run',
      run_mode: 'review',
      repo: 'consumer',
      branch: 'feature/review',
    });
    expect(events.some(({ type }) => type === 'ship_attempt' || type === 'ship_result')).toBe(
      false,
    );
  });

  it('fails closed on malformed protocol without emitting telemetry', () => {
    const root = mkTmp('devkit-review-run-result-invalid-');
    const sink = join(root, 'telemetry', 'events.jsonl');

    const result = spawnSync(
      process.execPath,
      [RUN_RESULT, 'emit', '0', '1', join(root, 'review.log'), 'false', 'wrong-version'],
      { encoding: 'utf8', env: reviewEnvironment(sink) },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid run-result protocol');
    expect(existsSync(sink)).toBe(false);
  });
});
