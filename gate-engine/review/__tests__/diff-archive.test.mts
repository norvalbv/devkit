import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveFailedDiff } from '../evidence/diff-archive.mts';
import { REVIEWERS } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('archiveFailedDiff', () => {
  const saved = { file: process.env.DEVKIT_GATE_EVENTS };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'diff-archive-'));
    process.env.DEVKIT_GATE_EVENTS = path.join(dir, 'gate-events.jsonl');
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.DEVKIT_GATE_EVENTS;
    else process.env.DEVKIT_GATE_EVENTS = saved.file;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes <telemetry-dir>/diffs/<sha256>.diff.gz, gzipped, and returns the relative ref', () => {
    const diffText = '--- a/x.ts\n+++ b/x.ts\n@@\n-old\n+new\n';
    const ref = archiveFailedDiff(diffText);
    const hash = sha256(diffText);
    expect(ref).toBe(path.join('diffs', `${hash}.diff.gz`));
    const abs = path.join(dir, ref as string);
    expect(existsSync(abs)).toBe(true);
    expect(gunzipSync(readFileSync(abs)).toString('utf8')).toBe(diffText);
  });

  it('archives once; a second archive of the SAME hash does not rewrite the file', () => {
    const diffText = 'identical diff bytes\n';
    const ref1 = archiveFailedDiff(diffText) as string;
    const abs = path.join(dir, ref1);
    const firstMtime = readFileSync(abs).length; // sanity: file exists and has content
    expect(firstMtime).toBeGreaterThan(0);
    // Corrupt the archived file in place, then re-archive the same content — EEXIST must win and the
    // corrupted bytes must survive untouched, proving the second call never rewrote the file.
    writeFileSync(abs, 'corrupted-sentinel');
    const ref2 = archiveFailedDiff(diffText);
    expect(ref2).toBe(ref1);
    expect(readFileSync(abs, 'utf8')).toBe('corrupted-sentinel');
  });

  it('different diff bytes hash to different refs, both archived', () => {
    const refA = archiveFailedDiff('diff A\n');
    const refB = archiveFailedDiff('diff B\n');
    expect(refA).not.toBe(refB);
    expect(existsSync(path.join(dir, refA as string))).toBe(true);
    expect(existsSync(path.join(dir, refB as string))).toBe(true);
  });

  it('is a no-op → null when telemetry is off (no sink)', () => {
    delete process.env.DEVKIT_GATE_EVENTS;
    expect(archiveFailedDiff('some diff\n')).toBeNull();
  });

  it('never throws when the sink dir is unwritable; returns null', () => {
    const notADir = path.join(dir, 'file');
    writeFileSync(notADir, 'x');
    process.env.DEVKIT_GATE_EVENTS = path.join(notADir, 'gate-events.jsonl');
    expect(() => archiveFailedDiff('some diff\n')).not.toThrow();
    expect(archiveFailedDiff('some diff\n')).toBeNull();
  });

  it('skips (returns null, does not throw) a diff over the archive size cap', () => {
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1);
    expect(() => archiveFailedDiff(huge)).not.toThrow();
    expect(archiveFailedDiff(huge)).toBeNull();
  });
});

// ── integration: only runReviewGate's FAIL path archives; runCascade/bench never can ──────────────

// Minimal fixtures mirroring run-review.test.mts's consumerRepo/writeArtifact helpers, kept local
// and small since this file's only integration need is the FAIL/PASS archiving contract.
const reviewerFromLabel = (label: string) =>
  REVIEWERS.find((r) => label === `review:${r.name}` || label === `review:${r.name}:escalate`);

function writeArtifact(repo: string, label: string) {
  const reviewer = reviewerFromLabel(label);
  if (!reviewer?.stateFile) return;
  const key = reviewer.name === 'commit-guard' ? 'files' : 'items';
  const row =
    reviewer.name === 'commit-guard'
      ? { path: 'src/f0.ts', status: 'pass', issues: [] }
      : { name: 'check-pass-0', category: 'X', status: 'pass', issues: [] };
  writeFileSync(path.join(repo, reviewer.stateFile), JSON.stringify({ [key]: [row] }));
}

