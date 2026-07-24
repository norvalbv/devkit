import { describe, expect, it } from 'vitest';
import {
  collectPaths,
  describeError,
  findBlockers,
  isTransientSpawnFailure,
  jsonObjectSpans,
  makeOverlap,
  parseAuditPayload,
  parseHunkRanges,
  parseStagedFiles,
} from '../staged-filter.mts';

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

// sc-1192: the gate reaches this filter only because its own `jq` already read a verdict out of
// the SAME bytes, so a stricter parser here rejects payloads the caller considers valid — and an
// anonymous exit 2 then blocks a clean scoped commit on the unscoped worktree verdict.
describe('jsonObjectSpans', () => {
  it('spans a balanced object and ignores trailing bytes', () => {
    expect(jsonObjectSpans('{"a":{"b":1}} trailing')).toEqual(['{"a":{"b":1}}']);
  });

  it('returns every top-level object in order', () => {
    expect(jsonObjectSpans('{"a":1}\n{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does not close on a brace inside a string', () => {
    expect(jsonObjectSpans('{"msg":"a } b","c":1}')).toEqual(['{"msg":"a } b","c":1}']);
  });

  it('does not close on an escaped quote inside a string', () => {
    expect(jsonObjectSpans('{"msg":"say \\" } now","c":1}')).toEqual([
      '{"msg":"say \\" } now","c":1}',
    ]);
  });

  it('treats a backslash outside a string as an ordinary character', () => {
    expect(jsonObjectSpans('\\{"a":1}')).toEqual(['{"a":1}']);
  });

  it('yields nothing with no object, or when the object never closes', () => {
    expect(jsonObjectSpans('warning: nothing here')).toEqual([]);
    expect(jsonObjectSpans('{"a":1')).toEqual([]);
  });
});

describe('parseAuditPayload', () => {
  it('parses a clean payload', () => {
    expect(parseAuditPayload('{"verdict":"fail"}')).toEqual({ verdict: 'fail' });
  });

  it('tolerates a BOM and surrounding whitespace', () => {
    expect(parseAuditPayload('﻿\n  {"verdict":"fail"}  \n')).toEqual({ verdict: 'fail' });
  });

  it('tolerates a warning line printed before the JSON', () => {
    const text = 'WARN invalid entry pattern\n{"verdict":"fail","dead_code":{}}';
    expect(parseAuditPayload(text)).toMatchObject({ verdict: 'fail' });
  });

  it('picks the audit envelope over a preamble that is ITSELF valid JSON', () => {
    // Selecting the first balanced span here would return the log line: it parses cleanly, carries
    // no findings, and would pass a commit that must block — a fail-OPEN in the fix meant to close
    // one. The audit is identified by `verdict`, the same property the gate's own jq matched on.
    const text =
      '{"level":"warn","msg":"baseline stale"}\n{"verdict":"fail","complexity":{"findings":[{"introduced":true,"path":"src/a.ts","line":1,"line_count":1}]}}';
    expect(parseAuditPayload(text)).toMatchObject({
      verdict: 'fail',
      complexity: { findings: [{ introduced: true, path: 'src/a.ts' }] },
    });
  });

  it('fails closed when no span carries a verdict', () => {
    expect(() => parseAuditPayload('{"level":"warn"}\n{"level":"info"}')).toThrow(SyntaxError);
  });

  it('fails closed when the payload is ambiguous (several verdict objects)', () => {
    const text = '{"verdict":"pass"}\n{"verdict":"fail"}';
    expect(() => parseAuditPayload(text)).toThrow(SyntaxError);
  });

  it('tolerates trailing bytes after the JSON object', () => {
    expect(parseAuditPayload('{"verdict":"fail"}\nDone in 3s\n')).toEqual({ verdict: 'fail' });
  });

  it('throws on an empty payload', () => {
    expect(() => parseAuditPayload('   \n')).toThrow(/empty payload/);
  });

  it('throws the ORIGINAL parse error on a truncated payload (never guesses)', () => {
    // Truncated JSON must stay fail-closed: silently salvaging a prefix would drop findings.
    expect(() => parseAuditPayload('{"verdict":"fail","dead_code":{')).toThrow(SyntaxError);
  });
});

describe('isTransientSpawnFailure', () => {
  it('retries only a failure to START the child, never a child that ran and failed', () => {
    // The gate chain forks this filter while a fleet of reviewers is live; a lost fork race must
    // not turn a clean scoped commit into an unscoped block.
    expect(isTransientSpawnFailure(Object.assign(new Error('x'), { code: 'EAGAIN' }))).toBe(true);
    expect(isTransientSpawnFailure(Object.assign(new Error('x'), { code: 'ENOMEM' }))).toBe(true);
    // git ran and exited non-zero (bad repo): a retry would just fail again, slower.
    expect(isTransientSpawnFailure(Object.assign(new Error('x'), { status: 128 }))).toBe(false);
    expect(isTransientSpawnFailure(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isTransientSpawnFailure(new Error('x'))).toBe(false);
    expect(isTransientSpawnFailure(null)).toBe(false);
  });
});

describe('describeError', () => {
  it('composes message, errno, exit status and child stderr', () => {
    const reason = describeError(
      Object.assign(new Error('Command failed: git diff --cached'), {
        code: 'EAGAIN',
        status: 128,
        stderr: 'fatal: not a git repository\n',
      }),
    );
    expect(reason).toContain('Command failed: git diff --cached');
    expect(reason).toContain('errno=EAGAIN');
    expect(reason).toContain('exit=128');
    expect(reason).toContain('fatal: not a git repository');
  });

  it('collapses newlines and bounds the length so a blocked commit stays readable', () => {
    const reason = describeError(new Error(`x${'y'.repeat(5000)}`));
    expect(reason.length).toBeLessThanOrEqual(401);
    expect(reason).not.toContain('\n');
  });
});
