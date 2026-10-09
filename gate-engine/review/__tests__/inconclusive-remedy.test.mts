import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewGate } from '../run-review.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { reportInconclusive } from '../valve/inconclusive.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  writeArtifact,
} from './run-review-fixtures.mts';

const HOUR = 3_600_000;
const ENV_KEYS = ['GUARD_AI_STRICT', 'GUARD_REVIEW_MODEL', 'GUARD_CODEX_BIN'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  delete process.env.GUARD_CODEX_BIN;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupReviewFixtures();
  vi.restoreAllMocks();
});

const row = (name: string, extra: Partial<ReviewOutcome>): ReviewOutcome => ({
  name,
  status: 'inconclusive',
  reason: 'judge unavailable',
  escalated: false,
  ...extra,
});

const limited = (name: string, bin: string, resetsAt: number) =>
  row(name, { inconclusiveCause: 'rate-limited', outageBin: bin, outageResetsAt: resetsAt });

function captureStderr(): () => string[] {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => err.mock.calls.flat().join('\n').split('\n');
}

describe('reportInconclusive prints one Remedy per cause and binary', () => {
  it('rows sharing a usage limit share one Remedy naming the latest reset', () => {
    const lines = captureStderr();
    const now = Date.now();
    reportInconclusive(
      [
        limited('api-security-reviewer', 'codex', now + 5 * HOUR),
        limited('backend-performance-reviewer', 'codex', now + 5 * HOUR + 3 * 60_000),
        limited('commit-guard', 'codex', now + 5 * HOUR + 60_000),
        row('conventions-reviewer', { inconclusiveCause: 'response-contract', transcript: 'raw' }),
      ],
      true,
    );
    const out = lines();
    expect(out.filter((l) => l.includes('INCONCLUSIVE'))).toHaveLength(4);
    expect(out.filter((l) => l.includes('see Remedy below'))).toHaveLength(4);
    const remedies = out.filter((l) => l.startsWith('   Remedy:'));
    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toContain('`codex` reports its usage limit reached');
    expect(remedies[0]).toContain('for another 5h 3m');
    expect(remedies[1]).toContain('declared contract');
    expect(out).toContain('raw');
  });

  it('the same cause on two binaries keeps one Remedy each', () => {
    const lines = captureStderr();
    const at = Date.now() + HOUR;
    reportInconclusive([limited('a', 'codex', at), limited('b', 'claude', at)], true);
    const remedies = lines().filter((l) => l.startsWith('   Remedy:'));
    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toContain('`codex` reports');
    expect(remedies[1]).toContain('`claude` reports');
  });

  it('fail-open prints no Remedy and keeps its row wording', () => {
    const lines = captureStderr();
    reportInconclusive([limited('a', 'codex', Date.now() + HOUR)], false);
    expect(lines()).toEqual([
      'guard-review: a inconclusive — judge unavailable (fail-open, not cached)',
    ]);
  });
});

describe('a strict gate whose codex judges all go dark', () => {
  // The fixture's correctness lenses fail their checklist contract: a second cause, a second Remedy.
  it('fails closed with one Remedy per cause under seven INCONCLUSIVE rows', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra@high';
    const lines = captureStderr();
    const exec = mkExec(async ({ label }: { label: string }) => {
      if (label === 'review:correctness-reviewer' || label === 'review:conventions-reviewer') {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      return null;
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const out = lines();
    expect(out.filter((l) => l.includes('see Remedy below'))).toHaveLength(7);
    const remedies = out.filter((l) => l.startsWith('   Remedy:'));
    expect(remedies).toHaveLength(2);
    expect(remedies.filter((l) => l.includes('check `codex` CLI auth/quota'))).toHaveLength(1);
  });
});
