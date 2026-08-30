import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ClearMarker,
  formatClearMarker,
  formatDiagnosis,
  headSha,
  humanAge,
  readClearMarker,
  readDiagnosis,
  removeClearMarker,
  stagedFiles,
  stagedIntersection,
  writeClearMarker,
} from '../failures.mts';

let roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-failures-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/** vitest's json reporter, trimmed to the fields this module reads. */
const results = (root: string, testResults: unknown[]): string => {
  const file = join(root, 'results.json');
  writeFileSync(file, JSON.stringify({ testResults }));
  return file;
};

describe('readDiagnosis', () => {
  // THE SIGNAL THE WHOLE FEATURE RESTS ON. Verified against real vitest 4.1.10: a test that timed
  // out on attempt 1 and passed on the retry is reported `status: 'passed'` WITH a non-empty
  // failureMessages. Nothing else in the report distinguishes it from a test that simply passed, so
  // if this reading is wrong the retry becomes exactly the silent relaxation it must not be.
  it('reads a retried pass as flaky rather than as a plain pass', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/slow.test.ts',
        status: 'passed',
        assertionResults: [
          {
            fullName: 'flaky timeout',
            status: 'passed',
            failureMessages: ['Error: STACK_TRACE_ERROR'],
          },
          { fullName: 'genuinely fine', status: 'passed', failureMessages: [] },
        ],
      },
    ]);

    expect(readDiagnosis(file)).toEqual({
      failedFiles: [],
      flaky: [{ file: '/repo/slow.test.ts', name: 'flaky timeout' }],
    });
  });

  it('names the files that actually still failed', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/broken.test.ts',
        status: 'failed',
        assertionResults: [
          {
            fullName: 'real bug',
            status: 'failed',
            failureMessages: ['AssertionError: expected 2 to be 99'],
          },
        ],
      },
      { name: '/repo/fine.test.ts', status: 'passed', assertionResults: [] },
    ]);

    expect(readDiagnosis(file)?.failedFiles).toEqual(['/repo/broken.test.ts']);
  });

  // A file that throws on import never runs a test, so there is no failed ASSERTION to find — and
  // the file name is the one thing worth printing about it.
  it('names a suite that died before any test ran', () => {
    const root = makeRoot();
    const file = results(root, [
      { name: '/repo/import-boom.test.ts', status: 'failed', assertionResults: [] },
    ]);

    expect(readDiagnosis(file)?.failedFiles).toEqual(['/repo/import-boom.test.ts']);
  });

  // An older vitest silently ignores the dotted --outputFile.json, and a consumer who passed their
  // own --reporter never got ours. "No report" is ordinary, so it must mean "say nothing" — never a
  // thrown error and never a fabricated empty result the caller would narrate as "nothing failed".
  it('returns null for an absent, unparseable, or foreign report', () => {
    const root = makeRoot();
    expect(readDiagnosis(join(root, 'nope.json'))).toBeNull();
    const torn = join(root, 'torn.json');
    writeFileSync(torn, '{"testResults": [');
    expect(readDiagnosis(torn)).toBeNull();
    // Valid JSON from some other tool — parseable but not a vitest report.
    const foreign = join(root, 'foreign.json');
    writeFileSync(foreign, '{"suites":[{"file":"a.ts"}]}');
    expect(readDiagnosis(foreign)).toBeNull();
  });
});

