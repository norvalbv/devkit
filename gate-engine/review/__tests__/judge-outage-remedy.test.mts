/** The sc-2538 regression at both judge-spawning gates. Completeness runs at commit-msg, which the
 *  ship preflight never reaches — only classifying at the failure site fixes both. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCompleteness } from '../completeness.mts';
import { runReviewGate } from '../run-review.mts';
import { cleanupReviewFixtures, consumerRepo, mkExec } from './run-review-fixtures.mts';

// Env hygiene, same reason as the parent suite: the gates read GUARD_*/FRINK_*, and a developer's
// real environment must not steer a spawn-count assertion.
const ENV_KEYS = [
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_NO_COMPLETENESS',
  'FRINK_NO_COMPLETENESS',
  'GUARD_COMPLETENESS_HARD',
  'GUARD_REVIEW_SKIP',
  'GUARD_CORRECTNESS_SPLIT',
];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // These tests count SPAWNS. Left unset, correctness fans out one judge per lens (the shipped
  // default) and the count stops being about the retry predicate, which is what is under test.
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('runReviewGate — a rate-limited judge', () => {
  // Sixteen spawns against a six-day lock the log called "(transient), retrying once…". A usage
  // lock is permanent for the same reason a timeout is: the second attempt hits the same wall.
  it('a rate-limited judge is NOT retried, and is never described as transient', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const resetsAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
    const exec = mkExec(async (opts) => {
      opts.onOutage?.({ kind: 'rate-limited', permanent: true, resetsAt });
      return null;
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    // Five reviewers, five spawns. Before this fix: ten.
    expect(exec).toHaveBeenCalledTimes(5);
    const out = err.mock.calls.flat().join('\n');
    expect(out).not.toContain('retrying once');
    expect(out).not.toContain('transient');
    expect(out).toContain('provider usage limit');
    // The remedy the operator was given for six days was "re-run devkit ship". It must not reappear.
    expect(out).not.toContain('check `claude` CLI auth/quota');
    expect(out).toContain('cannot succeed');
    expect(out).toMatch(/for another \d+d/);
    expect(out).toContain('GUARD_REVIEW_MODEL');
  });
});

describe('runCompleteness — a rate-limited judge', () => {
  /** The commit-msg gate reads its message from a file, same as the parent suite's harness. */
  const msg = (repo, text) => {
    const f = join(repo, '.git', 'COMMIT_EDITMSG_TEST');
    writeFileSync(f, text);
    return f;
  };

  // sc-2538: completeness runs at commit-msg, so a ship-only preflight would never have reached it.
  // The same lock that misreported at the review gate misreported here, with the same dead remedy.
  it('a RATE-LIMITED judge names the limit, the wait, and the one lever that still ships', async () => {
    const repo = consumerRepo({ backend: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    const resetsAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
    const exec = mkExec(async (opts) => {
      opts.onOutage?.({ kind: 'rate-limited', permanent: true, resetsAt });
      return null;
    });
    expect(await runCompleteness(msg(repo, 'feat: x'), repo, { exec })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('SKIPPED (judge hit the provider usage limit)');
    expect(out).toMatch(/for another \d+d/);
    expect(out).toContain('devkit doctor --fix');
    expect(out).not.toContain('CLI auth/quota, then re-run devkit ship');
  });
});
