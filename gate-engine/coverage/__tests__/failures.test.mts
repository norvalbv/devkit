import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedConfig, Vitest } from 'vitest/node';
import {
  type ClearMarker,
  formatClearMarker,
  formatDiagnosis,
  formatRerunNotice,
  formatRerunRescue,
  headSha,
  humanAge,
  readClearMarker,
  readDiagnosis,
  removeClearMarker,
  stagedFiles,
  stagedIntersection,
  RERUN_FLOOR_MS,
  raisedTimeoutMs,
  TIMEOUT_FINGERPRINT,
  type UnhandledError,
  writeClearMarker,
} from '../failures.mts';
import UnhandledReporter, { UNHANDLED_NAME } from '../unhandled-reporter.mts';

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

// sc-3473. Every shape below was captured from real vitest 4.1.10 json output, with devkit's
// `--retry.count=1 --retry.condition` injected, before any of this was written.
describe('a failure that is nothing but timeouts', () => {
  const T = TIMEOUT_FINGERPRINT;
  const timedOut = (fullName: string, duration?: number) => ({
    fullName,
    status: 'failed',
    duration,
    failureMessages: [`${T}\n    at task (file:///repo/a.test.ts)`, `${T}\n    at task`],
  });

  it('reads a test that timed out on both attempts as timeout-shaped', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/a.test.ts',
        status: 'failed',
        message: '',
        assertionResults: [timedOut('slow', 612)],
      },
    ]);

    expect(readDiagnosis(file)?.failures).toEqual({
      tests: [{ file: '/repo/a.test.ts', name: 'slow' }],
      allTimedOut: true,
      // vitest's `duration` ADDS UP every attempt: a 300ms timeout retried once reports ~612ms.
      // Reading it raw would double the observed budget.
      timeoutMs: 306,
    });
  });

  // vitest 5 stopped writing the 4.1.10 quirk and reports the real message, budget included
  // (captured from 5.0.3 json output with the same injected retry). sc-3321.
  describe('the vitest 5 spelling', () => {
    const attempt = (kind: 'Test' | 'Hook', ms: number) =>
      `Error: ${kind} timed out in ${ms}ms.\nIf this is a long-running test, pass a timeout value`;

    it('reads a test that timed out on both attempts as timeout-shaped', () => {
      const root = makeRoot();
      const file = results(root, [
        {
          name: '/repo/a.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            {
              fullName: 'starved',
              status: 'failed',
              duration: 604.692,
              failureMessages: [attempt('Test', 300), attempt('Test', 300)],
            },
          ],
        },
      ]);

      expect(readDiagnosis(file)?.failures).toEqual({
        tests: [{ file: '/repo/a.test.ts', name: 'starved' }],
        allTimedOut: true,
        timeoutMs: 300,
      });
    });

    it('reads a per-test hook timeout on every attempt as timeout-shaped', () => {
      const root = makeRoot();
      const file = results(root, [
        {
          name: '/repo/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'slow setup',
              status: 'failed',
              duration: 1210,
              failureMessages: [attempt('Hook', 600), attempt('Hook', 600)],
            },
          ],
        },
      ]);

      expect(readDiagnosis(file)?.failures).toMatchObject({ allTimedOut: true, timeoutMs: 600 });
    });

    it('does not call a timeout followed by an assertion failure timeout-shaped', () => {
      const root = makeRoot();
      const file = results(root, [
        {
          name: '/repo/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'mixed',
              status: 'failed',
              duration: 400,
              failureMessages: [attempt('Test', 300), 'AssertionError: expected 1 to be 2'],
            },
          ],
        },
      ]);

      expect(readDiagnosis(file)?.failures?.allTimedOut).toBe(false);
    });

    it('does not trust a single unretried timeout', () => {
      const root = makeRoot();
      const file = results(root, [
        {
          name: '/repo/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'once',
              status: 'failed',
              duration: 300,
              failureMessages: [attempt('Test', 300)],
            },
          ],
        },
      ]);

      expect(readDiagnosis(file)?.failures?.allTimedOut).toBe(false);
    });

    it('does not read a test that merely mentions a timeout in its own message', () => {
      const root = makeRoot();
      const file = results(root, [
        {
          name: '/repo/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'quotes it',
              status: 'failed',
              duration: 20,
              failureMessages: [
                'AssertionError: expected "Error: Test timed out in 5ms." to be ""',
                'AssertionError: expected "Error: Test timed out in 5ms." to be ""',
              ],
            },
          ],
        },
      ]);

      expect(readDiagnosis(file)?.failures?.allTimedOut).toBe(false);
    });
  });

  it('takes the longest per-attempt budget across tests', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/a.test.ts',
        status: 'failed',
        assertionResults: [timedOut('inline', 410), timedOut('slow', 612), timedOut('no-duration')],
      },
    ]);

    expect(readDiagnosis(file)?.failures?.timeoutMs).toBe(306);
  });

  // A beforeAll/afterAll timeout never reaches a test: vitest fails the FILE, skips (or passes) its
  // tests, and puts the message on the suite — the one place a timeout's value is still readable.
  it('reads a whole-file hook timeout as timeout-shaped, with its budget', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/h.test.ts',
        status: 'failed',
        message: 'Hook timed out in 300ms.\nIf this is a long-running hook, pass a timeout value',
        assertionResults: [{ fullName: 'x', status: 'skipped', failureMessages: [] }],
      },
    ]);

    const d = readDiagnosis(file);
    expect(d?.failedFiles).toEqual(['/repo/h.test.ts']);
    expect(d?.failures).toEqual({ tests: [], allTimedOut: true, timeoutMs: 300 });
  });

  it('does not call an import error a timeout', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/c.test.ts',
        status: 'failed',
        message: "Cannot find module './nope.mjs' imported from /repo/c.test.ts",
        assertionResults: [],
      },
    ]);

    expect(readDiagnosis(file)?.failures?.allTimedOut).toBe(false);
  });

  // A config `retry` retries everything; captured under `retry: 1`, these carry two messages but no
  // timeout fingerprint.
  it.each([
    ['an assertion', 'AssertionError: expected 2 to be 99'],
    ['a snapshot mismatch', 'Error: Snapshot `snap 1` mismatched\n    at as'],
    ['a plain throw', 'Error: plain boom\n    at /repo/a.test.ts'],
  ])('does not call %s retried by the consumer config a timeout', (_label, message) => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/a.test.ts',
        status: 'failed',
        assertionResults: [
          { fullName: 'x', status: 'failed', failureMessages: [message, message] },
        ],
      },
    ]);

    expect(readDiagnosis(file)?.failures?.allTimedOut).toBe(false);
  });

  // devkit's retry always leaves a timeout two messages; the fingerprint alone is not unique to
  // timeouts, so one message is not evidence.
  it('does not trust a fingerprint the retry never confirmed', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/a.test.ts',
        status: 'failed',
        assertionResults: [{ fullName: 'x', status: 'failed', failureMessages: [`${T}\n  at x`] }],
      },
    ]);

    expect(readDiagnosis(file)?.failures?.allTimedOut).toBe(false);
  });

  it('is not all-timeouts when one real failure rides along', () => {
    const root = makeRoot();
    const file = results(root, [
      { name: '/repo/a.test.ts', status: 'failed', assertionResults: [timedOut('slow', 612)] },
      {
        name: '/repo/b.test.ts',
        status: 'failed',
        assertionResults: [
          { fullName: 'bug', status: 'failed', failureMessages: ['AssertionError'] },
        ],
      },
    ]);

    const d = readDiagnosis(file);
    expect(d?.failures?.allTimedOut).toBe(false);
    expect(d?.failures?.tests.map((t) => t.name)).toEqual(['slow', 'bug']);
  });

  it('is not all-timeouts when an afterAll assertion fails the file around a timed-out test', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/a.test.ts',
        status: 'failed',
        message: 'AssertionError: expected 1 to be 2',
        assertionResults: [timedOut('slow', 612)],
      },
    ]);

    expect(readDiagnosis(file)?.failures?.allTimedOut).toBe(false);
  });

  // vitest exits 1 with every test green on an unhandled error or a coverage threshold miss. There is
  // no timeout to rescue, and "all of nothing is a timeout" must not read as true.
  it('has no failure verdict at all when no test or file failed', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/a.test.ts',
        status: 'passed',
        assertionResults: [{ fullName: 'a', status: 'passed', failureMessages: [] }],
      },
    ]);

    expect(readDiagnosis(file)?.failures).toBeUndefined();
  });

  it('lists a timed-out test matched by two projects once', () => {
    const root = makeRoot();
    const suite = {
      name: '/repo/a.test.ts',
      status: 'failed',
      assertionResults: [timedOut('slow', 612)],
    };
    const file = results(root, [suite, suite]);

    expect(readDiagnosis(file)?.failures?.tests).toEqual([
      { file: '/repo/a.test.ts', name: 'slow' },
    ]);
  });

  it('names the exact escape hatch where an all-timeout failure is printed', () => {
    const text = formatDiagnosis(
      {
        failedFiles: ['/repo/a.test.ts'],
        flaky: [],
        failures: { tests: [], allTimedOut: true, timeoutMs: 306 },
      },
      '/repo',
      null,
    ).join('\n');
    expect(text).toMatch(/every failure timed out/i);
    expect(text).toContain('--testTimeout=25000 --maxWorkers=50%');
  });

  it('prints no escape hatch when a real failure is in the mix', () => {
    const text = formatDiagnosis(
      {
        failedFiles: ['/repo/a.test.ts'],
        flaky: [],
        failures: { tests: [], allTimedOut: false, timeoutMs: 306 },
      },
      '/repo',
      null,
    ).join('\n');
    expect(text).not.toContain('--testTimeout');
  });
});

