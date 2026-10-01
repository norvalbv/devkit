import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache, savePasses } from '../cache.mts';
import { RETRIEVAL_UNRECORDED } from '../contracts/checklist.mts';
import { CACHED_RETRIEVAL_UNPROVEN } from '../evidence/base-context.mts';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  type RetrievalFixture,
  writeArtifact,
} from './run-review-fixtures.mts';

// sc-2317: commit-guard's PASS without semantic retrieval must never read as a clean PASS — not on
// the live completion line, not in telemetry, and not when a later run replays it from the cache.

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
  'GUARD_REVIEW_SKIP',
  'FRINK_REVIEW_SKIP',
  'GUARD_NO_REVIEW',
  'FRINK_NO_REVIEW',
  'GUARD_REVIEW_CONCURRENCY',
  'DEVKIT_RUN_MODE',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_REVIEW_PROGRESS',
  'DEVKIT_COMMIT_MSG_FILE',
  'DEVKIT_SHIP_BRANCH',
  'SHIP_COMMIT_TIMEOUT',
  'DEVKIT_GATE_DEADLINE_MS',
  'GUARD_CORRECTNESS_SPLIT',
];
const saved: Record<string, string | undefined> = {};
let stderr: string[];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderr.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupReviewFixtures();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const UNREACHABLE: RetrievalFixture = {
  status: 'unavailable',
  cause: 'remote embeddings unreachable',
};

/** A PASS judge whose commit-guard artifact records `retrieval` as given (null = not recorded). */
const passRecording = (repo: string, retrieval: RetrievalFixture) =>
  mkExec(async ({ label }) => {
    writeArtifact(repo, label, { retrieval });
    return 'staged test is scoped and consistent\nVERDICT: PASS';
  });

/** The fields of a sink row these assertions read. */
interface SinkRow {
  type?: string;
  judge?: string;
  cause?: string;
  detail?: string;
  reviewer?: string;
  status?: string;
  retried?: boolean;
  degraded_cause?: string;
}

function captureEvents(repo: string): () => SinkRow[] {
  const sink = join(repo, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-2317';
  return () =>
    readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l): SinkRow => JSON.parse(l));
}

const commitGuardCacheEntry = (repo: string) =>
  Object.values(loadCache(repo)).filter((m) => 'degraded_cause' in m);

// A commit-guard completion or cache line whose PASS is NOT immediately marked (DEGRADED).
const bareCommitGuardPass = (lines: string[]) =>
  lines.filter((l) => /guard-review: commit-guard — (cached )?PASS(?! \(DEGRADED\))/.test(l));

