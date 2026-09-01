import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffLineCounts } from '../evidence/scope.mts';
import { runReviewGate } from '../run-review.mts';
import { cleanupReviewFixtures, consumerRepo, passWithArtifact } from './run-review-fixtures.mts';

// The base-provenance vars belong here too: these tests run INSIDE `devkit ship`, which exports
// them, and an inherited one relabels the fixture's base and rewrites what a row records.
const envKeys = [
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BASE_SHA',
  'DEVKIT_SHIP_SOURCE_HEAD',
  'DEVKIT_REVIEW_MERGE_BASE',
] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

async function scopeRows(repo: string, shipId: string) {
  const sink = join(repo, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = shipId;
  await runReviewGate(repo, { exec: passWithArtifact(repo) });
  const lines = readFileSync(sink, 'utf8').trim().split('\n');
  const scope = lines.map((l) => JSON.parse(l)).filter((e) => e.type === 'review_scope');
  return { lines, scope };
}

describe('review_scope evidence-cap accounting', () => {
  it('under the cap the judge sees every byte: shown == diff_bytes, nothing omitted or truncated', async () => {
    const repo = consumerRepo({ backend: true });
    const { scope } = await scopeRows(repo, 'ship-scope-under-cap');
    const backend = scope.find((e) => e.reviewer === 'backend-performance-reviewer');
    expect(backend.diff_bytes).toBeGreaterThan(0);
    expect(backend.evidence_bytes_shown).toBe(backend.diff_bytes);
    expect(backend.omitted_files).toBe(0);
    expect(backend.truncated_files).toBe(0);
    // A staged-new-files fixture is pure additions: real line counts ride every scope row.
    expect(backend.insertions).toBeGreaterThan(0);
    expect(backend.deletions).toBe(0);
  });

  // sc-2480: the row already says WHICH bytes were judged; without the base it cannot say what
  // they were judged against, so a finding is not re-resolvable from the sink afterwards.
  it('records the base the diff was computed against', async () => {
    const repo = consumerRepo({ backend: true });
    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    const { scope } = await scopeRows(repo, 'ship-scope-base-sha');
    expect(scope.length).toBeGreaterThan(0);
    for (const row of scope) expect(row.base_sha).toBe(head);
  });

  it('says how much of a byte-heavy diff the judge could actually see', async () => {
    const repo = consumerRepo({ backend: true });
    // 12 staged backend files of ~9 KB each: over the 60 KB evidence total AND each over the 8 KB
    // per-file segment cap (diff-evidence.mts), so the judge's stdin is a truncated window.
    for (let i = 0; i < 12; i++)
      writeFileSync(
        join(repo, 'src', 'main', `big-${String(i).padStart(2, '0')}.ts`),
        `${Array.from({ length: 120 }, (_, k) => `export const v${i}_${k} = '${'x'.repeat(60)}';`).join('\n')}\n`,
      );
    execSync('git add .', { cwd: repo });
    const { lines, scope } = await scopeRows(repo, 'ship-scope-capped');
    const backend = scope.find((e) => e.reviewer === 'backend-performance-reviewer');
    expect(backend.diff_bytes).toBeGreaterThan(60_000);
    expect(backend.evidence_bytes_shown).toBeLessThanOrEqual(60_000);
    expect(backend.evidence_bytes_shown).toBeLessThan(backend.diff_bytes);
    expect(backend.truncated_files + backend.omitted_files).toBeGreaterThan(0);
    // Three small integers: every event still fits the atomic-append window.
    for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(4096);
  });
});

describe('diffLineCounts', () => {
  it('counts +/- content lines and excludes the +++/--- file headers', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,3 @@',
      ' context',
      '-old line',
      '+new line',
      '+second addition',
    ].join('\n');
    expect(diffLineCounts(diff)).toEqual({ insertions: 2, deletions: 1 });
  });

  it('content lines starting --/++/--- inside a hunk still count; headers outside never do', () => {
    const diff = [
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,3 +1,2 @@',
      '--select 1',
      '++x',
      '---triple-dash deletion',
    ].join('\n');
    expect(diffLineCounts(diff)).toEqual({ insertions: 1, deletions: 2 });
  });

  it('a second file resets hunk state, so its headers stay uncounted', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '@@ -1 +1 @@',
      '+one',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-two',
    ].join('\n');
    expect(diffLineCounts(diff)).toEqual({ insertions: 1, deletions: 1 });
  });

  it('CRLF diffs count identically — the \\r rides the line body, not the prefix', () => {
    expect(diffLineCounts('@@ -1 +1 @@\r\n+added\r\n-removed\r\n')).toEqual({
      insertions: 1,
      deletions: 1,
    });
  });

  it('an empty diff counts zero both ways', () => {
    expect(diffLineCounts('')).toEqual({ insertions: 0, deletions: 0 });
  });
});

describe('the reviewed base is stated on a passing run', () => {
  it('prints it once, naming this tree HEAD as the local base', async () => {
    const repo = consumerRepo({ backend: true });
    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    await runReviewGate(repo, { exec: passWithArtifact(repo) });
    const printed = err.mock.calls.map((c) => String(c[0]));
    const provenance = printed.filter((l) => l.includes('reviewed against'));
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toContain(head.slice(0, 12));
    expect(provenance[0]).toContain('local HEAD');
  });
});