describe('the budget a re-run is given', () => {
  const observed = (timeoutMs: number | null) => ({ tests: [], allTimedOut: true, timeoutMs });

  it('never drops below the floor, even with nothing observed', () => {
    expect(raisedTimeoutMs(undefined)).toBe(RERUN_FLOOR_MS);
    expect(raisedTimeoutMs(observed(null))).toBe(RERUN_FLOOR_MS);
    expect(raisedTimeoutMs(observed(0))).toBe(RERUN_FLOOR_MS);
    expect(raisedTimeoutMs(observed(5_000))).toBe(RERUN_FLOOR_MS); // exactly 5× hits the floor
  });

  // A consumer whose own ceiling is 60s must not be LOWERED to the floor — the CLI flag beats their
  // config, so a fixed 25000 would make the re-run stricter than the run it is rescuing.
  it('scales above the floor from a generous ceiling', () => {
    expect(raisedTimeoutMs(observed(5_001))).toBe(25_005);
    expect(raisedTimeoutMs(observed(60_000))).toBe(300_000);
  });

  it('ignores a duration that is not a real number', () => {
    const root = makeRoot();
    const file = results(root, [
      {
        name: '/repo/a.test.ts',
        status: 'failed',
        assertionResults: [
          {
            fullName: 'x',
            status: 'failed',
            duration: -1,
            failureMessages: [`${TIMEOUT_FINGERPRINT}\n at`, `${TIMEOUT_FINGERPRINT}\n at`],
          },
        ],
      },
    ]);
    const d = readDiagnosis(file);
    expect(d?.failures?.allTimedOut).toBe(true);
    expect(d?.failures?.timeoutMs).toBeNull();
  });
});

