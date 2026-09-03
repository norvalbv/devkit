/** Locks the two contracts that keep old checkpoints loading: the key format (chunk tasks keyed on
 * file membership, whole-diff on -1) and torn-line tolerance plus identity-gated reuse. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewerSelection } from '../../../../reviewers.mts';
import {
  estimateUsd,
  isTerminal,
  openLensCheckpoint,
  planLensTasks,
  type CheckpointRow,
} from '../lens-run.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.GUARD_CORRECTNESS_SPLIT;
});

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1;',
  '+const b = 2;',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,2 @@',
  ' const c = 1;',
  '+const d = 2;',
  '',
].join('\n');
// SAFETY: planLensTasks reads only `files` from the selection; the reviewer is opaque to it.
const sel = JSON.parse(
  JSON.stringify({ reviewer: { name: 'correctness-reviewer' }, files: ['src/a.ts', 'src/b.ts'] }),
) as ReviewerSelection;

describe('planLensTasks', () => {
  it('a whole arm plans one task per lens, keyed on prefix|arm|-1|lens with the full file set', () => {
    const tasks = planLensTasks({ arm: 'whole', sel, diffText: diff, keyPrefix: 'sha123' });
    expect(tasks.map((t) => t.key).sort()).toEqual([
      'sha123|whole|-1|concurrency-races',
      'sha123|whole|-1|error-and-edge-classification',
      'sha123|whole|-1|state-transitions',
      'sha123|whole|-1|writer-reader-contracts',
    ]);
    expect(tasks.every((t) => t.files.length === 2 && t.chunk === -1)).toBe(true);
  });
  it('a chunk arm keys chunk tasks on file membership and keeps writer-reader-contracts whole', () => {
    const tasks = planLensTasks({ arm: 'chunk:1', sel, diffText: diff, keyPrefix: 'p' });
    const cross = tasks.filter((t) => t.group[0] === 'writer-reader-contracts');
    expect(cross).toHaveLength(1);
    expect(cross[0].chunk).toBe(-1);
    expect(cross[0].key).toBe('p|chunk:1|-1|writer-reader-contracts');
    const chunked = tasks.filter((t) => t.chunk >= 0);
    expect(chunked.length).toBeGreaterThan(0);
    for (const t of chunked) expect(t.key).toMatch(/^p\|chunk:1\|\d+:[0-9a-f]{12}\|/);
  });
  it('refuses a non-singleton lens grouping and an unknown arm', () => {
    process.env.GUARD_CORRECTNESS_SPLIT = '1';
    expect(() => planLensTasks({ arm: 'whole', sel, diffText: diff, keyPrefix: 'p' })).toThrow(
      /singleton/,
    );
    delete process.env.GUARD_CORRECTNESS_SPLIT;
    expect(() => planLensTasks({ arm: 'bogus', sel, diffText: diff, keyPrefix: 'p' })).toThrow(
      /unknown arm/,
    );
  });
  it('prices a task at $0.55 plus $0.03 per KB of evidence', () => {
    expect(
      estimateUsd([
        { key: 'k', arm: 'whole', chunk: -1, group: ['x'], files: [], evidenceBytes: 2048 },
      ]),
    ).toBeCloseTo(0.61);
  });
});

describe('openLensCheckpoint', () => {
  it('loads rows, skips a torn trailing line, and gates reuse on identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lens-run-'));
    dirs.push(dir);
    const file = join(dir, 'checkpoint.jsonl');
    const row = (key: string, status: string, identity?: string) =>
      JSON.stringify({
        key,
        diff: 'd',
        arm: 'whole',
        chunk: -1,
        group: 'g',
        status,
        reason: '',
        issues: [],
        ms: 1,
        at: 't',
        identity,
      });
    writeFileSync(
      file,
      `${row('a', 'pass', 'id1')}\n${row('b', 'error', 'id1')}\n${row('c', 'fail')}\n{"torn`,
    );
    const ckpt = openLensCheckpoint(file);
    expect(ckpt.tornLines).toBe(1);
    expect(ckpt.done.size).toBe(3);
    expect(ckpt.reusable('a', 'id1')).toBe(true);
    expect(ckpt.reusable('a', 'id2')).toBe(false);
    expect(ckpt.reusable('b', 'id1')).toBe(false);
    expect(ckpt.reusable('c', 'anything')).toBe(true);
    expect(isTerminal(ckpt.done.get('b'))).toBe(false);
    // SAFETY: row() serializes a complete CheckpointRow.
    ckpt.checkpoint(JSON.parse(row('d', 'pass', 'id1')) as CheckpointRow);
    expect(openLensCheckpoint(file).done.has('d')).toBe(true);
  });
});
