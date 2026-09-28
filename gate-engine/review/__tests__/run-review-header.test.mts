// sc-3446: the running header must name the model each judge was SPAWNED with, so a partial
// family move (GUARD_REVIEW_MODEL alone) is visible — checked against argv, not re-derived.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOUR_WAY_LENS_GROUPS, lensGroupId } from '../lens/split.mts';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  passWithArtifact,
  writeArtifact,
} from './run-review-fixtures.mts';

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_REVIEW_SKIP',
  'FRINK_REVIEW_SKIP',
  'GUARD_REVIEW_CONCURRENCY',
  'GUARD_NO_COMPLETENESS',
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_DECISION_NO_LLM',
  'FRINK_DECISION_NO_LLM',
  'GUARD_CODEX_BIN',
  'GUARD_SENTRY_MODEL',
  'FRINK_SENTRY_MODEL',
  'FRINK_REVIEW_MODEL',
  'DEVKIT_RUN_MODE',
  'DEVKIT_REVIEW_ASSET_ROOT',
  'DEVKIT_REVIEW_PROGRESS',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'GUARD_CORRECTNESS_SPLIT',
  'SHIP_COMMIT_TIMEOUT',
  'DEVKIT_GATE_DEADLINE_MS',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
});
afterEach(() => {
  cleanupReviewFixtures();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const headerOf = (err: ReturnType<typeof vi.spyOn>): string =>
  String(
    err.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('guard-review: running ')),
  );
const modelOf = (args: string[]): string => args[args.indexOf('--model') + 1];

describe('runReviewGate — the running header names each judge’s real model (sc-3446)', () => {
  it('names, per reviewer, the exact --model its judge was spawned with', async () => {
    // consumerRepo pins the claude-era knobs; these overrides land after it and are restored by
    // cleanupReviewFixtures along with the pin.
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_MODEL = 'claude-sonnet-5';
    process.env.GUARD_CORRECTNESS_MODEL = 'gpt-5.6-sol';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const header = headerOf(err);
    expect(header.startsWith('guard-review: running ')).toBe(true);
    const [cascade, pinned = ''] = header.split('; ');
    const cascadeModel = cascade.match(/\((\S+) → \S+ on FAIL\)/)?.[1];
    expect(exec.mock.calls.length).toBeGreaterThan(0);
    for (const [opts] of exec.mock.calls) {
      const name = String(opts.label)
        .replace(/^review:/, '')
        .split(':')[0];
      const pin = pinned.match(new RegExp(`${name} on (\\S+?)[,)\\s]`))?.[1];
      expect(pin ?? cascadeModel).toBe(modelOf(opts.args));
      expect(header.split(name).length).toBe(2); // named exactly once
    }
    expect(pinned).toContain('correctness-reviewer on gpt-5.6-sol');
  });

  // Four lens judges are still ONE reviewer on ONE model — the header must not repeat it four
  // times, nor fold it into the cascade group the way the old single-model header did.
  it('names a four-way-split correctness reviewer once, on its pinned model', async () => {
    delete process.env.GUARD_CORRECTNESS_SPLIT; // the shipped default fans out per lens
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label);
      // The exec label names the reviewer, not the lens, so satisfy every group's artifact.
      for (const group of FOUR_WAY_LENS_GROUPS)
        writeFileSync(
          join(repo, `.claude/.correctness-review-${lensGroupId(group)}.json`),
          JSON.stringify({
            items: [{ name: group[0], category: 'X', status: 'pass', issues: [] }],
          }),
        );
      return 'checked\nVERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const header = headerOf(err);
    expect(header.match(/correctness-reviewer/g)).toHaveLength(1);
    expect(header).toContain('correctness-reviewer on sonnet');
    const lensModels = exec.mock.calls
      .filter((c) => c[0].label === 'review:correctness-reviewer')
      .map((c) => modelOf(c[0].args));
    expect(lensModels).toEqual(FOUR_WAY_LENS_GROUPS.map(() => 'sonnet'));
  });
});