describe('the staged-diff claim', () => {
  const git = (root: string, args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const repo = () => {
    const root = makeRoot();
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 't@t.t']);
    git(root, ['config', 'user.name', 't']);
    return root;
  };

  it('finds a failed file that is staged', () => {
    const root = repo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.test.ts'), 'x');
    git(root, ['add', 'src/a.test.ts']);

    const staged = stagedFiles(root);
    expect(stagedIntersection([join(root, 'src', 'a.test.ts')], staged)).toHaveLength(1);
    expect(stagedIntersection([join(root, 'src', 'other.test.ts')], staged)).toEqual([]);
  });

  // FRINK'S ACTUAL MODEL. Every agent here runs in a `git worktree`, whose staged diff is its own and
  // whose toplevel is NOT the main checkout's. Resolving against the wrong root would compare this
  // agent's failures to a sibling agent's staged files and answer "not in your diff" about a file
  // that is — the one sentence in this feature an agent would act on by shipping.
  it('answers from the worktree it was run in, not the main checkout', () => {
    const root = repo();
    writeFileSync(join(root, 'seed.txt'), 'x');
    git(root, ['add', 'seed.txt']);
    git(root, ['commit', '-qm', 'seed']);
    const tree = join(root, '..', `${basename(root)}-wt`);
    git(root, ['worktree', 'add', '-q', '-b', 'side', tree]);
    roots.push(tree);
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, 'src', 'mine.test.ts'), 'x');
    git(tree, ['add', 'src/mine.test.ts']);
    // Staged in the MAIN checkout only — it must not leak into the worktree's answer.
    writeFileSync(join(root, 'theirs.test.ts'), 'x');
    git(root, ['add', 'theirs.test.ts']);

    const staged = stagedFiles(tree);
    expect(stagedIntersection([join(tree, 'src', 'mine.test.ts')], staged)).toHaveLength(1);
    expect(stagedIntersection([join(root, 'theirs.test.ts')], staged)).toEqual([]);
    expect(headSha(tree)).not.toBeNull();
  });

  it('cannot be answered outside a git work tree, and says so with null', () => {
    const root = makeRoot(); // no git init
    expect(stagedFiles(root)).toBeNull();
    expect(stagedIntersection(['/repo/a.test.ts'], null)).toBeNull();
    expect(headSha(root)).toBeNull();
  });

  it('omits the staged sentence entirely when git could not answer', () => {
    const lines = formatDiagnosis({ failedFiles: ['/repo/a.test.ts'], flaky: [] }, '/repo', null);
    expect(lines.join('\n')).not.toMatch(/staged/);
    const answered = formatDiagnosis({ failedFiles: ['/repo/a.test.ts'], flaky: [] }, '/repo', []);
    expect(answered.join('\n')).toMatch(/None of them are in your staged diff/);
  });
});

describe('formatDiagnosis', () => {
  // The timeout claim is only ever made about a RESCUED test. vitest's json reporter replaces a
  // timeout's message with `Error: STACK_TRACE_ERROR`, so the shape is unreadable from a surviving
  // failure — but a rescue can only have come through --retry.condition, which matches timeouts
  // alone. Claiming it where it is provable and staying quiet elsewhere is the whole discipline.
  it('calls a rescued test a load flake, and calls a survivor nothing', () => {
    const flaky = formatDiagnosis(
      { failedFiles: [], flaky: [{ file: '/repo/a.test.ts', name: 'slow one' }] },
      '/repo',
      null,
    ).join('\n');
    expect(flaky).toMatch(/passed only on retry/);
    expect(flaky).toMatch(/timed out rather than failing an assertion/);
    expect(flaky).toMatch(/maxWorkers/);

    const failed = formatDiagnosis(
      { failedFiles: ['/repo/a.test.ts'], flaky: [] },
      '/repo',
      null,
    ).join('\n');
    expect(failed).not.toMatch(/timed out/);
    expect(failed).toMatch(/1 test file\(s\) failed/);
  });

  it('says nothing at all about a clean run', () => {
    expect(formatDiagnosis({ failedFiles: [], flaky: [] }, '/repo', [])).toEqual([]);
  });
});

describe('the clear marker', () => {
  it('round-trips, and is removable', () => {
    const root = makeRoot();
    const marker: ClearMarker = {
      clearedAt: '2026-08-30T09:00:00.000Z',
      previousMtime: 1234.5,
      head: 'da19b37c',
      failedFiles: ['/repo/a.test.ts'],
    };
    writeClearMarker(root, marker);
    expect(readClearMarker(root)).toEqual(marker);
    removeClearMarker(root);
    expect(readClearMarker(root)).toBeNull();
  });

  // The gate's verdict must never depend on this file. A corrupt marker is a missing marker.
  it('reads a corrupt marker as absent instead of throwing', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.last-clear.json'), 'not json');
    expect(readClearMarker(root)).toBeNull();
    writeFileSync(join(root, '.last-clear.json'), '{"nope":1}');
    expect(readClearMarker(root)).toBeNull();
  });

  it('dates itself so the reader can judge whether it is still relevant', () => {
    const now = Date.parse('2026-08-30T10:00:00.000Z');
    const lines = formatClearMarker(
      {
        clearedAt: '2026-08-30T09:56:00.000Z',
        previousMtime: null,
        head: 'da19b37c',
        failedFiles: ['/repo/src/a.test.ts'],
      },
      '/repo',
      now,
    ).join('\n');
    expect(lines).toMatch(/discarded by a test run that produced no report/);
    expect(lines).toMatch(/4m ago \(HEAD da19b37c\)/);
    expect(lines).toMatch(/Failed: src\/a\.test\.ts/);
  });

  it('renders ages at a human scale', () => {
    expect(humanAge(4 * 60_000)).toBe('4m');
    expect(humanAge(3 * 3_600_000)).toBe('3h');
    expect(humanAge(5 * 86_400_000)).toBe('5d');
  });
});

