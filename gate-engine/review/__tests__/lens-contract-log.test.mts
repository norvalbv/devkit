import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOUR_WAY_LENS_GROUPS, lensGroupId } from '../lens/split.mts';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  writeArtifact,
} from './run-review-fixtures.mts';

// The gate reads these; a developer's real env (or a live ship) must not steer the assertions.
const ENV_KEYS = [
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_REVIEW_SKIP',
  'GUARD_AI_STRICT',
  'GUARD_REVIEW_CONCURRENCY',
  'GUARD_CORRECTNESS_SPLIT',
  'GUARD_CORRECTNESS_CHUNK',
  'DEVKIT_RUN_MODE',
  'DEVKIT_REVIEW_ASSET_ROOT',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BRANCH',
  'DEVKIT_COMMIT_MSG_FILE',
  'SHIP_COMMIT_TIMEOUT',
  'DEVKIT_GATE_DEADLINE_MS',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  cleanupReviewFixtures();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// The strict ship path defers a contract miss to a solo retry, so both log lines fire.
const shipEnv = (repo: string) => {
  process.env.GUARD_AI_STRICT = '1';
  process.env.GUARD_REVIEW_CONCURRENCY = '3';
  process.env.DEVKIT_GATE_EVENTS = join(repo, 'events.jsonl');
  process.env.DEVKIT_SHIP_ID = 'ship-lens-contract-log';
};

const errLines = (err: ReturnType<typeof vi.spyOn>): string[] =>
  err.mock.calls.flat().join('\n').split('\n');

describe('guard-review contract-miss log lines name the lens', () => {
  it('two lens parts missing the checklist print lines that differ by lens', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = ['state-transitions', 'writer-reader-contracts'];
    const exec = mkExec(async ({ label, args }) => {
      writeArtifact(repo, label);
      const group = FOUR_WAY_LENS_GROUPS.find((g) => args[1].includes(g[0]));
      if (label === 'review:correctness-reviewer' && group && !missing.includes(group[0]))
        writeFileSync(
          join(repo, `.claude/.correctness-review-${lensGroupId(group)}.json`),
          JSON.stringify({
            items: [{ name: group[0], category: 'X', status: 'pass', issues: [] }],
          }),
        );
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const lines = errLines(err);
    const contract = lines.filter((l) => l.includes('checklist contract not satisfied ('));
    const solo = lines.filter((l) => l.includes('retrying solo'));
    // The wave miss and the solo retry's miss each print a contract line, so it repeats per lens.
    for (const set of [contract, solo]) {
      expect(new Set(set).size).toBe(2);
      for (const lens of missing)
        expect(set.some((l) => l.includes(`correctness-reviewer [${lens}] —`))).toBe(true);
    }
  });

  it('an unsplit reviewer keeps its bare name', async () => {
    process.env.GUARD_CORRECTNESS_SPLIT = 'off';
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      if (label !== 'review:correctness-reviewer') writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const lines = errLines(err).filter((l) => l.includes('checklist contract not satisfied'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain('guard-review: correctness-reviewer — ');
  });
});
