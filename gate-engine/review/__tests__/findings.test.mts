import { describe, expect, it } from 'vitest';
import {
  CLASS_FIX_HINT,
  CLASSIFICATION_LENS,
  renderFindingsBlock,
  renderFindingsBlockForParts,
  summarizeFindings,
} from '../evidence/findings.mts';
import { CORRECTNESS_LENSES } from '../lens/groups.mts';
import type { ReviewItem, ReviewOutcome } from '../runtime.mts';

const item = (lens: string, issues: string[], over: Partial<ReviewItem> = {}): ReviewItem => ({
  lens,
  status: 'fail',
  issues,
  ...over,
});

describe('summarizeFindings', () => {
  it('lists one line per distinct blocking issue with its location', () => {
    const s = summarizeFindings([
      item('state-transitions', ['status clobbered src/a.ts:12 under concurrent retry']),
      item('concurrency-races', ['double-fire in src/b.ts:80 when the timer overlaps']),
    ]);
    expect(s.total).toBe(2);
    expect(s.deduped).toBe(0);
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toContain('state-transitions');
    expect(s.lines[0]).toContain('src/a.ts:12');
  });

  it('folds duplicates: same lens + file + 5-line bucket, or same normalized text', () => {
    const s = summarizeFindings([
      item('state-transitions', [
        'clobber at src/a.ts:12 …',
        'the same clobber, seen at src/a.ts:13',
        'a  different   defect', // no location → text fingerprint
        'A DIFFERENT defect', // same text after normalization
      ]),
    ]);
    expect(s.total).toBe(2);
    expect(s.deduped).toBe(2);
  });

  it('does not mistake host:port for file:line — distinct findings stay distinct', () => {
    const s = summarizeFindings([
      item('transport', [
        'unencrypted connection to db.internal:5432 exposes credentials',
        'plaintext to cache.internal:6379 exposes session keys',
      ]),
    ]);
    expect(s.total).toBe(2);
    expect(s.deduped).toBe(0);
    expect(s.lines[0]).not.toContain(' · db.internal:5432');
  });

  it('skips passing, waived, and out-of-charter-dropped items entirely', () => {
    const s = summarizeFindings([
      item('a', ['ok src/x.ts:1'], { status: 'pass' }),
      item('b', ['waived src/y.ts:2'], { disposition: 'waived' }),
      item('d', ['other reviewer owns src/w.ts:4'], { disposition: 'dropped_out_of_charter' }),
      item('c', ['real src/z.ts:3'], { disposition: 'blocking' }),
    ]);
    expect(s.total).toBe(1);
    expect(s.lines[0]).toContain('src/z.ts:3');
  });

  it('caps the rendered lines at 12 but keeps counting', () => {
    const issues = Array.from({ length: 15 }, (_, i) => `defect in src/f${i}.ts:${i * 100 + 1}`);
    const s = summarizeFindings([item('lens', issues)]);
    expect(s.lines).toHaveLength(12);
    expect(s.total).toBe(15);
  });
});

describe('renderFindingsBlockForParts', () => {
  it("merges a split reviewer's failing lens parts into ONE block with a shared dedup pass", () => {
    const part = (lens: string, issues: string[]): ReviewOutcome => {
      const res: ReviewOutcome = {
        name: 'correctness-reviewer',
        status: 'fail',
        reason: 'r',
        escalated: false,
      };
      res.items = [{ lens, status: 'fail', issues }];
      return res;
    };
    const block = renderFindingsBlockForParts('correctness-reviewer', [
      part('state-transitions', ['clobber at src/a.ts:12']),
      part('concurrency-races', ['double-fire at src/b.ts:80', 'double-fire at src/b.ts:81']),
    ]);
    expect(block).toContain('correctness-reviewer: 2 finding(s), 1 duplicate(s) folded:');
    expect(block).toContain('state-transitions · src/a.ts:12');
    expect(block).toContain('concurrency-races · src/b.ts:80');
  });
});

describe('renderFindingsBlock', () => {
  const outcome = (items?: ReviewItem[]): ReviewOutcome => {
    const res: ReviewOutcome = {
      name: 'api-security-reviewer',
      status: 'fail',
      reason: 'r',
      escalated: false,
    };
    if (items) res.items = items;
    return res;
  };

  it('is empty when the artifact carried no issues', () => {
    expect(renderFindingsBlock(outcome(undefined))).toBe('');
    expect(renderFindingsBlock(outcome([item('a', [], { status: 'pass' })]))).toBe('');
  });

  it('names the reviewer, the counts, and the overflow', () => {
    const issues = Array.from({ length: 14 }, (_, i) => `defect in src/f${i}.ts:${i * 100 + 1}`);
    const block = renderFindingsBlock(outcome([item('lens', [...issues, issues[0]])]));
    expect(block).toContain('api-security-reviewer: 14 finding(s), 1 duplicate(s) folded:');
    expect(block).toContain('…and 2 more in the transcript');
  });
});