describe('runReviewGate — diff archive wiring', () => {
  const ENV_KEYS = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'DEVKIT_NO_TELEMETRY'];
  const saved: Record<string, string | undefined> = {};
  const dirs: string[] = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Two staged files, only one inside backendRoots: backend-performance-reviewer (domain 'backend')
  // then covers a strict SUBSET of what correctness/commit-guard/conventions (domain 'all'/'code'/
  // 'conventions', the scanRoots ∪ backendRoots ∪ frontendRoots union) cover — so its diff bytes,
  // and therefore its diff_sha256, are genuinely DIFFERENT from the FAIL reviewer's. Without this
  // split every selected reviewer would diff the identical single file and collide on one hash,
  // making "only the FAIL got archived" untestable (a same-bytes PASS would trivially "exist" too).
  function consumerRepo() {
    const repo = mkdtempSync(path.join(tmpdir(), 'diff-archive-gate-'));
    dirs.push(repo);
    execSync('git init -q', { cwd: repo });
    writeFileSync(
      path.join(repo, 'guard.config.json'),
      JSON.stringify({ scanRoots: ['src'], review: { backendRoots: ['src/main'] } }),
    );
    const agents = path.join(repo, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    for (const name of [
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer',
    ])
      writeFileSync(path.join(agents, `${name}.md`), `---\nname: ${name}\n---\nBrief for ${name}.`);
    mkdirSync(path.join(repo, 'src', 'main'), { recursive: true });
    mkdirSync(path.join(repo, 'src', 'other'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'main', 'db.ts'), 'export const q = 1;\n');
    writeFileSync(path.join(repo, 'src', 'other', 'util.ts'), 'export const u = 1;\n');
    execSync('git add .', { cwd: repo });
    execSync(
      'git -c user.email=devkit@example.test -c user.name="Devkit Test" commit -qm "fixture config" -- guard.config.json',
      { cwd: repo },
    );
    return repo;
  }

  // No new event field carries the archive ref (HARD CONSTRAINT: no new event schema fields) — the
  // archive path is a deterministic function of diff_sha256, already on the review_scope event
  // emitted for every selected reviewer, so a reader derives `diffs/<diff_sha256>.diff.gz` itself.
  function scopeDiffSha(
    events: { type: string; reviewer: string; diff_sha256?: string }[],
    reviewer: string,
  ): string {
    return events.find((e) => e.type === 'review_scope' && e.reviewer === reviewer)
      ?.diff_sha256 as string;
  }

  it('a FAIL archives its diff bytes at diffs/<diff_sha256>.diff.gz (the join key already on review_scope)', async () => {
    const repo = consumerRepo();
    const sink = path.join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-diff-archive-fail';
    // correctness-reviewer is model-pinned: a single-pass FAIL, no opus escalation — the simplest
    // way to land a final 'fail' status.
    await runReviewGate(repo, {
      exec: async ({ label }: { label: string }) => {
        if (label === 'review:correctness-reviewer') return 'VERDICT: FAIL — bug found';
        writeArtifact(repo, label);
        return 'VERDICT: PASS';
      },
    });
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const failEvent = events.find(
      (e) => e.type === 'review_result' && e.reviewer === 'correctness-reviewer',
    );
    expect(failEvent.status).toBe('fail');
    expect(failEvent.diff_ref).toBeUndefined(); // no new event field
    const hash = scopeDiffSha(events, 'correctness-reviewer');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(repo, 'diffs', `${hash}.diff.gz`))).toBe(true);
    // backend-performance-reviewer (PASS) covers a strict SUBSET of files (only backendRoots), so
    // its diff bytes — and diff_sha256 — genuinely differ from correctness's; its own hash must NOT
    // have been archived, proving the PASS branch never calls archiveFailedDiff.
    const passHash = scopeDiffSha(events, 'backend-performance-reviewer');
    expect(passHash).not.toBe(hash);
    expect(existsSync(path.join(repo, 'diffs', `${passHash}.diff.gz`))).toBe(false);
  });

  it('a second FAIL run with identical staged bytes reuses the same archived file without rewriting', async () => {
    const repo = consumerRepo();
    const sink = path.join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-diff-archive-dedup-1';
    const exec = async ({ label }: { label: string }) => {
      if (label === 'review:correctness-reviewer') return 'VERDICT: FAIL — bug found';
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    };
    await runReviewGate(repo, { exec });
    const firstEvents = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const hash = scopeDiffSha(firstEvents, 'correctness-reviewer');
    const abs = path.join(repo, 'diffs', `${hash}.diff.gz`);
    const firstBytes = readFileSync(abs);

    process.env.DEVKIT_SHIP_ID = 'ship-diff-archive-dedup-2'; // new run, same staged tree/bytes
    await runReviewGate(repo, { exec });
    const secondEvents = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const secondHash = scopeDiffSha(secondEvents, 'correctness-reviewer');
    expect(secondHash).toBe(hash); // same staged bytes → same content-addressed hash
    expect(readFileSync(abs).equals(firstBytes)).toBe(true); // untouched, not rewritten
  });
});
