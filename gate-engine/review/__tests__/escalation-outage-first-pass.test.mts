import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { loadCache } from '../cache.mts';
import { runCascade } from '../cascade/reviewer.mts';
import { settleReviewOutcome, type SettleCtx } from '../recovery/settle.mts';
import { planReviewWork } from '../lens/split.mts';
import { REVIEWERS } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { ReviewGateTiming } from '../telemetry/timing.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  writeArtifact,
} from './run-review-fixtures.mts';

const UNCONFIRMED = 'first pass (unconfirmed — its escalation never answered)';
const ADVISORY = `guard-review: commit-guard — advisory (non-blocking): ${UNCONFIRMED}`;
const ENV_KEYS = ['GUARD_AI_STRICT', 'DEVKIT_GATE_EVENTS', 'GUARD_CODEX_BIN'] as const;
const saved = new Map<string, string | undefined>();
let events = '';

beforeEach(() => {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  delete process.env.GUARD_CODEX_BIN;
  process.env.GUARD_AI_STRICT = '1';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupReviewFixtures();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const printed = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
const advisoryRows = () =>
  existsSync(events)
    ? readFileSync(events, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === 'advisory_result')
    : [];

/** commit-guard's first pass FAILs; `escalate` answers its escalation (null = the judge is dark). */
const gateRepo = (escalate: (label: string) => string | null, firstPass = 'VERDICT: FAIL') => {
  const repo = consumerRepo({ backend: true });
  events = join(repo, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = events;
  const exec = mkExec(async ({ label }: { label: string }) => {
    if (label === 'review:correctness-reviewer' || label === 'review:conventions-reviewer') {
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    }
    if (label.endsWith(':escalate')) return escalate(label);
    return firstPass === 'VERDICT: FAIL'
      ? 'VERDICT: FAIL — duplicates fooHelper in a.ts'
      : firstPass;
  });
  return { repo, exec };
};

describe('a cascade first-pass FAIL whose escalation never answers', () => {
  it('prints the finding as an unconfirmed advisory before the fail-closed Remedy', async () => {
    const { repo, exec } = gateRepo(() => null);
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const lines = printed();
    const advisory = lines.findIndex((l) => l === `${ADVISORY}: duplicates fooHelper in a.ts`);
    const remedy = lines.findIndex((l) => l.includes('Remedy:'));
    expect(advisory).toBeGreaterThan(-1);
    expect(advisory).toBeLessThan(remedy);
    expect(lines[advisory]).not.toMatch(/FAIL/);
    expect(advisoryRows().filter((e) => e.gate === 'review:commit-guard')).toEqual([
      expect.objectContaining({
        status: 'finding',
        detail: `${UNCONFIRMED}: duplicates fooHelper in a.ts`,
      }),
    ]);
  });

  it('still prints it when another reviewer blocks the run first', async () => {
    const repo = consumerRepo({ backend: true });
    events = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = events;
    const exec = mkExec(async ({ label }: { label: string }) => {
      if (label === 'review:conventions-reviewer') {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      if (label === 'review:correctness-reviewer') return 'VERDICT: FAIL — off-by-one in a.ts';
      if (label.endsWith(':escalate')) return null;
      return 'VERDICT: FAIL — duplicates fooHelper in a.ts';
    });
    expect(await runReviewGate(repo, { exec })).not.toBe(0);
    expect(printed()).toContain(`${ADVISORY}: duplicates fooHelper in a.ts`);
  });
});

describe('a first pass that spends the whole cascade budget', () => {
  it('keeps its reason on the skipped-escalation outcome', async () => {
    const repo = consumerRepo({ backend: true });
    const reviewer = REVIEWERS.find((r) => r.name === 'api-security-reviewer');
    if (!reviewer) throw new Error('api-security-reviewer must exist');
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const exec = mkExec(async ({ label, timeout }) => {
      clock += Number(timeout);
      writeArtifact(repo, label, { failed: 1 });
      return 'VERDICT: FAIL — unauthenticated route';
    });
    const res = await runCascade(
      { reviewer, files: ['src/main/db.ts'] },
      { cwd: repo, cfg: resolveGuardConfig(repo), exec, judgeTimeoutMs: 300_000 },
    );
    expect(res).toMatchObject({
      status: 'inconclusive',
      inconclusiveCause: 'timeout',
      firstPassReason: 'unauthenticated route',
    });
    expect(exec.mock.calls.some(([o]) => o.label.endsWith(':escalate'))).toBe(false);
  });
});

describe('outcomes that surface no first pass', () => {
  it.each([
    ['the escalation confirms the FAIL', () => 'VERDICT: FAIL — confirmed duplicate'],
    ['the escalation overturns it', () => 'VERDICT: PASS — not a duplicate'],
  ])('%s', async (_, escalate) => {
    const { repo, exec } = gateRepo(escalate);
    await runReviewGate(repo, { exec });
    expect(printed().some((l) => l.includes(UNCONFIRMED))).toBe(false);
  });

  it('the first pass itself is dark (nothing was judged)', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }: { label: string }) => {
      if (label === 'review:correctness-reviewer' || label === 'review:conventions-reviewer') {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      return null;
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(printed().some((l) => l.includes(UNCONFIRMED))).toBe(false);
  });
});

describe('settling an inconclusive outcome', () => {
  const reviewer = REVIEWERS.find((r) => r.name === 'commit-guard');
  if (!reviewer) throw new Error('commit-guard must exist');
  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+let shared = 0;\n';
  const settle = (outcome: ReviewOutcome) => {
    const cwd = consumerRepo({ backend: true });
    const ctx: SettleCtx = {
      cwd,
      firstModel: 'haiku',
      progressFile: null,
      running: [],
      completed: [],
      splitParts: new Map(),
      timing: new ReviewGateTiming(),
      verifyAssets: (o) => o,
    };
    const keyOf = (name: string, diff: string, salt: string) => `${name}|${diff}|${salt}`;
    const work = planReviewWork(
      [{ reviewer, files: ['src/a.ts'] }],
      [DIFF],
      loadCache(cwd),
      new Map(),
      keyOf,
      null,
      null,
    );
    settleReviewOutcome(ctx, work.tasks[0], outcome, 1000);
  };
  const skipped: ReviewOutcome = {
    name: 'commit-guard',
    status: 'inconclusive',
    reason: 'escalation skipped — the first pass spent the whole budget',
    inconclusiveCause: 'timeout',
    escalated: false,
    transcript: 'VERDICT: FAIL',
  };

  it('names a bare first-pass verdict instead of printing nothing, with the transcript ref', () => {
    vi.stubEnv('DEVKIT_SHIP_ID', 'ship-test');
    settle({ ...skipped, firstPassReason: '' });
    const lines = printed();
    expect(lines).toContain(`${ADVISORY}: (no reason given)`);
    expect(lines.some((l) => l.includes('full reasoning: guard-review transcript'))).toBe(true);
  });

  it('prints no advisory for an inconclusive outcome that carries no first pass', () => {
    settle(skipped);
    expect(printed().some((l) => l.includes(UNCONFIRMED))).toBe(false);
  });
});