// sc-2740: a classifier counterexample stands for a class; the block says so once, off the same
// blocking filter the finding lines use, so a waived/dropped lens or a capped line never skews it.
describe('class-fix hint for classification findings', () => {
  const countHint = (block: string) => block.split(CLASS_FIX_HINT).length - 1;
  const correctness = (items: ReviewItem[], over: Partial<ReviewOutcome> = {}): ReviewOutcome => ({
    name: 'correctness-reviewer',
    status: 'fail',
    reason: 'r',
    escalated: false,
    items,
    ...over,
  });

  it('pins the lens id to the shipped correctness lens vocabulary', () => {
    expect(CORRECTNESS_LENSES).toContain(CLASSIFICATION_LENS);
  });

  it('appends the hint exactly once, last, without changing the finding counts', () => {
    const block = renderFindingsBlock(
      correctness([
        item(CLASSIFICATION_LENS, [
          'input `devkit review.md` matches the verb at cli/a.test.mts:25',
          'input `devkit review/guide` also matches at cli/b.mts:90',
        ]),
      ]),
    );
    expect(block).toContain('correctness-reviewer: 2 finding(s):');
    expect(countHint(block)).toBe(1);
    expect(block.trimEnd().endsWith(CLASS_FIX_HINT)).toBe(true);
  });

  it('keeps every hint line within the issue-line width', () => {
    for (const line of CLASS_FIX_HINT.split('\n')) expect(line.length).toBeLessThanOrEqual(160);
  });

  it('still hints when the classification finding falls past the 12-line cap', () => {
    const others = Array.from({ length: 13 }, (_, i) => `race in src/f${i}.ts:${i * 100 + 1}`);
    const block = renderFindingsBlock(
      correctness([
        item('concurrency-races', others),
        item(CLASSIFICATION_LENS, ['bare `{` anchor misclassifies JSON at src/p.ts:4']),
      ]),
    );
    expect(block).not.toContain(`${CLASSIFICATION_LENS} ·`); // proven past the cap…
    expect(block).toContain('…and 2 more in the transcript');
    expect(countHint(block)).toBe(1); // …yet the class hint still reaches the author
  });

  it.each([
    ['waived', { disposition: 'waived' as const }],
    ['out-of-charter-dropped', { disposition: 'dropped_out_of_charter' as const }],
    ['passing', { status: 'pass' }],
  ])('omits the hint when the classification lens is %s and another lens blocks', (_, over) => {
    const block = renderFindingsBlock(
      correctness([
        item(CLASSIFICATION_LENS, ['anchor misclassifies at src/p.ts:4'], over),
        item('state-transitions', ['status clobbered at src/a.ts:12'], { disposition: 'blocking' }),
      ]),
    );
    expect(block).toContain('state-transitions · src/a.ts:12');
    expect(countHint(block)).toBe(0);
  });

  it('omits the hint when only non-classification lenses block', () => {
    const block = renderFindingsBlock(
      correctness([
        item('writer-reader-contracts', ['reader drops field at src/r.ts:7']),
        item('concurrency-races', ['double-fire at src/b.ts:80']),
      ]),
    );
    expect(countHint(block)).toBe(0);
  });

  it('omits the hint for a lens that merely contains the id as a substring', () => {
    const block = renderFindingsBlock(
      correctness([item(`src/${CLASSIFICATION_LENS}.ts`, ['duplicated helper at src/x.ts:3'])]),
    );
    expect(countHint(block)).toBe(0);
  });

  it('prints no orphan hint when the classification lens failed without issue strings', () => {
    expect(renderFindingsBlock(correctness([item(CLASSIFICATION_LENS, [])]))).toBe('');
    expect(summarizeFindings([item(CLASSIFICATION_LENS, [])]).blockingLenses).toEqual([]);
  });

  it('hints once across split lens parts that each block on classification', () => {
    const block = renderFindingsBlockForParts('correctness-reviewer', [
      correctness([item(CLASSIFICATION_LENS, ['`.` continues a path at src/p.ts:4'])]),
      correctness([item(CLASSIFICATION_LENS, ['`\\` continues a path at src/q.ts:90'])]),
    ]);
    expect(block).toContain('correctness-reviewer: 2 finding(s):');
    expect(countHint(block)).toBe(1);
  });

  it('hints from items spilled to the itemsRef sidecar', () => {
    const refsRead: string[] = [];
    const readRef = (ref: string) => {
      refsRead.push(ref);
      return JSON.stringify([item(CLASSIFICATION_LENS, ['separator run at src/p.ts:4'])]);
    };
    const res = correctness([]);
    delete res.items;
    res.itemsRef = 'items-spill';
    const block = renderFindingsBlock(res, readRef);
    expect(refsRead).toEqual(['items-spill']);
    expect(countHint(block)).toBe(1);
  });

  it('reports blocking lenses sorted and deduplicated, including lines past the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => `defect in src/f${i}.ts:${i * 100 + 1}`);
    const s = summarizeFindings([
      item('state-transitions', many),
      item(CLASSIFICATION_LENS, ['a at src/p.ts:4']),
      item(CLASSIFICATION_LENS, ['b at src/q.ts:40']),
      item('concurrency-races', ['waived at src/w.ts:1'], { disposition: 'waived' }),
    ]);
    expect(s.lines).toHaveLength(12);
    expect(s.blockingLenses).toEqual([CLASSIFICATION_LENS, 'state-transitions']);
  });
});
