import { describe, expect, it } from 'vitest';
import { issueLocations } from '../contracts/response.mts';
import {
  CLASS_FIX_HINT,
  renderFindingsBlock,
  renderFindingsBlockForParts,
  summarizeFindings,
} from '../evidence/findings.mts';
import { attachItems } from '../evidence/items.mts';
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

  it('keeps two findings a few lines apart when the lens is the cited file itself', () => {
    const s = summarizeFindings([
      item('gate-engine/coverage/dependencies.mts', [
        'canonical gate-engine/coverage/dependencies.mts:141 copies canonicalPath, verbatim',
        'shellWord gate-engine/coverage/dependencies.mts:143 copies shellWord in shell-word.mts:7',
      ]),
    ]);
    expect(s.total).toBe(2);
    expect(s.deduped).toBe(0);
    expect(s.lines[1]).toContain('dependencies.mts:143');
  });

  it('still folds a file-keyed finding restated at the same line', () => {
    const s = summarizeFindings([
      item('src/util.ts', [
        'fmt src/util.ts:9 copies format in src/fmt.ts:2',
        'fmt at src/util.ts:9 is a second copy of format',
      ]),
    ]);
    expect(s.total).toBe(1);
    expect(s.deduped).toBe(1);
  });

  it.each([
    ['a ./ prefix', 'src/util.ts', './src/util.ts'],
    ['a bare file name', 'src/util.ts', 'util.ts'],
    [
      'a route-group path the location pattern truncates',
      'app/(shop)/page.tsx',
      'app/(shop)/page.tsx',
    ],
  ])('reads %s as the file-keyed lens itself', (_, lens, cited) => {
    const s = summarizeFindings([
      item(lens, [`fmt ${cited}:141 copies format`, `pad ${cited}:143 copies leftPad`]),
    ]);
    expect(s.total).toBe(2);
  });

  it('keeps the 5-line bucket when the cited file only shares a name suffix with the lens', () => {
    const s = summarizeFindings([
      item('src/autil.ts', ['fmt util.ts:141 copies format', 'same copy, seen at util.ts:143']),
    ]);
    expect(s.total).toBe(1);
    expect(s.deduped).toBe(1);
  });

  it('folds a same-line restatement even when the file is spelled differently', () => {
    const s = summarizeFindings([
      item('src/util.ts', ['fmt src/util.ts:9 copies format', 'fmt ./src/util.ts:9 again']),
    ]);
    expect(s.total).toBe(1);
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

  it("prints both duplicates a files artifact records on one path (commit-guard's shape)", () => {
    const res = outcome();
    res.name = 'commit-guard';
    const files = [
      {
        path: 'src/dep.ts',
        status: 'fail',
        issues: ['a src/dep.ts:2 copies x', 'b src/dep.ts:4 copies y'],
      },
      { path: 'src/ok.ts', status: 'pass', issues: [] },
    ];
    attachItems(res, { files }, new Map());
    const block = renderFindingsBlock(res);
    expect(block).toContain('commit-guard: 2 finding(s):');
    expect(block).toContain('src/dep.ts · src/dep.ts:4');
  });

  const cappedFile = (count: number): ReviewOutcome => {
    const res = outcome();
    res.name = 'commit-guard';
    const issues = Array.from(
      { length: count },
      (_, i) => `h${i} src/dep.ts:${i * 20 + 1} copies x`,
    );
    attachItems(res, { files: [{ path: 'src/dep.ts', status: 'fail', issues }] }, new Map());
    return res;
  };

  it('says how many issues the per-lens cap dropped from a file, and counts them', () => {
    const res = cappedFile(4);
    expect(res.items?.[0].issues).toHaveLength(3);
    expect(res.items?.[0].issues_omitted).toBe(1);
    const block = renderFindingsBlock(res);
    expect(block).toContain('commit-guard: 4 finding(s):');
    expect(block).toContain(
      '  • src/dep.ts — +1 more issue(s) past the per-lens cap; raise GUARD_REVIEW_MAX_ISSUES_PER_LENS (max 10) to record them',
    );
    expect(block.match(/ {2}• src\/dep\.ts · /g)).toHaveLength(3);
    expect(block).not.toContain('…and');
  });

  it('counts several dropped issues once, with no phantom overflow tail', () => {
    const block = renderFindingsBlock(cappedFile(5));
    expect(block).toContain('commit-guard: 5 finding(s):');
    expect(block).toContain('+2 more issue(s) past the per-lens cap');
    expect(block).not.toContain('…and');
  });

  it('leaves an item at or under the cap without an omission count', () => {
    const res = cappedFile(3);
    expect(res.items?.[0]).not.toHaveProperty('issues_omitted');
    expect(renderFindingsBlock(res)).not.toContain('past the per-lens cap');
  });

  it('folds dropped issues into the overflow tail once the line cap is full', () => {
    const full = Array.from({ length: 12 }, (_, i) => `defect in src/f${i}.ts:${i * 100 + 1}`);
    const block = renderFindingsBlock(
      outcome([item('a', full), item('b', ['x src/b.ts:1'], { issues_omitted: 2 })]),
    );
    expect(block).toContain('api-security-reviewer: 15 finding(s):');
    expect(block).not.toContain('past the per-lens cap');
    expect(block).toContain('…and 3 more not shown');
  });

  it('ignores the omission count on a lens that no longer blocks', () => {
    const waived = item('w', ['claim src/w.ts:1'], { disposition: 'waived', issues_omitted: 4 });
    expect(summarizeFindings([waived, item('b', ['x src/b.ts:1'])]).total).toBe(1);
  });

  it('is empty when the artifact carried no issues', () => {
    expect(renderFindingsBlock(outcome(undefined))).toBe('');
    expect(renderFindingsBlock(outcome([item('a', [], { status: 'pass' })]))).toBe('');
  });

  it('names the reviewer, the counts, and the overflow', () => {
    const issues = Array.from({ length: 14 }, (_, i) => `defect in src/f${i}.ts:${i * 100 + 1}`);
    const block = renderFindingsBlock(outcome([item('lens', [...issues, issues[0]])]));
    expect(block).toContain('api-security-reviewer: 14 finding(s), 1 duplicate(s) folded:');
    expect(block).toContain('…and 2 more not shown');
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
    expect(block).toContain('…and 2 more not shown');
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
