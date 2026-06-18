import { describe, expect, it } from 'vitest';
import {
  collectPaths,
  findBlockers,
  makeOverlap,
  parseHunkRanges,
  parseStagedFiles,
} from '../staged-filter.mjs';

describe('parseHunkRanges', () => {
  it('parses a basic +start,count hunk into an inclusive range', () => {
    const diff = ['+++ b/src/a.ts', '@@ -10,2 +11,3 @@', '+x', '+y', '+z'].join('\n');
    expect(parseHunkRanges(diff).get('src/a.ts')).toEqual([[11, 13]]);
  });

  it('treats an omitted +count as 1 line', () => {
    const diff = ['+++ b/src/a.ts', '@@ -10 +11 @@', '+x'].join('\n');
    expect(parseHunkRanges(diff).get('src/a.ts')).toEqual([[11, 11]]);
  });

  it('skips pure-deletion hunks (+count == 0)', () => {
    const diff = ['+++ b/src/a.ts', '@@ -20,2 +24,0 @@', '-old', '-old'].join('\n');
    expect(parseHunkRanges(diff).has('src/a.ts')).toBe(false);
  });

  it('collects multiple hunks for one file and keeps the deletion out', () => {
    const diff = [
      '+++ b/src/a.ts',
      '@@ -10,0 +11,3 @@',
      '+a',
      '@@ -20,2 +24,0 @@', // deletion → skipped
      '@@ -30,1 +34,2 @@',
      '+b',
    ].join('\n');
    expect(parseHunkRanges(diff).get('src/a.ts')).toEqual([
      [11, 13],
      [34, 35],
    ]);
  });

  it('switches the active file on each +++ b/ line', () => {
    const diff = [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+a',
      '+++ b/src/b.ts',
      '@@ -1,0 +5,2 @@',
      '+b',
    ].join('\n');
    const m = parseHunkRanges(diff);
    expect(m.get('src/a.ts')).toEqual([[1, 1]]);
    expect(m.get('src/b.ts')).toEqual([[5, 6]]);
  });

  it('captures a new-file hunk @@ -0,0 +1,N @@ as [1,N]', () => {
    const diff = ['+++ b/src/new.ts', '@@ -0,0 +1,5 @@', '+1', '+2'].join('\n');
    expect(parseHunkRanges(diff).get('src/new.ts')).toEqual([[1, 5]]);
  });

  it('tolerates a CRLF-terminated +++ line (no trailing \\r in the key)', () => {
    const diff = ['+++ b/src/a.ts\r', '@@ -1,0 +1,1 @@', '+a'].join('\n');
    const m = parseHunkRanges(diff);
    expect(m.has('src/a.ts')).toBe(true);
    expect(m.has('src/a.ts\r')).toBe(false);
  });

  it('ignores hunks before any +++ header and returns empty for no hunks', () => {
    expect(parseHunkRanges('@@ -1,0 +1,1 @@\n+x').size).toBe(0);
    expect(parseHunkRanges('rename from a\nrename to b').size).toBe(0); // pure rename, no hunk
  });
});

describe('parseStagedFiles', () => {
  it('splits, trims, strips \\r, and drops blanks', () => {
    const set = parseStagedFiles('src/a.ts\r\nsrc/b.ts\n\n  package.json  \n');
    expect([...set].sort()).toEqual(['package.json', 'src/a.ts', 'src/b.ts']);
  });

  it('returns an empty set for empty input', () => {
    expect(parseStagedFiles('').size).toBe(0);
  });
});

