/** Added-line coverage (gate-engine/coverage/lines.mts): istanbul's line rule restricted to the lines
 * a change added — the unit `devkit coverage-diff` reports. */
import { describe, expect, it } from 'vitest';
import { addedLineCoverage, lineHits, lineRanges } from '../lines.mts';

/** statements as [startLine, hits] pairs → one istanbul file entry. */
const entry = (...stmts: [number, number][]) => ({
  statementMap: Object.fromEntries(stmts.map(([line], i) => [String(i), { start: { line } }])),
  s: Object.fromEntries(stmts.map(([, hits], i) => [String(i), hits])),
});

describe('lineHits — istanbul line rule', () => {
  it('a line is covered when ANY statement starting on it ran, whatever the statement order', () => {
    expect(lineHits(entry([4, 0], [4, 2])).get(4)).toBe(true);
    expect(lineHits(entry([4, 2], [4, 0])).get(4)).toBe(true);
    expect(lineHits(entry([4, 0], [4, 0])).get(4)).toBe(false);
  });

  it('a multi-line statement counts only on its START line', () => {
    const hits = lineHits({ statementMap: { '0': { start: { line: 3 } } }, s: { '0': 1 } });
    expect([...hits.keys()]).toEqual([3]);
  });

  it('a statement with no hit counter reads as not run', () => {
    expect(lineHits({ statementMap: { '0': { start: { line: 1 } } } }).get(1)).toBe(false);
  });
});

describe('addedLineCoverage', () => {
  // Lines 1-2 pre-existing and uncovered; 10-12 added, 11 uncovered; 20 added comment (no statement).
  const file = entry([1, 0], [2, 0], [10, 1], [11, 0], [12, 5]);

  it('counts only ADDED executable lines, so untouched uncovered code does not dilute the result', () => {
    expect(addedLineCoverage(file, new Set([10, 11, 12, 20]))).toEqual({
      covered: 2,
      total: 3,
      uncovered: [11],
    });
  });

  it('nothing executable added (comments, types, braces) is 0/0, not a pass or a fail', () => {
    expect(addedLineCoverage(file, new Set([20, 21]))).toEqual({
      covered: 0,
      total: 0,
      uncovered: [],
    });
    expect(addedLineCoverage(file, new Set())).toEqual({ covered: 0, total: 0, uncovered: [] });
  });

  it('uncovered lines come back ascending even when the added set was built out of order', () => {
    const f = entry([30, 0], [5, 0], [17, 0]);
    expect(addedLineCoverage(f, new Set([30, 5, 17])).uncovered).toEqual([5, 17, 30]);
  });

  it('an entry with no statementMap measures nothing', () => {
    expect(addedLineCoverage({}, new Set([1, 2]))).toEqual({ covered: 0, total: 0, uncovered: [] });
  });
});

describe('lineRanges', () => {
  it.each([
    [[], ''],
    [[7], '7'],
    [[3, 4, 5, 9], '3-5, 9'],
    [[1, 3, 5], '1, 3, 5'],
    [[8, 9, 20, 21, 22], '8-9, 20-22'],
  ])('%j → %s', (lines, out) => {
    expect(lineRanges(lines)).toBe(out);
  });
});
