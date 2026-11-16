/**
 * Fixture tests for the ONE pre-registered sc-1119 match rule (lib/match.mts `matchFindings`).
 * The kappa pilot showed matcher behaviour dominates the benchmark's error budget, so the rule's
 * edges — tie-breaks, the item-3 covered-credit exception and its gaming guards, the fuzzy
 * empty-files fallback — are pinned here BEFORE any bench run (consumption contract: changing the
 * match rule after seeing results is p-hacking).
 */

import { describe, expect, it } from 'vitest';
import { anchorFilesOf, claimJaccard, matchFindings, samePath } from '../eval/lib/match.mts';

const f = (over = {}) => ({
  claim: 'race between writer and reader on flush',
  files: ['src/a.ts'],
  category: 'race',
  severity: 'medium',
  ...over,
});

describe('samePath / anchorFilesOf', () => {
  it('suffix matches only at path boundaries', () => {
    expect(samePath('repo/src/index.ts', 'src/index.ts')).toBe(true);
    expect(samePath('src/reindex.ts', 'index.ts')).toBe(false);
  });

  it('anchorFilesOf takes the last tab field (rename keeps the new path)', () => {
    expect(anchorFilesOf('M\tsrc/a.ts\nR100\told.ts\tnew.ts\n\n')).toEqual(['src/a.ts', 'new.ts']);
  });
});

describe('matchFindings — pre-registered rule', () => {
  it('item 1: same category + file overlap matches; category mismatch does not', () => {
    const g = f();
    expect(matchFindings([f()], [g]).pairs).toHaveLength(1);
    expect(matchFindings([f({ category: 'boundary' })], [g]).pairs).toHaveLength(0);
  });

  it('item 1 fallback: empty-files side matches on claim Jaccard ≥ 0.35 and is flagged fuzzy', () => {
    const j = f({ files: [] });
    const g = f();
    const m = matchFindings([j], [g]);
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0].fuzzy).toBe(true);
    // dissimilar claims stay unmatched even with an empty side
    const far = f({ files: [], claim: 'completely unrelated topic entirely' });
    expect(matchFindings([far], [g]).pairs).toHaveLength(0);
  });

  it('item 2 tie-break: greedy one-to-one prefers higher file overlap, then claim Jaccard', () => {
    const g1 = f({ files: ['src/a.ts', 'src/b.ts'] });
    const g2 = f({ files: ['src/a.ts'], claim: 'race on flush ordering elsewhere' });
    const j = f({ files: ['src/a.ts', 'src/b.ts'] });
    const m = matchFindings([j], [g1, g2]);
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0].g).toBe(g1); // two-file overlap beats one
    // g2 is NOT item-3 credited: j covers g1 but not g2? j.files ⊇ g2.files holds — credited.
    expect(m.item3Credits.map((c) => c.g)).toEqual([g2]);
  });

  it('item 3: one J covering two Gs counts both ONLY when it covers BOTH file sets', () => {
    const g1 = f({ files: ['src/a.ts'] });
    const g2 = f({ files: ['src/b.ts'], claim: 'race on flush in b' });
    const broad = f({ files: ['src/a.ts', 'src/b.ts'] });
    const m = matchFindings([broad], [g1, g2]);
    expect(m.pairs).toHaveLength(1);
    expect(m.item3Credits).toHaveLength(1);
    expect(m.unmatchedGold).toHaveLength(0);
  });

  it('item 3 guard: J that only PARTIALLY overlaps its greedy match credits nothing extra', () => {
    // j overlaps g1 on one of g1's two files (does not cover it) and fully covers g2 —
    // the contract's "covers both Gs' files" fails on g1, so g2 stays unmatched.
    const g1 = f({ files: ['src/a.ts', 'src/z.ts'] });
    const g2 = f({ files: ['src/b.ts'], claim: 'race on flush in b' });
    const j = f({ files: ['src/a.ts', 'src/b.ts'] });
    const m = matchFindings([j], [g1, g2]);
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0].g).toBe(g1); // higher overlap count wins the greedy pick
    expect(m.item3Credits).toHaveLength(0);
    expect(m.unmatchedGold).toEqual([g2]);
  });

  it('item 3 guards: no credit across categories, none for empty-files gold, each gold once', () => {
    const gOtherCat = f({ files: ['src/b.ts'], category: 'boundary' });
    const gNoFiles = f({ files: [], claim: 'race with completely different words here' });
    const broad = f({ files: ['src/a.ts', 'src/b.ts'] });
    const m = matchFindings([broad], [f(), gOtherCat, gNoFiles]);
    expect(m.pairs).toHaveLength(1);
    expect(m.item3Credits).toHaveLength(0);
    expect(m.unmatchedGold).toEqual([gOtherCat, gNoFiles]);
  });

  it('adversarial broad-J: credits are visible separately, consume no judge finding', () => {
    // the recall-gaming vector: one many-file J harvesting single-file golds. The credits land
    // in item3Credits (reported per config), never inflate pairs, and J is still one finding.
    const golds = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p, i) =>
      f({ files: [p], claim: `race on flush variant ${i}` }),
    );
    const j = f({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
    const m = matchFindings([j], golds);
    expect(m.pairs).toHaveLength(1);
    expect(m.item3Credits).toHaveLength(2);
    expect(m.unmatchedJudge).toHaveLength(0);
  });

  it('unmatched judge findings surface for FP/hallucination accounting', () => {
    const m = matchFindings(
      [f(), f({ files: ['src/other.ts'], claim: 'boundary overflow' })],
      [f()],
    );
    expect(m.pairs).toHaveLength(1);
    expect(m.unmatchedJudge).toHaveLength(1);
  });

  it('claimJaccard is symmetric and bounded', () => {
    const a = 'race between writer and reader';
    const b = 'reader and writer race';
    expect(claimJaccard(a, b)).toBe(claimJaccard(b, a));
    expect(claimJaccard(a, a)).toBe(1);
    expect(claimJaccard(a, '')).toBe(0);
  });
});