describe('what the re-run says', () => {
  it('announces the budget and every way out before it starts', () => {
    const text = formatRerunNotice(25_000).join('\n');
    expect(text).toMatch(/re-running the whole suite ONCE at testTimeout=25000ms/);
    expect(text).toContain('DEVKIT_COVERAGE_NO_RERUN=1');
    expect(text).toContain('--retry=0');
    expect(text).toContain('--maxWorkers=50%');
  });

  it('names the tests only the raised budget got through', () => {
    const text = formatRerunRescue(
      {
        failedFiles: ['/repo/a.test.ts'],
        flaky: [],
        failures: {
          tests: [{ file: '/repo/a.test.ts', name: 'slow' }],
          allTimedOut: true,
          timeoutMs: 300,
        },
      },
      '/repo',
      25_000,
    ).join('\n');
    expect(text).toMatch(/1 test\(s\) passed only at the raised timeout \(25000ms\)/);
    expect(text).toContain('a.test.ts > slow');
  });

  // A beforeAll timeout fails the FILE and names no test. The rescue must still say what flaked,
  // or a whole-file flake passes in silence.
  it('falls back to files when a hook timeout named no test', () => {
    const text = formatRerunRescue(
      {
        failedFiles: ['/repo/h.test.ts'],
        flaky: [],
        failures: { tests: [], allTimedOut: true, timeoutMs: 300 },
      },
      '/repo',
      25_000,
    ).join('\n');
    expect(text).toMatch(/1 file\(s\) passed only at the raised timeout/);
    expect(text).toContain('h.test.ts');
  });

  it('caps a long rescue list and counts the rest', () => {
    const tests = Array.from({ length: 13 }, (_, i) => ({
      file: '/repo/a.test.ts',
      name: `t${i}`,
    }));
    const lines = formatRerunRescue(
      {
        failedFiles: ['/repo/a.test.ts'],
        flaky: [],
        failures: { tests, allTimedOut: true, timeoutMs: 1 },
      },
      '/repo',
      25_000,
    );
    expect(lines).toHaveLength(12);
    expect(lines.at(-1)).toMatch(/…and 3 more/);
  });

  it('says nothing when there was nothing to rescue', () => {
    expect(formatRerunRescue(null, '/repo', 25_000)).toEqual([]);
  });
});

