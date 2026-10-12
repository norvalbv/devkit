import { describe, expect, it } from 'vitest';
import {
  CLASS_FIX_HINT,
  issueLocations,
  renderFindingsBlock,
  renderFindingsBlockForParts,
  summarizeFindings,
} from '../evidence/findings.mts';
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

// A finding names one instance of a class, whichever reviewer or lens reported it. The hint keys off
// the same blocking filter as the finding lines, so a waived/dropped lens never draws it.
describe('class-fix hint', () => {
  const countHint = (block: string) => block.split(CLASS_FIX_HINT).length - 1;
  const outcome = (items: ReviewItem[], over: Partial<ReviewOutcome> = {}): ReviewOutcome => ({
    name: 'completeness-reviewer',
    status: 'fail',
    reason: 'r',
    escalated: false,
    items,
    ...over,
  });

  it('appends the hint exactly once, last, for any lens, without changing the counts', () => {
    const block = renderFindingsBlock(
      outcome([
        item('writer-reader-contracts', [
          'config read from the worktree, not the index, at gate/a.mts:25',
          'manifest read from the worktree at gate/b.mts:90',
        ]),
      ]),
    );
    expect(block).toContain('completeness-reviewer: 2 finding(s):');
    expect(countHint(block)).toBe(1);
    expect(block.trimEnd().endsWith(CLASS_FIX_HINT)).toBe(true);
  });

  it('omits the hint when the caller already printed it this run, leaving the block intact', () => {
    const parts = [outcome([item('lens', ['defect at src/a.ts:12'])])];
    const withHint = renderFindingsBlockForParts('completeness-reviewer', parts);
    const without = renderFindingsBlockForParts('completeness-reviewer', parts, undefined, false);
    expect(countHint(without)).toBe(0);
    expect(withHint).toBe(`${without}\n${CLASS_FIX_HINT}`);
  });

  it('keeps every hint line within the issue-line width', () => {
    for (const line of CLASS_FIX_HINT.split('\n')) expect(line.length).toBeLessThanOrEqual(160);
  });

  it('still hints when the findings run past the 12-line cap', () => {
    const many = Array.from({ length: 14 }, (_, i) => `race in src/f${i}.ts:${i * 100 + 1}`);
    const block = renderFindingsBlock(outcome([item('concurrency-races', many)]));
    expect(block).toContain('…and 2 more in the transcript');
    expect(countHint(block)).toBe(1);
  });

  it.each([
    ['waived', { disposition: 'waived' as const }],
    ['out-of-charter-dropped', { disposition: 'dropped_out_of_charter' as const }],
    ['passing', { status: 'pass' }],
  ])('prints nothing when the only issue-bearing lens is %s', (_, over) => {
    expect(renderFindingsBlock(outcome([item('lens', ['defect at src/p.ts:4'], over)]))).toBe('');
  });

  it('prints no orphan hint when a lens failed without issue strings', () => {
    expect(renderFindingsBlock(outcome([item('lens', [])]))).toBe('');
  });

  it('hints once across split lens parts of one reviewer', () => {
    const block = renderFindingsBlockForParts('correctness-reviewer', [
      outcome([item('error-and-edge-classification', ['`.` continues a path at src/p.ts:4'])]),
      outcome([item('state-transitions', ['status clobbered at src/q.ts:90'])]),
    ]);
    expect(block).toContain('correctness-reviewer: 2 finding(s):');
    expect(countHint(block)).toBe(1);
  });

  it('hints from items spilled to the itemsRef sidecar', () => {
    const refsRead: string[] = [];
    const readRef = (ref: string) => {
      refsRead.push(ref);
      return JSON.stringify([item('lens', ['separator run at src/p.ts:4'])]);
    };
    const res = outcome([]);
    delete res.items;
    res.itemsRef = 'items-spill';
    const block = renderFindingsBlock(res, readRef);
    expect(refsRead).toEqual(['items-spill']);
    expect(countHint(block)).toBe(1);
  });
});

describe('issueLocations', () => {
  it('returns every cited file:line in order, and none for prose or host:port', () => {
    expect(issueLocations('src/a.ts:12 reads what /abs/lib/b.mts:3 writes')).toEqual([
      { file: 'src/a.ts', line: 12 },
      { file: '/abs/lib/b.mts', line: 3 },
    ]);
    expect(issueLocations('db.internal:5432 times out')).toEqual([]);
    expect(issueLocations('')).toEqual([]);
  });
});
