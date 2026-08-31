/**
 * stagedTouchedSet — the attribution counterpart to stagedSet.
 *
 * stagedSet answers "which files should I re-check", so it filters to ACMR. This one answers "what
 * did this commit change", so a deletion and a regular-file/symlink swap both count. Every case
 * below is a status an allowlist has already been observed to drop.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stagedTouchedSet } from '../git-index.mts';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-staged-touched-'));
  cleanup.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'kept.txt'), 'kept\n');
  writeFileSync(join(root, 'doomed.txt'), 'doomed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'seed');
  return root;
}

describe('stagedTouchedSet', () => {
  it('includes a staged DELETION, which stagedSet drops', () => {
    const root = seed();
    git(root, 'rm', '-q', 'doomed.txt');
    expect(stagedTouchedSet(root)).toEqual(new Set(['doomed.txt']));
  });

  it('includes a regular-file to symlink TYPE change', () => {
    const root = seed();
    unlinkSync(join(root, 'doomed.txt'));
    symlinkSync('kept.txt', join(root, 'doomed.txt'));
    git(root, 'add', '-A');
    expect(stagedTouchedSet(root)).toContain('doomed.txt');
  });

  it('is empty — not null — when a repo has nothing staged', () => {
    expect(stagedTouchedSet(seed())).toEqual(new Set());
  });

  it('returns null when git cannot answer, so callers stand down instead of blaming the tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-staged-touched-nogit-'));
    cleanup.push(root);
    expect(stagedTouchedSet(root)).toBeNull();
  });

  // Rename detection reports only the destination. A governed file moved OUT of its governed path
  // would then be invisible to a caller matching on the source, and the drift the move caused would
  // read as pre-existing.
  it('reports BOTH sides of a rename, not just the destination', () => {
    const root = seed();
    git(root, 'mv', 'doomed.txt', 'moved.txt');
    const touched = stagedTouchedSet(root);
    expect(touched).toContain('doomed.txt');
    expect(touched).toContain('moved.txt');
  });

  // A merge's first-parent diff also lists everything inherited unchanged from the second parent.
  // Blaming those on the merge would fail a gate for work the merge did not author.
  it('during a merge, reports only paths that differ from BOTH parents', () => {
    const root = seed();
    git(root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(root, 'side-only.txt'), 'from the side branch\n');
    writeFileSync(join(root, 'kept.txt'), 'side edit\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'side');
    git(root, 'checkout', '-q', 'main');
    writeFileSync(join(root, 'kept.txt'), 'main edit\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'main');

    // Conflicts on kept.txt; side-only.txt merges in cleanly from MERGE_HEAD.
    try {
      git(root, 'merge', '--no-commit', 'side');
    } catch {
      /* a conflicting merge exits non-zero and leaves MERGE_HEAD in place — that is the state under test */
    }
    writeFileSync(join(root, 'kept.txt'), 'resolved\n');
    git(root, 'add', '-A');

    const touched = stagedTouchedSet(root);
    expect(touched).not.toBeNull();
    // The resolution differs from both parents; the cleanly-inherited file differs only from HEAD.
    expect(touched).toContain('kept.txt');
    expect(touched).not.toContain('side-only.txt');
  });
});
