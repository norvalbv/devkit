/** The parallel completeness judge and the reviewer fleet share one strict-ship Remedy per outage:
 *  the review hook hands both one DEVKIT_REMEDY_DIR, and the second printer points up instead. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeOutage } from '../../judge/outage/classify.mts';
import { runCompleteness } from '../completeness.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { reportInconclusive } from '../valve/inconclusive.mts';
import { cleanupReviewFixtures, consumerRepo, mkExec } from './run-review-fixtures.mts';

const HOUR = 3_600_000;
const ENV_KEYS = [
  'DEVKIT_REMEDY_DIR',
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_NO_COMPLETENESS',
  'FRINK_NO_COMPLETENESS',
  'GUARD_CODEX_BIN',
] as const;
const saved = new Map<string, string | undefined>();
let dir = '';

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  process.env.GUARD_AI_STRICT = '1';
  dir = mkdtempSync(join(tmpdir(), 'dk-remedy-once-'));
  process.env.DEVKIT_REMEDY_DIR = dir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  cleanupReviewFixtures();
  vi.restoreAllMocks();
});

function captureStderr(): () => string[] {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => err.mock.calls.flat().join('\n').split('\n');
}

const fullRemedies = (out: string[]) =>
  out.filter((l) => l.startsWith('   Remedy:') && !l.includes('the same Remedy as printed above'));
const pointers = (out: string[]) =>
  out.filter((l) => l.includes('the same Remedy as printed above'));

/** The fixture pins the claude family, so the completeness judge's binary is `claude`. */
async function completenessHits(outage: JudgeOutage): Promise<void> {
  const repo = consumerRepo({ backend: true });
  const msg = join(repo, '.git', 'COMMIT_EDITMSG_TEST');
  writeFileSync(msg, 'feat: x');
  const exec = mkExec(async (opts) => {
    opts.onOutage?.(outage);
    return null;
  });
  expect(await runCompleteness(msg, repo, { exec })).toBe(3);
}

const fleetRow = (
  name: string,
  cause: ReviewOutcome['inconclusiveCause'],
  bin: string,
  resetsAt?: number,
): ReviewOutcome => ({
  name,
  status: 'inconclusive',
  reason: 'judge unavailable',
  escalated: false,
  inconclusiveCause: cause,
  outageBin: bin,
  outageResetsAt: resetsAt,
});

describe('one strict-ship Remedy across completeness and the reviewer fleet', () => {
  it('the same usage limit on the same binary prints ONE Remedy paragraph', async () => {
    const lines = captureStderr();
    const resetsAt = Date.now() + 5 * HOUR;
    await completenessHits({ kind: 'rate-limited', permanent: true, resetsAt });
    reportInconclusive(
      [
        fleetRow('a', 'rate-limited', 'claude', resetsAt),
        fleetRow('b', 'rate-limited', 'claude', resetsAt),
      ],
      true,
    );
    const out = lines();
    // The header the ship's telemetry grep and blocked_gate attribution read stays intact.
    expect(out).toContain(
      'guard-review: completeness SKIPPED (judge hit the provider usage limit) — strict ship mode fails closed.',
    );
    expect(fullRemedies(out)).toHaveLength(1);
    expect(fullRemedies(out)[0]).toContain('(an earned PASS is cached).');
    expect(pointers(out)).toEqual([
      '   Remedy: the same Remedy as printed above (completed verdicts are cached).',
    ]);
  });

  it('a different binary keeps its own Remedy', async () => {
    const lines = captureStderr();
    const resetsAt = Date.now() + 5 * HOUR;
    await completenessHits({ kind: 'rate-limited', permanent: true, resetsAt });
    reportInconclusive([fleetRow('a', 'rate-limited', 'codex', resetsAt)], true);
    const out = lines();
    expect(fullRemedies(out)).toHaveLength(2);
    expect(pointers(out)).toHaveLength(0);
  });

  it('a different cause keeps its own Remedy', async () => {
    const lines = captureStderr();
    await completenessHits({ kind: 'timeout', permanent: false });
    reportInconclusive([fleetRow('a', 'rate-limited', 'claude', Date.now() + HOUR)], true);
    expect(fullRemedies(lines())).toHaveLength(2);
  });

  it('a later reset than the one already printed gets the full Remedy with the longer wait', async () => {
    const lines = captureStderr();
    const now = Date.now();
    await completenessHits({ kind: 'rate-limited', permanent: true, resetsAt: now + HOUR });
    reportInconclusive(
      [fleetRow('a', 'rate-limited', 'claude', now + 5 * HOUR + 3 * 60_000)],
      true,
    );
    const remedies = fullRemedies(lines());
    expect(remedies).toHaveLength(2);
    expect(remedies[1]).toContain('for another 5h 3m');
  });

  it('without a shared dir every printer keeps its full Remedy', async () => {
    delete process.env.DEVKIT_REMEDY_DIR;
    const lines = captureStderr();
    const resetsAt = Date.now() + 5 * HOUR;
    await completenessHits({ kind: 'rate-limited', permanent: true, resetsAt });
    reportInconclusive([fleetRow('a', 'rate-limited', 'claude', resetsAt)], true);
    expect(fullRemedies(lines())).toHaveLength(2);
  });

  it('a no-VERDICT pair shares one contract Remedy, and the pointer never calls it an outage', async () => {
    const lines = captureStderr();
    const repo = consumerRepo({ backend: true });
    const msg = join(repo, '.git', 'COMMIT_EDITMSG_TEST');
    writeFileSync(msg, 'feat: x');
    const exec = mkExec(async () => 'looks fine to me');
    expect(await runCompleteness(msg, repo, { exec })).toBe(3);
    reportInconclusive([fleetRow('a', 'response-contract', 'claude')], true);
    const out = lines();
    expect(fullRemedies(out)).toHaveLength(1);
    expect(pointers(out)).toEqual([
      '   Remedy: the same Remedy as printed above (completed verdicts are cached).',
    ]);
  });

  it('a Remedy dir removed mid-run still prints the full Remedy and fails closed', async () => {
    rmSync(dir, { recursive: true, force: true });
    const lines = captureStderr();
    await completenessHits({ kind: 'rate-limited', permanent: true, resetsAt: Date.now() + HOUR });
    expect(fullRemedies(lines())).toHaveLength(1);
  });

  it('completeness alone in a fresh dir prints its full Remedy', async () => {
    const lines = captureStderr();
    await completenessHits({ kind: 'rate-limited', permanent: true, resetsAt: Date.now() + HOUR });
    expect(fullRemedies(lines())).toHaveLength(1);
    expect(pointers(lines())).toHaveLength(0);
  });
});