describe('a run that exits non-zero with no failed test', () => {
  const green = [
    {
      name: '/repo/a.test.ts',
      status: 'passed',
      assertionResults: [{ fullName: 'a', status: 'passed', failureMessages: [] }],
    },
  ];
  const unhandledFile = (root: string, entries: UnhandledError[]) =>
    writeFileSync(join(root, UNHANDLED_NAME), JSON.stringify(entries));

  it('reads the reporter errors once each, as vitest projects repeat them', () => {
    const root = makeRoot();
    const boom = { file: '/repo/late.test.ts', message: 'Error: boom' };
    unhandledFile(root, [boom, boom, { file: null, message: 'Error: no path' }]);

    expect(readDiagnosis(results(root, green), 1)?.unhandled).toEqual([
      boom,
      { file: null, message: 'Error: no path' },
    ]);
  });

  it('falls back to a generic cause when the reporter wrote nothing', () => {
    const root = makeRoot();
    const unhandled = readDiagnosis(results(root, green), 1)?.unhandled;

    expect(unhandled).toHaveLength(1);
    expect(unhandled?.[0]).toMatchObject({ file: null });
    expect(unhandled?.[0]?.message).toMatch(/vitest exited 1 with no failed test/);
  });

  // `vitest run <filter>` matching nothing exits 1 with an empty, green report — no error, no threshold.
  it('does not blame an unhandled error when no test file matched', () => {
    const root = makeRoot();
    const [entry] = readDiagnosis(results(root, []), 1)?.unhandled ?? [];

    expect(entry?.message).toMatch(/no test files matched/);
  });

  it('says nothing about unhandled errors on a green exit or when a test failed', () => {
    const root = makeRoot();
    unhandledFile(root, [{ file: '/repo/late.test.ts', message: 'Error: boom' }]);
    const failing = [{ name: '/repo/a.test.ts', status: 'failed', assertionResults: [] }];

    expect(readDiagnosis(results(root, green), 0)?.unhandled).toBeUndefined();
    expect(readDiagnosis(results(root, failing), 1)?.unhandled).toBeUndefined();
  });

  it('prints the cause, whether it is staged, and why the artifact went', () => {
    const lines = formatDiagnosis(
      {
        failedFiles: [],
        flaky: [],
        unhandled: [
          { file: '/repo/late.test.ts', message: 'Error: boom' },
          { file: null, message: 'Error: no path' },
        ],
      },
      '/repo',
      [],
    );

    expect(lines).toEqual([
      '🚫 vitest exited non-zero, but no test failed — the run ended on:',
      '     late.test.ts — Error: boom',
      '     file unknown — Error: no path',
      '   None of them are in your staged diff.',
      '   The coverage artifact was discarded: devkit publishes only from a run vitest calls green.',
    ]);
  });

  // A 17k-test suite with one leaking import can raise the same teardown error from many files.
  it('caps a flood of errors and counts the rest', () => {
    const unhandled = Array.from({ length: 11 }, (_, i) => ({ file: null, message: `E${i}` }));
    const lines = formatDiagnosis({ failedFiles: [], flaky: [], unhandled }, '/repo', null);

    expect(lines.filter((l) => l.includes('file unknown'))).toHaveLength(10);
    expect(lines).toContain('     …and 1 more');
  });

  it('round-trips the cause through the marker and names it at the gate', () => {
    const root = realpathSync(makeRoot());
    const unhandledErrors = [{ file: join(root, 'late.test.ts'), message: 'Error: boom' }];
    writeClearMarker(root, {
      clearedAt: new Date().toISOString(),
      previousMtime: null,
      head: null,
      failedFiles: [],
      unhandledErrors,
    });

    const marker = readClearMarker(root);
    if (!marker) throw new Error('the marker written above must read back');
    expect(marker.unhandledErrors).toEqual(unhandledErrors);
    expect(formatClearMarker(marker, root).slice(-2)).toEqual([
      '   No test failed; the run ended on:',
      '     late.test.ts — Error: boom',
    ]);
  });

  it('reads a marker written before the field existed', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, '.last-clear.json'),
      JSON.stringify({ clearedAt: new Date().toISOString(), failedFiles: [] }),
    );

    expect(readClearMarker(root)?.unhandledErrors).toBeUndefined();
  });
});

