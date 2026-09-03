/** Every miss bucket has a row here: a miss in the wrong bucket fabricates or hides a lens hole.
 * The committed shape is also guarded structurally (counts only). */
import { describe, expect, it } from 'vitest';
import {
  assertCountsOnly,
  type ExternalFinding,
  partitionFinding,
  reduceLensHoles,
  renderLensHoles,
  type ReviewContext,
} from '../holes.mts';

const ctx: ReviewContext = {
  changeKey: 'pr-1',
  scopeFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  shownFiles: ['src/a.ts', 'src/b.ts'],
  issues: [
    { lens: 'state-transitions', text: 'src/a.ts:40 status written before the guard is checked' },
    { lens: 'concurrency-races', text: 'a.ts:200 unawaited write' },
  ],
};
const finding = (over: Partial<ExternalFinding>): ExternalFinding => ({
  source: 'coderabbit',
  id: 'f',
  changeKey: 'pr-1',
  category: 'Functional Correctness',
  ...over,
});

describe('partitionFinding', () => {
  it('not-reviewed when the change has no reviewer context', () => {
    expect(partitionFinding(finding({ path: 'src/a.ts' }), undefined).bucket).toBe('not-reviewed');
  });
  it('not-in-scope when the file was never in the reviewer file set', () => {
    expect(partitionFinding(finding({ path: 'src/zzz.ts' }), ctx).bucket).toBe('not-in-scope');
  });
  it('evidence-uncertain when the file was in scope but never fully shown', () => {
    expect(partitionFinding(finding({ path: 'src/c.ts' }), ctx).bucket).toBe('evidence-uncertain');
  });
  it('matched on the same file within ±10 lines, carrying the lens', () => {
    const r = partitionFinding(finding({ path: 'src/a.ts', line: 45 }), ctx);
    expect(r.bucket).toBe('matched');
    expect(r.matchedLens).toBe('state-transitions');
  });
  it('matches at file level when the finding carries no line (registered rule)', () => {
    expect(partitionFinding(finding({ path: 'src/a.ts', line: null }), ctx).bucket).toBe('matched');
  });
  it('resolves an issue naming a bare basename to the unique staged path', () => {
    const r = partitionFinding(finding({ path: 'src/a.ts', line: 205 }), ctx);
    expect(r.matchedLens).toBe('concurrency-races');
  });
  it('in-evidence-unmatched when the file was fully shown and no lens issue landed near it', () => {
    expect(partitionFinding(finding({ path: 'src/b.ts', line: 10 }), ctx).bucket).toBe(
      'in-evidence-unmatched',
    );
    expect(partitionFinding(finding({ path: 'src/a.ts', line: 120 }), ctx).bucket).toBe(
      'in-evidence-unmatched',
    );
  });
  it('a judge-matched finding is matched regardless of path, with the judge lens', () => {
    const r = partitionFinding(
      finding({ judged: { matched: true, lens: 'writer-reader-contracts' } }),
      ctx,
    );
    expect(r).toMatchObject({ bucket: 'matched', matchedLens: 'writer-reader-contracts' });
  });
  it('a judge-missed finding with no path is unmatched only when every scoped file was shown', () => {
    const full: ReviewContext = { ...ctx, shownFiles: [...ctx.scopeFiles] };
    expect(partitionFinding(finding({ judged: { matched: false } }), full).bucket).toBe(
      'in-evidence-unmatched',
    );
    expect(partitionFinding(finding({ judged: { matched: false } }), ctx).bucket).toBe(
      'evidence-uncertain',
    );
    const withPath: ExternalFinding = finding({
      judged: { matched: false },
      path: 'src/b.ts',
      line: 3,
    });
    expect(partitionFinding(withPath, ctx).bucket).toBe('in-evidence-unmatched');
  });
  it('a pathless, judgeless finding is uncertain unless every scoped file was shown', () => {
    expect(partitionFinding(finding({}), ctx).bucket).toBe('evidence-uncertain');
    const empty: ReviewContext = { ...ctx, scopeFiles: [], shownFiles: [] };
    expect(partitionFinding(finding({}), empty).bucket).toBe('evidence-uncertain');
    const full: ReviewContext = { ...ctx, shownFiles: [...ctx.scopeFiles] };
    expect(partitionFinding(finding({}), full).bucket).toBe('in-evidence-unmatched');
  });
});

describe('reduceLensHoles', () => {
  const rows = [
    partitionFinding(finding({ id: '1', path: 'src/a.ts', line: 45 }), ctx),
    partitionFinding(finding({ id: '2', path: 'src/b.ts', triageLens: 'none' }), ctx),
    partitionFinding(finding({ id: '3', path: 'src/b.ts' }), ctx),
    partitionFinding(finding({ id: '4', path: 'src/c.ts', category: 'Stability' }), ctx),
    partitionFinding(finding({ id: '5', path: 'src/q.ts', category: 'Stability' }), ctx),
  ];
  const report = reduceLensHoles(rows, { source: 'test', minDenominator: 3 });
  it('counts every bucket per category and sums to the input', () => {
    expect(report.findings).toBe(5);
    expect(report.partition['Functional Correctness']).toEqual({
      matched: 1,
      'in-evidence-unmatched': 2,
    });
    expect(report.partition.Stability).toEqual({ 'evidence-uncertain': 1, 'not-in-scope': 1 });
  });
  it('attributes matches by lens and misses by triage lens, defaulting to untriaged', () => {
    expect(report.matchedByLens['Functional Correctness']).toEqual({ 'state-transitions': 1 });
    expect(report.unmatchedByTriage['Functional Correctness']).toEqual({ none: 1, untriaged: 1 });
  });
  it('reports eligibility from the catchable denominator, so an unreachable rule is visible', () => {
    expect(report.eligibility).toEqual([
      { category: 'Functional Correctness', catchable: 3, unmatched: 2, eligible: true },
      { category: 'Stability', catchable: 0, unmatched: 0, eligible: false },
    ]);
  });
  it('renders every bucket column and both attribution tables', () => {
    const text = renderLensHoles(report);
    expect(text).toContain('in-evidence-unmatched');
    expect(text).toContain('matched, by lens');
    expect(text).toContain('rubric-only');
  });
  it('the committed shape carries counts and names only', () => {
    expect(() => assertCountsOnly(report)).not.toThrow();
    const leaky = { ...report, partition: { cat: { path: 1 } } };
    expect(() => assertCountsOnly(leaky)).toThrow(/counts-only/);
    const leakyValue = { ...report, matchedByLens: { 'src/secret/file.ts': { lens: 1 } } };
    expect(() => assertCountsOnly(leakyValue)).toThrow(/source path/);
    const leakyLong = { ...report, source: 'x'.repeat(81) };
    expect(() => assertCountsOnly(leakyLong)).toThrow(/exceeds/);
  });
});