describe('commit-guard PASS without semantic retrieval (sc-2317)', () => {
  it('prints DEGRADED on the completion line, a ⚠️ advisory, and never a bare PASS', async () => {
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: passRecording(repo, UNREACHABLE) })).toBe(0);
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: commit-guard — PASS \(DEGRADED\) in \d+s/),
    );
    expect(stderr).toContainEqual(
      expect.stringMatching(
        /^⚠️ {2}guard-review: commit-guard — DEGRADED: semantic retrieval unavailable: remote embeddings unreachable/,
      ),
    );
    expect(bareCommitGuardPass(stderr)).toEqual([]);
  });

  it('emits gate_degraded and stamps the review_result row with the cause', async () => {
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    expect(await runReviewGate(repo, { exec: passRecording(repo, UNREACHABLE) })).toBe(0);
    const all = events();
    const degraded = all.filter((e) => e.type === 'gate_degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({
      judge: 'commit-guard',
      cause: 'remote embeddings unreachable',
    });
    expect(String(degraded[0].detail)).toContain('semantic retrieval unavailable');
    const row = all.find((e) => e.type === 'review_result' && e.reviewer === 'commit-guard');
    expect(row).toMatchObject({ status: 'pass', degraded_cause: 'remote embeddings unreachable' });
  });

  it('a cache hit on the same diff replays DEGRADED and re-emits gate_degraded', async () => {
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passRecording(repo, UNREACHABLE) });
    expect(commitGuardCacheEntry(repo)).toHaveLength(1);
    stderr.length = 0;
    const events = captureEvents(repo);
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(stderr).toContainEqual(
      expect.stringMatching(
        /^guard-review: commit-guard — cached PASS \(DEGRADED\) \(identical diff/,
      ),
    );
    expect(bareCommitGuardPass(stderr)).toEqual([]);
    expect(events().filter((e) => e.type === 'gate_degraded')).toEqual([
      expect.objectContaining({ judge: 'commit-guard', cause: 'remote embeddings unreachable' }),
    ]);
  });

  it('an unrecorded retrieval (stale synced script / forgetful judge) degrades — never assumed ok', async () => {
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    expect(await runReviewGate(repo, { exec: passRecording(repo, null) })).toBe(0);
    expect(events().find((e) => e.type === 'gate_degraded')).toMatchObject({
      judge: 'commit-guard',
      cause: RETRIEVAL_UNRECORDED,
    });
    expect(bareCommitGuardPass(stderr)).toEqual([]);
  });

  it.each([
    ['a typo’d status', { status: 'unavailble', cause: 'x' }],
    ['unavailable with a blank cause', { status: 'unavailable', cause: '   ' }],
    ['a bare string', 'ok'],
  ])('a malformed record (%s) degrades as unrecorded', async (_, retrieval) => {
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    expect(await runReviewGate(repo, { exec: passRecording(repo, retrieval) })).toBe(0);
    expect(events().find((e) => e.type === 'gate_degraded')?.cause).toBe(RETRIEVAL_UNRECORDED);
  });

  it('retrieval ok stays a clean PASS: no DEGRADED line, no event, no cached flag', async () => {
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    expect(await runReviewGate(repo, { exec: passRecording(repo, { status: 'ok' }) })).toBe(0);
    expect(stderr.join('\n')).not.toContain('DEGRADED');
    expect(events().filter((e) => e.type === 'gate_degraded')).toEqual([]);
    expect(commitGuardCacheEntry(repo)).toEqual([]);
    expect(Object.values(loadCache(repo)).filter((m) => m.retrieval === 'ok')).toHaveLength(1);
    stderr.length = 0;
    await runReviewGate(repo, { exec: mkExec(async () => 'VERDICT: PASS') });
    expect(stderr).toContain('guard-review: commit-guard — cached PASS (identical diff)');
  });

  it('only commit-guard degrades: other reviewers keep their bare PASS on the same run', async () => {
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: passRecording(repo, UNREACHABLE) })).toBe(0);
    const degradedLines = stderr.filter((l) => l.includes('DEGRADED'));
    expect(degradedLines.length).toBeGreaterThan(0);
    expect(degradedLines.every((l) => l.includes('commit-guard'))).toBe(true);
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: correctness-reviewer — PASS in/),
    );
  });

  it('strict ship mode does not fail closed on a degraded PASS — visible, not blocking', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: passRecording(repo, UNREACHABLE) })).toBe(0);
    expect(stderr.join('\n')).toContain('PASS (DEGRADED)');
  });

  it('a judge FAIL never carries a DEGRADED marker, even with retrieval unavailable', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label, { failed: 1, retrieval: UNREACHABLE });
      return label.includes('commit-guard')
        ? 'src/fixture.ts:1 duplicates src/other.ts:1\nVERDICT: FAIL — duplicate'
        : 'VERDICT: PASS';
    });
    await runReviewGate(repo, { exec });
    expect(stderr.join('\n')).not.toContain('DEGRADED');
    expect(commitGuardCacheEntry(repo)).toEqual([]);
  });

  it('a strict-ship checklist-contract recovery that lands on unavailable still reports DEGRADED', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = consumerRepo({ backend: true });
    const events = captureEvents(repo);
    let commitGuardCalls = 0;
    const exec = mkExec(async ({ label }) => {
      const cg = label === 'review:commit-guard';
      // First commit-guard attempt leaves an unresolved row (contract hole → deferred solo retry).
      const first = cg && commitGuardCalls++ === 0;
      writeArtifact(repo, label, { pending: first ? 1 : 0, retrieval: UNREACHABLE });
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(commitGuardCalls).toBe(2);
    const row = events().find((e) => e.type === 'review_result' && e.reviewer === 'commit-guard');
    expect(row).toMatchObject({
      status: 'pass',
      retried: true,
      degraded_cause: 'remote embeddings unreachable',
    });
    expect(bareCommitGuardPass(stderr)).toEqual([]);
    expect(commitGuardCacheEntry(repo)).toHaveLength(1);
  });

  it('a malformed cached degraded_cause replays DEGRADED (unproven), never a bare PASS', async () => {
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passRecording(repo, UNREACHABLE) });
    const degradedEntries = Object.entries(loadCache(repo)).filter(
      ([, m]) => 'degraded_cause' in m,
    );
    expect(degradedEntries).toHaveLength(1);
    for (const [key, meta] of degradedEntries)
      savePasses(repo, { [key]: { ...meta, degraded_cause: 42 } });
    stderr.length = 0;
    expect(await runReviewGate(repo, { exec: mkExec(async () => 'VERDICT: PASS') })).toBe(0);
    expect(stderr).toContainEqual(expect.stringContaining(CACHED_RETRIEVAL_UNPROVEN));
    expect(bareCommitGuardPass(stderr)).toEqual([]);
  });

  it('a legacy cached PASS without a retrieval stamp replays DEGRADED, never a bare PASS', async () => {
    const repo = consumerRepo({ backend: true });
    await runReviewGate(repo, { exec: passRecording(repo, { status: 'ok' }) });
    const stamped = Object.entries(loadCache(repo)).filter(([, m]) => m.retrieval === 'ok');
    expect(stamped).toHaveLength(1);
    // Rewrite it as a pre-sc-2317 entry: same key, no retrieval field.
    for (const [key, { retrieval: _dropped, ...legacy }] of stamped)
      savePasses(repo, { [key]: legacy });
    stderr.length = 0;
    expect(await runReviewGate(repo, { exec: mkExec(async () => 'VERDICT: PASS') })).toBe(0);
    expect(stderr).toContainEqual(expect.stringMatching(/commit-guard — cached PASS \(DEGRADED\)/));
    expect(bareCommitGuardPass(stderr)).toEqual([]);
  });
});
