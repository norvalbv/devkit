/** sc-3411 — each completeness PASS line names the message it judged, the only log evidence of
 *  which body a diff-blind sticky PASS covers. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCommitMessage, runCompleteness } from '../completeness.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
} from './run-review-fixtures.mts';

const ENV_KEYS = ['DEVKIT_SHIP_BRANCH', 'GUARD_AI_STRICT'] as const;
const saved: Record<string, string | undefined> = {};
let stderr: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => void stderr.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupReviewFixtures();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const sha12 = (file: string) =>
  createHash('sha256')
    .update(normalizeCommitMessage(readFileSync(file, 'utf8')))
    .digest('hex')
    .slice(0, 12);
const lineWith = (needle: string) => stderr.find((l) => l.includes(needle)) ?? '';

describe('completeness PASS lines carry the judged message identity', () => {
  it('a fresh PASS prints the subject and the sha of the normalised message', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.DEVKIT_SHIP_BRANCH = 'feat/id-fresh';
    const msg = messageFile(repo, 'feat: fresh identity');
    expect(await runCompleteness(msg, repo, { exec: mkExec(async () => 'VERDICT: PASS') })).toBe(0);
    const line = lineWith('completeness — PASS');
    expect(line).toContain('"feat: fresh identity"');
    expect(line).toContain(`sha:${sha12(msg)}`);
  });

  it('a sticky PASS names the message it was keyed on, and an amended message gets a new sha', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.DEVKIT_SHIP_BRANCH = 'feat/id-sticky';
    const exec = mkExec(async () => 'VERDICT: PASS');
    const first = messageFile(repo, 'feat: sticky identity');
    const firstSha = sha12(first);
    await runCompleteness(first, repo, { exec });
    // Reshape the diff (another reviewer's remedy): same branch + message → sticky hit.
    writeFileSync(join(repo, 'src', 'main', 'db.ts'), 'export const q = 2;\n');
    execSync('git add src/main/db.ts', { cwd: repo });
    stderr = [];
    await runCompleteness(messageFile(repo, 'feat: sticky identity'), repo, { exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(lineWith('cached PASS (same branch + message')).toContain(`sha:${firstSha}`);

    // An amended message is a new claim: re-judged, and its PASS line names a DIFFERENT sha.
    stderr = [];
    const amended = messageFile(repo, 'feat: sticky identity, corrected');
    await runCompleteness(amended, repo, { exec });
    expect(exec).toHaveBeenCalledTimes(2);
    const sha = sha12(amended);
    expect(sha).not.toBe(firstSha);
    expect(lineWith('completeness — PASS')).toContain(`sha:${sha}`);
  });

  it('an exact-cache PASS (sticky missed on a branch change) names the message too', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'VERDICT: PASS');
    const msg = messageFile(repo, 'feat: exact identity');
    process.env.DEVKIT_SHIP_BRANCH = 'feat/id-a';
    await runCompleteness(msg, repo, { exec });
    // The exact key has no branch in it; the sticky key does — so this is an exact hit only.
    process.env.DEVKIT_SHIP_BRANCH = 'feat/id-b';
    stderr = [];
    await runCompleteness(msg, repo, { exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(lineWith('cached PASS (identical judgement)')).toContain(`sha:${sha12(msg)}`);
  });

  it("truncates a long subject on code points, never between an emoji's surrogate halves", async () => {
    const repo = consumerRepo({ backend: true });
    process.env.DEVKIT_SHIP_BRANCH = 'feat/id-emoji';
    const subject = `feat: ${'a'.repeat(50)}\u{1F680} launch the long subject`;
    await runCompleteness(messageFile(repo, subject), repo, {
      exec: mkExec(async () => 'VERDICT: PASS'),
    });
    const line = lineWith('completeness — PASS');
    expect(line).toContain(`"feat: ${'a'.repeat(50)}\u{1F680}...`);
    expect(line).not.toMatch(/\\ud83d/i);
  });
});