describe('a marker whose unhandledErrors we did not write', () => {
  // coverage/ is shared and symlinked into ship worktrees; a hand-edited entry must not crash the gate
  // message that explains the block.
  it('keeps only well-formed entries', () => {
    const root = makeRoot();
    const good = { file: null, message: 'Error: boom' };
    writeFileSync(
      join(root, '.last-clear.json'),
      JSON.stringify({
        clearedAt: '2026-10-06T09:00:00.000Z',
        failedFiles: [],
        unhandledErrors: [null, 'Error: bare string', { file: 3, message: 'x' }, good],
      }),
    );

    const marker = readClearMarker(root);
    expect(marker?.unhandledErrors).toEqual([good]);
  });
});

describe('the reporter devkit injects into the consumer vitest', () => {
  const vitestWith = (outputFile: ResolvedConfig['outputFile']) =>
    // SAFETY: onInit reads only config.outputFile; the rest of Vitest is never touched.
    ({ config: { outputFile } }) as Vitest;
  const errors = (...list: Parameters<UnhandledReporter['onTestRunEnd']>[1][number][]) => list;

  it('writes the file and first message line of each error beside the json report', () => {
    const root = makeRoot();
    const reporter = new UnhandledReporter();
    reporter.onInit(vitestWith({ json: join(root, 'results.json') }));
    reporter.onTestRunEnd(
      [],
      errors(
        {
          name: 'EnvironmentTeardownError',
          message: 'Cannot load x\n  at y',
          VITEST_TEST_PATH: '/r/a.test.ts',
        },
        { message: 'no name, no path' },
      ),
    );

    expect(JSON.parse(readFileSync(join(root, UNHANDLED_NAME), 'utf8'))).toEqual([
      { file: '/r/a.test.ts', message: 'EnvironmentTeardownError: Cannot load x' },
      { file: null, message: 'Error: no name, no path' },
    ]);
  });

  // Loaded into the consumer's run: a throw here would turn their green run red.
  it.each([
    ['a string outputFile', 'junit.xml'],
    ['no outputFile', undefined],
    ['an output directory that does not exist', { json: '/nonexistent-devkit-dir/results.json' }],
  ])('neither throws nor writes with %s', (_label, outputFile) => {
    const reporter = new UnhandledReporter();
    reporter.onInit(vitestWith(outputFile));
    expect(() => reporter.onTestRunEnd([], errors({ message: 'boom' }))).not.toThrow();
  });

  it('writes nothing for a run with no unhandled error', () => {
    const root = makeRoot();
    const reporter = new UnhandledReporter();
    reporter.onInit(vitestWith({ json: join(root, 'results.json') }));
    reporter.onTestRunEnd([], errors());

    expect(existsSync(join(root, UNHANDLED_NAME))).toBe(false);
  });
});
