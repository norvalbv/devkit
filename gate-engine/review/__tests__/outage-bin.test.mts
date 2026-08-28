import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  writeArtifact,
} from './run-review-fixtures.mts';

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'GUARD_REVIEW_MODEL',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CODEX_BIN',
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  delete process.env.GUARD_CODEX_BIN;
  process.env.GUARD_AI_STRICT = '1';
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

// Domain reviewers FAIL first pass (forcing the escalation), pinned single-pass reviewers PASS
// with a real artifact so only the cascade path under test can go inconclusive.
const failFirstPassExec = (repo: string, escalateResult: string | null) =>
  mkExec(async ({ label }: { label: string }) => {
    if (label === 'review:correctness-reviewer' || label === 'review:conventions-reviewer') {
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    }
    if (label.endsWith(':escalate')) return escalateResult;
    return 'sus\nVERDICT: FAIL — maybe';
  });

describe('strict outage remedy names the dark binary', () => {
  it('a dark CLAUDE escalation after a codex first pass says claude — never codex', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra@high';
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: failFirstPassExec(repo, null) })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('check `claude` CLI auth/quota');
    expect(out).not.toContain('check `codex` CLI auth/quota');
  });

  it('a dark CODEX first pass says codex — never claude', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra@high';
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }: { label: string }) => {
      if (label === 'review:correctness-reviewer' || label === 'review:conventions-reviewer') {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      return null; // every codex-routed first pass goes dark; no escalation ever spawns
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('check `codex` CLI auth/quota');
    expect(out).not.toContain('check `claude` CLI auth/quota');
  });

  it('an engine-error rejection on a mixed family names BOTH candidate binaries', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra@high';
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }: { label: string }) => {
      if (label === 'review:correctness-reviewer' || label === 'review:conventions-reviewer') {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      throw new Error('spawn layer exploded');
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('check `codex` or `claude` CLI auth/quota');
  });

  it('a dark codex escalation names codex too (same-family cascade stays correct)', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra@high';
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'gpt-5.6-sol';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: failFirstPassExec(repo, null) })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('check `codex` CLI auth/quota');
    expect(out).not.toContain('check `claude` CLI auth/quota');
  });
});
