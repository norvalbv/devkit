// sc-3400 follow-up: the gate-level clobbered-index tripwire. Pure rule + parser; the wiring through
// runReviewGate is exercised in deletion-only-review.test.mts.
import { describe, expect, it } from 'vitest';
import {
  MASS_DELETION_FLOOR,
  massDeletionVerdict,
  parseNameStatus,
} from '../integrity/mass-deletion.mts';

const v = (deleted: number, added: number, headTracked: number | null) =>
  massDeletionVerdict({ deleted, added, headTracked });

describe('massDeletionVerdict', () => {
  it.each([
    ['below the floor never blocks, even a whole tree', 49, 0, 49, false],
    ['half the tree at the floor blocks', 50, 0, 100, true],
    ['just under half passes', 50, 0, 101, false],
    ['the incident shape (5,976 deleted, 216 foreign adds) blocks', 5976, 216, 5976, true],
    ['a move rename detection gave up on (D+A pairs) passes', 1000, 1000, 1500, false],
    ['more additions than deletions never blocks', 80, 500, 100, false],
    ['additions that pull net deletions under half pass', 100, 60, 100, false],
    ['a deliberate large cleanup in a big repo passes', 900, 0, 10_000, false],
  ])('%s', (_name, d, a, t, block) => {
    expect(v(d, a, t)).toBe(block);
  });

  it('an unborn HEAD (nothing tracked yet) never blocks', () => {
    expect(v(10_000, 0, null)).toBe(false);
  });

  it('the floor is the documented 50', () => {
    expect(MASS_DELETION_FLOOR).toBe(50);
  });

  it('survives counts past 2^31 without overflow', () => {
    const big = 2 ** 40;
    expect(v(big, 0, big)).toBe(true);
    expect(v(big, 0, 2 * big + 2)).toBe(false);
  });
});

describe('parseNameStatus (git diff --cached --name-status -z -M)', () => {
  it('counts D and A, and never counts a rename or copy (two path fields) as either', () => {
    const z = [
      'D',
      'gone.ts',
      'A',
      'new.ts',
      'R100',
      'old.ts',
      'moved.ts',
      'C075',
      'a.ts',
      'b.ts',
      'M',
      'm.ts',
      'D',
      'x',
      '',
    ].join('\0');
    expect(parseNameStatus(z)).toEqual({ deleted: 2, added: 1 });
  });

  it('a path spelled like a status letter is still a path, not a record', () => {
    // A file literally named "D" being added, then one named "A" deleted.
    expect(parseNameStatus(['A', 'D', 'D', 'A', ''].join('\0'))).toEqual({ deleted: 1, added: 1 });
  });

  it('a rename whose paths look like status letters keeps the field alignment', () => {
    expect(parseNameStatus(['R090', 'D', 'A', 'D', 'real.ts', ''].join('\0'))).toEqual({
      deleted: 1,
      added: 0,
    });
  });

  it('empty output is zero, not NaN', () => {
    expect(parseNameStatus('')).toEqual({ deleted: 0, added: 0 });
  });

  it('type changes, unmerged and modified entries are neither', () => {
    expect(parseNameStatus(['T', 'l', 'U', 'u', 'M', 'm', ''].join('\0'))).toEqual({
      deleted: 0,
      added: 0,
    });
  });
});
