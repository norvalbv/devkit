import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexIsInThisCheckout } from '../index-refresh.mts';

// The whole safety of the pre-scan refresh rests on this predicate: say yes about an index that
// really belongs to another checkout and the indexer rewrites THAT checkout's chunk rows with this
// one's code. Say no when it is genuinely local and the gate just scans a staler index.

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'refresh-root-'));
  outside = mkdtempSync(join(tmpdir(), 'refresh-outside-'));
  mkdirSync(join(root, '.search-code'), { recursive: true });
  writeFileSync(join(root, '.search-code', 'index.db'), '');
  mkdirSync(join(outside, '.search-code'), { recursive: true });
  writeFileSync(join(outside, '.search-code', 'index.db'), '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('indexIsInThisCheckout', () => {
  it('accepts an index that really lives inside the checkout', () => {
    expect(indexIsInThisCheckout(join(root, '.search-code', 'index.db'), root)).toBe(true);
  });

  it('rejects an index in a sibling checkout', () => {
    expect(indexIsInThisCheckout(join(outside, '.search-code', 'index.db'), root)).toBe(false);
  });

  it('rejects an index reached through a symlinked dir — the linked-worktree shape', () => {
    // What `devkit ship --link .search-code` sets up, and the case that makes this predicate
    // exist: the path looks local, but realpath lands in the primary checkout.
    const worktree = mkdtempSync(join(tmpdir(), 'refresh-worktree-'));
    try {
      symlinkSync(join(outside, '.search-code'), join(worktree, '.search-code'));
      expect(indexIsInThisCheckout(join(worktree, '.search-code', 'index.db'), worktree)).toBe(
        false,
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('rejects a path that escapes upward out of the checkout', () => {
    expect(indexIsInThisCheckout(join(root, '..'), root)).toBe(false);
  });

  it('rejects a nonexistent path rather than throwing', () => {
    expect(indexIsInThisCheckout(join(root, 'nope', 'index.db'), root)).toBe(false);
  });
});