describe('collectPaths', () => {
  it('matches real paths with and without a leading dir', () => {
    expect(collectPaths('src/x.ts')).toEqual(['src/x.ts']);
    expect(collectPaths('package.json')).toEqual(['package.json']);
    expect(collectPaths('services/webapp/package.json')).toEqual(['services/webapp/package.json']);
    expect(collectPaths('.husky/pre-commit.sh')).toEqual(['.husky/pre-commit.sh']);
  });

  it('strips a trailing :line and :line:col', () => {
    expect(collectPaths('src/x.ts:5')).toEqual(['src/x.ts']);
    expect(collectPaths('src/x.ts:5:3')).toEqual(['src/x.ts']);
  });

  it('rejects bare names, prose, version strings, and empty', () => {
    expect(collectPaths('lodash')).toEqual([]);
    expect(collectPaths('rules.no-unused')).toEqual([]); // trailing segment has no clean .ext
    expect(collectPaths('see config here')).toEqual([]);
    expect(collectPaths('1.2.3')).toEqual([]); // version, not a path (basename has no letter)
    expect(collectPaths('')).toEqual([]);
    expect(collectPaths(42)).toEqual([]);
  });

  it('walks nested arrays/objects and dedupes (covers from_path/to_path/cycle/locations)', () => {
    const finding = {
      from_path: 'src/a.ts',
      to_path: 'src/b.ts',
      name: 'somePkg',
      meta: { cycle: ['src/c.ts:3', 'lodash', 'src/a.ts'] }, // dup + bare name
      locations: ['src/d.ts:5:2'],
    };
    expect(collectPaths(finding).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });
});

describe('makeOverlap', () => {
  const ranges = new Map([['src/a.ts', [[10, 20]]]]);
  const overlaps = makeOverlap(ranges);

  it('returns false for an unknown file', () => {
    expect(overlaps('src/other.ts', 10, 20)).toBe(false);
  });

  it('detects overlap, touching boundaries, and non-overlap', () => {
    expect(overlaps('src/a.ts', 15, 16)).toBe(true); // inside
    expect(overlaps('src/a.ts', 20, 25)).toBe(true); // touches upper edge
    expect(overlaps('src/a.ts', 5, 10)).toBe(true); // touches lower edge
    expect(overlaps('src/a.ts', 1, 9)).toBe(false); // before
    expect(overlaps('src/a.ts', 21, 30)).toBe(false); // after
  });
});

describe('findBlockers', () => {
  const ranges = new Map([['src/a.ts', [[100, 130]]]]);
  const staged = new Set(['src/a.ts', 'package.json']);

  it('flags an introduced complexity finding only when it overlaps a staged hunk', () => {
    const overlapping = {
      complexity: {
        findings: [{ introduced: true, path: 'src/a.ts', name: 'foo', line: 110, line_count: 5 }],
      },
    };
    const elsewhere = {
      complexity: {
        findings: [{ introduced: true, path: 'src/a.ts', name: 'bar', line: 4000, line_count: 5 }],
      },
    };
    const notIntroduced = {
      complexity: {
        findings: [{ introduced: false, path: 'src/a.ts', name: 'baz', line: 110, line_count: 5 }],
      },
    };
    expect(findBlockers(overlapping, ranges, staged)).toHaveLength(1);
    expect(findBlockers(elsewhere, ranges, staged)).toHaveLength(0); // stale-baseline finding in untouched lines
    expect(findBlockers(notIntroduced, ranges, staged)).toHaveLength(0);
  });

  it('flags a duplication group only when an instance sits in a staged hunk', () => {
    const stagedInstance = {
      duplication: {
        clone_groups: [
          {
            introduced: true,
            suggested_name: 'd',
            instances: [
              { file: 'src/a.ts', start_line: 120, end_line: 125 },
              { file: 'src/unstaged.ts', start_line: 1, end_line: 6 },
            ],
          },
        ],
      },
    };
    const bothOutside = {
      duplication: {
        clone_groups: [
          {
            introduced: true,
            suggested_name: 'd',
            instances: [
              { file: 'src/a.ts', start_line: 4000, end_line: 4005 },
              { file: 'src/unstaged.ts', start_line: 1, end_line: 6 },
            ],
          },
        ],
      },
    };
    expect(findBlockers(stagedInstance, ranges, staged)).toHaveLength(1);
    expect(findBlockers(bothOutside, ranges, staged)).toHaveLength(0);
  });

  it('scopes dead_code by staged-file membership and fails closed on unattributable findings', () => {
    const stagedRef = { dead_code: { unused_files: [{ introduced: true, path: 'src/a.ts' }] } };
    const unstagedRef = {
      dead_code: { unused_files: [{ introduced: true, path: 'src/parallel.ts' }] },
    };
    const boundaryStaged = {
      dead_code: {
        boundary_violations: [{ introduced: true, from_path: 'package.json', to_path: 'src/x.ts' }],
      },
    };
    const nameOnly = { dead_code: { unused_dependencies: [{ introduced: true, name: 'lodash' }] } };

    expect(findBlockers(stagedRef, ranges, staged)).toEqual([
      { kind: 'dead_code', files: ['src/a.ts'] },
    ]);
    expect(findBlockers(unstagedRef, ranges, staged)).toHaveLength(0);
    expect(findBlockers(boundaryStaged, ranges, staged)).toEqual([
      { kind: 'dead_code', files: ['package.json'] },
    ]);
    expect(findBlockers(nameOnly, ranges, staged)[0]).toMatchObject({
      kind: 'dead_code',
      detail: expect.stringContaining('fail-closed'),
    });
  });

  it('returns no blockers for an empty / undefined audit', () => {
    expect(findBlockers({}, ranges, staged)).toEqual([]);
    expect(
      findBlockers({ complexity: {}, duplication: {}, dead_code: {} }, ranges, staged),
    ).toEqual([]);
  });

  it('ignores non-array dead_code values (e.g. summary objects)', () => {
    const audit = { dead_code: { total_issues: 3, summary: { x: 1 }, unused_files: [] } };
    expect(findBlockers(audit, ranges, staged)).toEqual([]);
  });
});
