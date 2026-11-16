import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_MISS, RESPONSE_CONTRACT_REMEDY } from '../contracts/response.mts';
import { runReviewGate } from '../run-review.mts';
import { type ReviewOutcome, verifyChecklist } from '../runtime.mts';
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

  it('a binary-independent remedy prints once across binaries', () => {
    const lines = captureStderr();
    const timeout = { inconclusiveCause: 'timeout' } as const;
    reportInconclusive(
      [
        row('a', { ...timeout, outageBin: 'codex' }),
        row('b', { ...timeout, outageBin: 'claude' }),
        row('c', { inconclusiveCause: 'engine', outageBin: '`codex`' }),
        row('d', { inconclusiveCause: 'engine', outageBin: '`claude`' }),
      ],
      true,
    );
    const remedies = lines().filter((l) => l.startsWith('   Remedy:'));
    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toContain('time cap');
    expect(remedies[1]).toContain('gate itself failed');
  });

  it('a usage limit with no reset says until it resets, never a bogus window', () => {
    const lines = captureStderr();
    reportInconclusive([row('a', { inconclusiveCause: 'rate-limited', outageBin: 'codex' })], true);
    const [remedy] = lines().filter((l) => l.startsWith('   Remedy:'));
    expect(remedy).toContain('re-running cannot succeed until the limit resets');
  });

  it('fail-open prints no Remedy and keeps its row wording', () => {
    const lines = captureStderr();
    reportInconclusive([limited('a', 'codex', Date.now() + HOUR)], false);
    expect(lines()).toEqual([
      'guard-review: a inconclusive — judge unavailable (fail-open, not cached)',
    ]);
  });
});

describe('a checklist contract miss whose judge was refused tool calls', () => {
  const MISSING = 'checklist artifact missing — ';
  const contract = (extra: Partial<ReviewOutcome> = {}) =>
    row('correctness-reviewer', { inconclusiveCause: 'response-contract', ...extra });
  const remediesOf = (rows: ReviewOutcome[], strict: boolean): string[] => {
    const lines = captureStderr();
    reportInconclusive(rows, strict);
    return lines().filter((l) => l.startsWith('   Remedy:'));
  };

  it('the reason counts unrelated refusals without calling them checklist commands', () => {
    expect(verifyChecklist(null, 'PASS', ['Bash: vitest run', 'Bash: bun test'])).toBe(
      `${MISSING}2 tool call(s) were denied by the judge's tool allowlist (the allowlist runs Bash only for the checklist commands, spelled as given)`,
    );
  });

  it('measured-none and unmeasured spawns keep their reason and remedy byte for byte', () => {
    expect(verifyChecklist(null, 'PASS', [])).toBe(
      `${MISSING}the judge skipped the checklist workflow (no tool call was denied)`,
    );
    expect(verifyChecklist(null, 'PASS', null)).toBe(
      `${MISSING}the judge skipped the checklist workflow`,
    );
    expect(RESPONSE_CONTRACT_REMEDY).toBe(
      'the judge response did not satisfy its declared contract; inspect the transcript or checklist above, fix a real violation if present, then re-run devkit ship',
    );
    expect(remediesOf([contract()], true)).toEqual([
      `   Remedy: ${RESPONSE_CONTRACT_REMEDY} (completed verdicts are cached).`,
    ]);
  });

  it('strict ship names the re-run and every judge-model knob, never a violation to fix', () => {
    const [remedy, ...rest] = remediesOf([contract({ refusedCalls: 2 }), contract()], true);
    expect(rest).toEqual([
      `   Remedy: ${RESPONSE_CONTRACT_REMEDY} (completed verdicts are cached).`,
    ]);
    expect(remedy).toContain('re-run devkit ship, and if it repeats move that judge');
    for (const knob of [
      'GUARD_REVIEW_MODEL',
      'GUARD_REVIEW_ESCALATION_MODEL',
      'GUARD_CORRECTNESS_MODEL',
    ])
      expect(remedy).toContain(knob);
    expect(remedy).toContain('review.correctnessModel');
    expect(remedy).not.toMatch(/fix a real violation|correctnessChunkLoc|GUARD_CORRECTNESS_CHUNK/);
  });

  it('a plain commit prints one fail-open Remedy per contract wording and none for an outage', () => {
    const remedies = remediesOf(
      [
        contract(),
        contract({ name: 'commit-guard' }),
        contract({ refusedCalls: 1 }),
        limited('a', 'codex', Date.now()),
      ],
      false,
    );
    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toBe(`   Remedy: ${CONTRACT_MISS}.`);
    expect(remedies[1]).toContain('if it repeats, move that judge to another model');
    for (const l of remedies) expect(l).not.toMatch(/devkit ship|cached/);
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
    const rows = out.filter((l) => l.includes('see Remedy below'));
    expect(rows).toHaveLength(7);
    // commit-with-gate-capture.sh attributes the ship block to review with this exact grep.
    for (const l of rows) expect(l).toMatch(/guard-review: .* (FAILED|INCONCLUSIVE)/);
    const remedies = out.filter((l) => l.startsWith('   Remedy:'));
    expect(remedies).toHaveLength(2);
    expect(remedies.filter((l) => l.includes('check `codex` CLI auth/quota'))).toHaveLength(1);
  });
});
