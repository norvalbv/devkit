import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mts';
import { FOUR_WAY_LENS_GROUPS, lensGroupId } from '../lens/split.mts';
import { REVIEWERS } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  passWithArtifact,
  reviewAssets,
  writeArtifact,
} from './run-review-fixtures.mts';

// Env hygiene: the gate reads GUARD_*/FRINK_* — a developer's real env must not steer assertions.
const ENV_KEYS = [
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_REVIEW_MODEL',
  'FRINK_REVIEW_MODEL',
  'GUARD_REVIEW_SKIP',
  'FRINK_REVIEW_SKIP',
  'GUARD_REVIEW_NO_TOPOLOGY_WARN',
  'FRINK_REVIEW_NO_TOPOLOGY_WARN',
  'GUARD_REVIEW_CONCURRENCY',
  'FRINK_REVIEW_CONCURRENCY',
  'GUARD_NO_COMPLETENESS',
  'FRINK_NO_COMPLETENESS',
  'GUARD_COMPLETENESS_HARD',
  'FRINK_COMPLETENESS_HARD',
  'GUARD_NO_LOG',
  'FRINK_NO_LOG',
  'GUARD_DECISION_NO_LLM',
  'FRINK_DECISION_NO_LLM',
  'DEVKIT_REVIEW_PROGRESS',
  'DEVKIT_RUN_MODE',
  'DEVKIT_REVIEW_ID',
  'DEVKIT_REVIEW_ASSET_ROOT',
  'DEVKIT_REVIEW_DATA_ROOT',
  'DEVKIT_REVIEW_BACKEND_ROOTS',
  'DEVKIT_REVIEW_FRONTEND_ROOTS',
  // DEVKIT_NO_TELEMETRY stays set by vitest.setup; clearing it here would make off-ship runs capture.
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'GUARD_CORRECTNESS_SPLIT',
  // sc-1442: the ship-exported message file + the embed kill-switch (the message subject activates
  // semantic Target retrieval, which must stay deterministic/off in tests).
  'DEVKIT_COMMIT_MSG_FILE',
  'DECISIONS_NO_EMBED',
  // The completeness sticky key is scoped to the shipping branch, so a developer running the suite
  // DURING a ship (which exports this) would otherwise key verdicts to that ship's branch.
  'DEVKIT_SHIP_BRANCH',
  // The deferred recovery phase's budget. A developer running the suite inside a real ship inherits
  // the supervisor's live deadline, which would starve the recovery tests of budget.
  'SHIP_COMMIT_TIMEOUT',
  'DEVKIT_GATE_DEADLINE_MS',
];
const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // writeArtifact resolves one un-lensed stateFile, which the shipped per-lens fan-out defeats.
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('runReviewGate — deferred checklist recovery (sc-1476)', () => {
  const reviewEnv = (repo: string) => {
    const assets = reviewAssets();
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = assets;
    process.env.GUARD_REVIEW_CONCURRENCY = '3';
    process.env.DEVKIT_GATE_EVENTS = join(repo, 'events.jsonl');
    process.env.DEVKIT_SHIP_ID = 'ship-deferred-recovery';
    process.env.DEVKIT_REVIEW_PROGRESS = join(repo, 'progress.json');
  };
  const events = (repo: string) =>
    readFileSync(join(repo, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('a contention-voided PASS recovers SOLO after the wave, marked retried', async () => {
    const repo = consumerRepo({ backend: true });
    reviewEnv(repo);
    let inflight = 0;
    const attempts = new Map<string, number>();
    const calls: { label: string; solo: boolean; completedNow: string[] }[] = [];
    const exec = mkExec(async ({ label }) => {
      inflight++;
      try {
        await new Promise((r) => setTimeout(r, 20)); // force the wave to overlap
        const solo = inflight === 1; // sampled MID-RUN: was any sibling judging alongside?
        const attempt = (attempts.get(label) ?? 0) + 1;
        attempts.set(label, attempt);
        let completedNow: string[] = [];
        try {
          completedNow = JSON.parse(readFileSync(join(repo, 'progress.json'), 'utf8')).completed;
        } catch {}
        calls.push({ label, solo, completedNow });
        if (attempt > 1) writeArtifact(repo, label); // compliant only on the post-wave attempt
        return 'VERDICT: PASS';
      } finally {
        inflight--;
      }
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const rows = events(repo).filter((e) => e.type === 'review_result');
    // api-security ran in the first (contended) wave: parked, recovered solo, marked retried.
    const api = rows.find((e) => e.reviewer === 'api-security-reviewer');
    expect(api?.status).toBe('pass');
    expect(api?.retried).toBe(true);
    expect(api?.retry_phase).toBe('deferred');
    const apiCalls = calls.filter((c) => c.label === 'review:api-security-reviewer');
    expect(apiCalls).toHaveLength(2); // one wave attempt + ONE deferred attempt
    expect(apiCalls[1].solo).toBe(true); // the recovery ran with no sibling in flight
    // Progress honesty: at the moment the deferred attempt ran, the reviewer was NOT yet
    // completed — a kill mid-recovery must still name it unfinished (ship convergence).
    expect(apiCalls[1].completedNow).not.toContain('api-security-reviewer');
    // Every retried row recovered to a clean PASS; nothing stayed voided.
    expect(rows.every((e) => e.status === 'pass')).toBe(true);
  });

  it('the commit/ship path gains NO deferral: one judge run, inconclusive, fail-open', async () => {
    const repo = consumerRepo({ backend: true });
    // Stated, not inherited: the commit/ship lane is defined by the ABSENCE of the review-mode
    // keys, so pin them here rather than leaning on suite cleanup or test order for the contrast.
    delete process.env.DEVKIT_RUN_MODE;
    delete process.env.DEVKIT_REVIEW_ASSET_ROOT;
    delete process.env.DEVKIT_REVIEW_PROGRESS;
    const exec = mkExec(async () => 'VERDICT: PASS'); // never writes an artifact
    expect(await runReviewGate(repo, { exec })).toBe(2);
    const apiCalls = exec.mock.calls.filter((c) => c[0].label === 'review:api-security-reviewer');
    expect(apiCalls).toHaveLength(1); // the review-only retry must never leak into commits/ships
  });

  it('a deferred lens part still lands in ONE merged review_result carrying all four groups', async () => {
    delete process.env.GUARD_CORRECTNESS_SPLIT; // the shipped four-way default
    const repo = consumerRepo({ backend: true });
    reviewEnv(repo);
    const failLens = 'state-transitions';
    let targetCalls = 0;
    const exec = mkExec(async ({ label, args }) => {
      writeArtifact(repo, label);
      const groups: readonly (readonly string[])[] = FOUR_WAY_LENS_GROUPS;
      const group = groups.find((g) => args[1].includes(g[0]));
      if (label === 'review:correctness-reviewer' && group) {
        const isTarget = group[0] === failLens;
        if (isTarget) targetCalls++;
        // The target group withholds its artifact on the FIRST (contended-wave) attempt only.
        if (!isTarget || targetCalls > 1) {
          writeFileSync(
            join(repo, `.claude/.correctness-review-${lensGroupId(group)}.json`),
            JSON.stringify({
              items: [{ name: group[0], category: 'X', status: 'pass', issues: [] }],
            }),
          );
        }
      }
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const rows = events(repo).filter(
      (e) => e.type === 'review_result' && e.reviewer === 'correctness-reviewer',
    );
    expect(rows).toHaveLength(1); // gate-verdict-attribution: ONE row however the parts settled
    expect(rows[0].lens_parts).toHaveLength(FOUR_WAY_LENS_GROUPS.length);
    // SAFETY: the assertion above pins lens_parts to the four-group length, so the array is
    // present and every entry is a settled lens part with these fields.
    const parts = rows[0].lens_parts as { lens: string; retried?: boolean; status: string }[];
    expect(parts.find((p) => p.lens === failLens)?.retried).toBe(true);
    expect(parts.every((p) => p.status === 'pass')).toBe(true);
    expect(rows[0].retried).toBe(true);
    expect(targetCalls).toBe(2);
  });
});

describe('runReviewGate — checklist recovery on the strict ship path (sc-2088)', () => {
  const TARGET = 'review:api-security-reviewer';
  const shipEnv = (repo: string) => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_REVIEW_CONCURRENCY = '3';
    process.env.DEVKIT_GATE_EVENTS = join(repo, 'events.jsonl');
    process.env.DEVKIT_SHIP_ID = 'ship-sc-2088';
  };
  const events = (repo: string) =>
    readFileSync(join(repo, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  // Every reviewer but TARGET honours the contract; TARGET leaves `pending` items unresolved on the
  // attempts named by `missOn` — the prose-PASS-without-mutations shape the story reports.
  const judgeMissing = (repo: string, missOn: (attempt: number) => boolean, pending = 92) => {
    const attempts = new Map<string, number>();
    return mkExec(async ({ label }) => {
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      writeArtifact(repo, label, {
        pending: label === TARGET && missOn(attempt) ? pending : 0,
      });
      return 'VERDICT: PASS';
    });
  };

  it('a contract-missing PASS recovers SOLO after the wave and the ship goes green', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = judgeMissing(repo, (attempt) => attempt === 1);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const row = events(repo).find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    expect(row?.status).toBe('pass');
    expect(row?.retried).toBe(true);
    expect(row?.retry_phase).toBe('deferred');
    // ONE deferred attempt, not an unbounded loop, and only for the reviewer that missed.
    expect(exec.mock.calls.filter(([o]) => o.label === TARGET)).toHaveLength(2);
  });

  it('a recovered PASS caches under the SAME key as a first-attempt PASS', async () => {
    const recovered = consumerRepo({ backend: true });
    shipEnv(recovered);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(recovered, { exec: judgeMissing(recovered, (a) => a === 1) })).toBe(
      0,
    );
    const clean = consumerRepo({ backend: true });
    shipEnv(clean);
    expect(await runReviewGate(clean, { exec: passWithArtifact(clean) })).toBe(0);
    // retried/retry_phase must never salt the verdict cache: a recovered PASS has to be replayable
    // by an ordinary re-run, or ship convergence silently re-pays for it every attempt.
    expect(Object.keys(loadCache(recovered)).sort()).toEqual(Object.keys(loadCache(clean)).sort());
  });

  it('a retry that ALSO misses stays INCONCLUSIVE at exit 3 — never a reviewer FAIL', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: judgeMissing(repo, () => true) })).toBe(3);
    const row = events(repo).find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    // Exit 3, not 1. The husky fragment renders exit 1 as "A reviewer FAILED
    // (escalation-confirmed)" — a verdict claim about the diff, for what is a judge that never
    // engaged its workflow. Exit 3 says "judge unavailable after retry", which is the truth.
    expect(row?.status).toBe('inconclusive');
    expect(err.mock.calls.flat().join('\n')).not.toContain('REVIEW ERROR');
    expect(loadCache(repo)['api-security-reviewer']).toBeUndefined();
  });

  it('the exhausted retry reports the ratio the judge actually left behind', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: judgeMissing(repo, () => true, 7) })).toBe(3);
    const row = events(repo).find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    // writeArtifact always emits one passing row alongside the pending ones.
    expect(row?.item_count).toBe(8);
    expect(row?.item_tally).toEqual({ pass: 1, pending: 7 });
    expect(row?.item_artifact).toBe('items');
  });

  it('plain git commit keeps its instant fail-open — no deferred phase without a supervisor', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.DEVKIT_GATE_EVENTS = join(repo, 'events.jsonl');
    process.env.DEVKIT_SHIP_ID = 'commit-sc-2088';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = judgeMissing(repo, () => true);
    // Non-strict: exit 2, the commit lands. A recovery here would serialize judges at up to
    // DEEP_JUDGE_TIMEOUT_MS each with nothing able to kill them, and the extra wall-clock would
    // widen the staged-tree tamper window into a hard exit-1 block on a mid-gate restage.
    expect(await runReviewGate(repo, { exec })).toBe(2);
    expect(exec.mock.calls.filter(([o]) => o.label === TARGET)).toHaveLength(1);
    expect(err.mock.calls.flat().join('\n')).toContain('fail-open');
  });

  it('a budget the supervisor will not grant produces a NAMED skip, not a doomed judge', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The supervisor wraps the WHOLE `git commit`, so by the time guard-review parks a reviewer the
    // deterministic prefix and decisions cascade have already spent budget this gate never saw.
    // Reading its absolute deadline is the only way to know that; deriving it from
    // SHIP_COMMIT_TIMEOUT minus THIS gate's elapsed time over-counts by the whole prefix and starts
    // a 30-minute judge with seconds left, which the supervisor then kills as an opaque 124.
    process.env.SHIP_COMMIT_TIMEOUT = '3600';
    process.env.DEVKIT_GATE_DEADLINE_MS = String(Date.now() + 5_000);
    const exec = judgeMissing(repo, () => true);
    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(exec.mock.calls.filter(([o]) => o.label === TARGET)).toHaveLength(1); // no second judge
    expect(err.mock.calls.flat().join('\n')).toContain('budget exhausted');
  });

  // A hole is not one fact. An artifact left INCOMPLETE is a judge that engaged and stopped; an
  // artifact that never EXISTED is (on the commit/ship path, which has no review-mode preflight) a
  // consumer whose checklist scripts were never synced. The two need different remedies, and the
  // non-recovery branch has always distinguished them — the recovery path must not flatten them.
  it('an artifact that never existed keeps the SYNC cause, not response-contract', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // TARGET never writes an artifact at all — not on the wave attempt, not on the recovery.
    const exec = mkExec(async ({ label }) => {
      if (label !== TARGET) writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const row = events(repo).find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    expect(row?.status).toBe('inconclusive');
    expect(row?.inconclusive_cause).toBe('sync');
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('devkit sync-agents && devkit sync-skills');
    expect(out).not.toContain('did not satisfy its declared contract');
  });

  it('review mode still BLOCKS an exhausted retry at exit 1, unchanged by the widening', async () => {
    const repo = consumerRepo({ backend: true });
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_ASSET_ROOT = reviewAssets();
    process.env.GUARD_AI_STRICT = '1'; // review runs under the same strict shell as ship
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label, { pending: label === TARGET ? 4 : 0 });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('api-security-reviewer REVIEW ERROR');
  });

  it('a recovery judge that returns FAIL blocks the ship on the finding, not the contract', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const attempts = new Map<string, number>();
    const exec = mkExec(async ({ label }) => {
      // An unpinned reviewer's FAIL escalates under a SECOND label; letting that call fall through
      // to the passing branch would overturn the very FAIL this test exists to follow.
      if (label === `${TARGET}:escalate`) {
        writeArtifact(repo, TARGET, { failed: 1 });
        return 'confirmed\nVERDICT: FAIL';
      }
      if (label !== TARGET) {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      if (attempt === 1) {
        writeArtifact(repo, label, { pending: 5 }); // parks
        return 'VERDICT: PASS';
      }
      writeArtifact(repo, label, { failed: 1 });
      return 'found a real one\nVERDICT: FAIL';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('api-security-reviewer FAILED');
    expect(out).not.toContain('checklist contract failed after one retry');
  });

  it('an OUTAGE during the recovery keeps the auth/quota remedy, not an artifact one', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const attempts = new Map<string, number>();
    const exec = mkExec(async ({ label }) => {
      if (label !== TARGET) {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      if (attempt === 1) {
        writeArtifact(repo, label, { pending: 6 }); // parks
        return 'VERDICT: PASS';
      }
      return null; // the deferred judge goes dark
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('CLI auth/quota');
    expect(out).not.toContain('did not satisfy its declared contract');
    expect(out).not.toContain('devkit sync-agents && devkit sync-skills');
  });

  it('a budget consumed by the FIRST recovery makes the SECOND take the named skip', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVKIT_GATE_DEADLINE_MS = String(Date.now() + 3_600_000);
    const second = 'review:backend-performance-reviewer';
    const attempts = new Map<string, number>();
    const exec = mkExec(async ({ label }) => {
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      const parks = (label === TARGET || label === second) && attempt === 1;
      // Standing in for wall-clock: the first recovery to run burns the whole remaining budget.
      if (!parks && (label === TARGET || label === second))
        process.env.DEVKIT_GATE_DEADLINE_MS = String(Date.now() - 1);
      writeArtifact(repo, label, { pending: parks ? 2 : 0 });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('budget exhausted');
    // Exactly one deferred judge ran across the two parked reviewers.
    const recoveries = [TARGET, second].filter((l) => (attempts.get(l) ?? 0) > 1);
    expect(recoveries).toHaveLength(1);
  });

  it('caps the recovery judge at the budget left, so it cannot outlive the supervisor', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVKIT_GATE_DEADLINE_MS = String(Date.now() + 300_000);
    const timeouts: number[] = [];
    const attempts = new Map<string, number>();
    const exec = mkExec(async ({ label, timeout }) => {
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      const parks = label === TARGET && attempt === 1;
      if (label === TARGET && !parks) timeouts.push(Number(timeout));
      writeArtifact(repo, label, { pending: parks ? 4 : 0 });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThan(300_000);
    expect(timeouts[0]).toBeGreaterThan(0);
  });

  it('spends ONE budget across the whole recovery cascade, not one per judge', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVKIT_GATE_DEADLINE_MS = String(Date.now() + 300_000);
    const caps: number[] = [];
    const attempts = new Map<string, number>();
    const exec = mkExec(async ({ label, timeout }) => {
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      if (label === TARGET && attempt === 1) {
        writeArtifact(repo, label, { pending: 3 }); // parks
        return 'VERDICT: PASS';
      }
      if (label === TARGET) {
        caps.push(Number(timeout));
        writeArtifact(repo, label, { failed: 1 });
        return 'VERDICT: FAIL'; // drives the recovery into its escalation
      }
      if (label === `${TARGET}:escalate`) {
        caps.push(Number(timeout));
        writeArtifact(repo, TARGET, { failed: 1 });
        return 'confirmed\nVERDICT: FAIL';
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    // An unpinned reviewer's recovery runs a first pass AND an escalation. Capping each at the full
    // remaining budget would let the pair run to twice the ceiling the supervisor will grant.
    expect(caps).toHaveLength(2);
    expect(caps[1]).toBeLessThanOrEqual(caps[0]);
    expect(caps[0] + caps[1]).toBeLessThanOrEqual(2 * 300_000);
    expect(caps[1]).toBeLessThan(300_000);
  });

  it('classifies the hole from the SETTLED artifact, not the first attempt stale one', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const attempts = new Map<string, number>();
    // Wave attempt leaves NO artifact (a sync-shaped hole); the recovery judge engages and leaves a
    // PENDING one. The remedy must follow the attempt that actually ran last.
    const exec = mkExec(async ({ label }) => {
      if (label !== TARGET) {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      const attempt = (attempts.get(label) ?? 0) + 1;
      attempts.set(label, attempt);
      if (attempt > 1) writeArtifact(repo, label, { pending: 5 });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const row = events(repo).find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    expect(row?.inconclusive_cause).toBe('response-contract');
    const out = err.mock.calls.flat().join('\n');
    expect(out).not.toContain('devkit sync-agents && devkit sync-skills');
  });

  it('an artifact that exists but enumerated nothing is the judge hole, not a sync gap', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stateFile = String(REVIEWERS.find((r) => r.name === 'api-security-reviewer')?.stateFile);
    const exec = mkExec(async ({ label }) => {
      if (label !== TARGET) {
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      }
      // The script RAN and enumerated nothing, without the sc-1439 `skipped` reason that would make
      // an empty artifact valid. Telling this operator to sync skills points at the wrong thing.
      writeFileSync(join(repo, stateFile), JSON.stringify({ items: [] }));
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(3);
    const row = events(repo).find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    expect(row?.inconclusive_cause).toBe('response-contract');
    expect(err.mock.calls.flat().join('\n')).not.toContain(
      'devkit sync-agents && devkit sync-skills',
    );
  });

  it('an unparseable deadline falls back to the duration budget instead of disabling the guard', async () => {
    const repo = consumerRepo({ backend: true });
    shipEnv(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DEVKIT_GATE_DEADLINE_MS = 'not-a-timestamp';
    process.env.SHIP_COMMIT_TIMEOUT = '0'; // fallback budget is already spent
    const exec = judgeMissing(repo, () => true);
    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(exec.mock.calls.filter(([o]) => o.label === TARGET)).toHaveLength(1);
    expect(err.mock.calls.flat().join('\n')).toContain('budget exhausted');
  });
});