describe('report shapes a fixture never models', () => {
  it('never reports a test that failed its retry as both flaky and failed', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/hopeless.test.ts',
        status: 'failed',
        assertionResults: [
          {
            fullName: 'still slow',
            status: 'failed',
            failureMessages: ['Error: STACK_TRACE_ERROR'],
          },
        ],
      },
    ]);

    const d = readDiagnosis(file);
    expect(d?.failedFiles).toEqual(['/repo/hopeless.test.ts']);
    expect(d?.flaky).toEqual([]);
  });

  // vitest `projects` (devkit's own config uses two) puts ONE file in the report once PER project it
  // matches. A consumer running the same suite under two environments therefore hands us the same
  // path twice, and every downstream reader — the printed list, the marker, the staged-diff answer —
  // repeats it. "2 test file(s) failed: a.test.ts, a.test.ts" reads as two problems, not one.
  it('counts a file matched by two projects once', () => {
    const root = makeRoot();
    const suite = (name: string) => ({
      name,
      status: 'failed',
      assertionResults: [{ fullName: 'a', status: 'failed', failureMessages: ['boom'] }],
    });
    const file = results(root, [suite('/repo/shared.test.ts'), suite('/repo/shared.test.ts')]);

    expect(readDiagnosis(file)?.failedFiles).toEqual(['/repo/shared.test.ts']);
  });

  // Neither failed nor rescued. A skipped test carries no verdict to report, and counting one as a
  // failure would block a commit over a test that never ran.
  it('ignores statuses that are neither passed nor failed', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/mixed.test.ts',
        status: 'passed',
        assertionResults: [
          { fullName: 'skipped one', status: 'skipped', failureMessages: [] },
          { fullName: 'todo one', status: 'todo', failureMessages: [] },
          { fullName: 'pending one', status: 'pending', failureMessages: ['stale message'] },
        ],
      },
    ]);

    expect(readDiagnosis(file)).toEqual({ failedFiles: [], flaky: [] });
  });
});

describe('a marker that is not the one we wrote', () => {
  // A marker can outlive the machine that wrote it: coverage/ is symlinked into the ship worktree,
  // and a hand-edited or foreign clearedAt must not become "NaNm ago" in a gate failure message.
  it('prints the raw timestamp rather than a NaN age', () => {
    const lines = formatClearMarker(
      { clearedAt: 'last Tuesday', previousMtime: null, head: null, failedFiles: [] },
      '/repo',
      Date.parse('2026-08-30T10:00:00.000Z'),
    ).join('\n');
    expect(lines).not.toMatch(/NaN/);
    expect(lines).toMatch(/last Tuesday/);
  });

  // 0 is a legitimate mtime (epoch), and `||` here would silently rewrite it to null — losing the
  // one field that says WHICH artifact was discarded.
  it('keeps a previousMtime of 0 instead of collapsing it to null', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, '.last-clear.json'),
      JSON.stringify({ clearedAt: '2026-08-30T09:00:00.000Z', previousMtime: 0, failedFiles: [] }),
    );
    expect(readClearMarker(root)?.previousMtime).toBe(0);
  });

  // An older vitest ignores --outputFile.json, so a genuine clear can happen with no failed-file list
  // to record. The gate must still say the artifact was discarded — just without inventing a Failed:
  // line naming nothing.
  it('reports a clear it has no file list for, without an empty Failed line', () => {
    const lines = formatClearMarker(
      {
        clearedAt: new Date(Date.parse('2026-08-30T09:56:00.000Z')).toISOString(),
        previousMtime: 1,
        head: null,
        failedFiles: [],
      },
      '/repo',
      Date.parse('2026-08-30T10:00:00.000Z'),
    );
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toMatch(/discarded by a test run that produced no report,\s+4m ago\.$/);
  });
});
