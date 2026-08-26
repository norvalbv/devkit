import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  passWithArtifact,
  writeArtifact,
} from './run-review-fixtures.mts';

// sc-2054: codex judges run workspace-write (the checklist state file needs cwd writes and codex
// cannot confine cwd), so tampering with the commit is PREVENTED nowhere and must be DETECTED:
// the gate snapshots the staged tree before the judge wave and refuses every verdict if it moved.

let savedSplit: string | undefined;

beforeEach(() => {
  // The fixture artifact writer speaks the MONOLITH shape (base state file); pin the split off
  // the way run-review.test.mts does — the tamper contract is orthogonal to lens fan-out.
  savedSplit = process.env.GUARD_CORRECTNESS_SPLIT;
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanupReviewFixtures();
  if (savedSplit === undefined) delete process.env.GUARD_CORRECTNESS_SPLIT;
  else process.env.GUARD_CORRECTNESS_SPLIT = savedSplit;
  vi.restoreAllMocks();
});

describe('staged-tree tamper detection', () => {
  it('a judge that stages new content fails the whole wave, PASS verdicts and all', async () => {
    const repo = consumerRepo({ backend: true });
    let tampered = false;
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label);
      if (!tampered) {
        tampered = true;
        writeFileSync(join(repo, 'src', 'tampered.ts'), 'export const smuggled = true;\n');
        execFileSync('git', ['add', 'src/tampered.ts'], { cwd: repo });
      }
      return 'looks fine\nVERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    const err = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(err).toContain('STAGED TREE CHANGED');
  });

  it('a judge that COMMITS mid-wave is caught by HEAD identity — write-tree alone cannot see it', async () => {
    const repo = consumerRepo({ backend: true });
    let committed = false;
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label);
      if (!committed) {
        committed = true;
        // A nested commit leaves the INDEX (write-tree) identical while moving HEAD.
        execFileSync('git', ['commit', '-m', 'smuggled', '--no-verify'], { cwd: repo });
      }
      return 'looks fine\nVERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    const err = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(err).toContain('HEAD MOVED');
  });

  it('an UNVERIFIABLE index (unmerged paths) fails closed — cannot-verify is never verified', async () => {
    const repo = consumerRepo({ backend: true });
    // Manufacture unmerged index entries: conflicting branches, merge left mid-conflict.
    const g = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    g('commit', '-m', 'base');
    g('checkout', '-b', 'side');
    writeFileSync(join(repo, 'src', 'conflict.ts'), 'export const v = 1;\n');
    g('add', 'src/conflict.ts');
    g('commit', '-m', 'side');
    g('checkout', '-');
    writeFileSync(join(repo, 'src', 'conflict.ts'), 'export const v = 2;\n');
    g('add', 'src/conflict.ts');
    g('commit', '-m', 'main');
    try {
      g('merge', 'side');
    } catch {
      // expected: conflict leaves unmerged index entries
    }
    writeFileSync(join(repo, 'src', 'main', 'db.ts'), 'export const q = 2;\n');
    g('add', 'src/main/db.ts');
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(1);
    const err = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(err).toContain('UNVERIFIABLE');
  });

  it('working-tree-only writes (the checklist state file pattern) do not trip it', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label);
      // Unstaged scratch write — what a real checklist judge does (.claude state, tmp notes).
      mkdirSync(join(repo, '.claude'), { recursive: true });
      writeFileSync(join(repo, '.claude', 'scratch.json'), '{}');
      return 'looks fine\nVERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(0);
  });
});
