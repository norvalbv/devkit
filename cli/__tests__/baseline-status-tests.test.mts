/** Per-test answers: the names a failed file records, and `baseline-status --test` reading them. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineStatus from '../commands/baseline/status.mts';
import { parseSummary } from '../lib/baseline-status/gh.mts';
import {
  MAX_NAMES_PER_LIST,
  MAX_NAMES_PER_SUMMARY,
  type TestReportSummary,
  summarise,
} from '../lib/baseline-status/produce.mts';
import type { FileStatus } from '../lib/baseline-status/query.mts';
import { testVerdict } from '../lib/baseline-status/test-verdict.mts';
import { ghHarness, runRef, summaryFor } from './_baseline-fixture.mts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** One vitest assertion as the JSON reporter writes it. */
const assertion = (title: string, status: string, ancestorTitles = ['g']) => ({
  ancestorTitles,
  title,
  status,
});

/** A report entry for `/repo/<path>` with the given suite status and assertions. */
const entry = (path: string, status: string, assertionResults: (object | null)[] | string) => ({
  name: `/repo/${path}`,
  status,
  assertionResults,
});

describe('summarise — test names for failed files', () => {
  it('records the real reporter shape for the failed file only, as the console prints names', () => {
    const report = JSON.parse(readFileSync(join(FIXTURES, 'vitest-report.json'), 'utf8'));
    const summary = summarise(report, '/home/runner/work/devkit/devkit', {});
    expect(summary.tests).toEqual({
      'cli/__tests__/review-setup-worktree.test.mts': { failed: ['g > c'], passed: [] },
    });
  });

  it('merges vitest projects, and a name that failed anywhere is failed only', () => {
    const summary = summarise(
      {
        testResults: [
          entry('a.test.mts', 'passed', [assertion('x', 'passed'), assertion('y', 'passed')]),
          entry('a.test.mts', 'failed', [assertion('x', 'failed')]),
        ],
      },
      '/repo',
      {},
    );
    expect(summary.tests?.['a.test.mts']).toEqual({ failed: ['g > x'], passed: ['g > y'] });
  });

  it('drops a malformed assertion or unknown status alone, and a non-array list yields no names', () => {
    const summary = summarise(
      {
        testResults: [
          entry('a.test.mts', 'failed', [
            assertion('x', 'failed'),
            { title: 7, status: 'failed', ancestorTitles: [] },
            null,
            assertion('t', 'todo'),
          ]),
          entry('b.test.mts', 'failed', 'nope'),
        ],
      },
      '/repo',
      {},
    );
    expect(summary.tests).toEqual({
      'a.test.mts': { failed: ['g > x'], passed: [] },
      'b.test.mts': { failed: [], passed: [] },
    });
  });

  it('does not mark a list holding exactly the cap as truncated', () => {
    const exact = Array.from({ length: MAX_NAMES_PER_LIST }, (_, i) =>
      assertion(`t${i}`, 'failed'),
    );
    const summary = summarise({ testResults: [entry('a.test.mts', 'failed', exact)] }, '/repo', {});
    expect(summary.tests?.['a.test.mts']?.truncated).toBeUndefined();
  });

  it('caps each list and marks the file truncated', () => {
    const many = Array.from({ length: MAX_NAMES_PER_LIST + 1 }, (_, i) =>
      assertion(`t${i}`, 'failed'),
    );
    const summary = summarise({ testResults: [entry('a.test.mts', 'failed', many)] }, '/repo', {});
    expect(summary.tests?.['a.test.mts']?.failed).toHaveLength(MAX_NAMES_PER_LIST);
    expect(summary.tests?.['a.test.mts']?.truncated).toBe(true);
  });

  it('records no entry for a file past the summary budget', () => {
    const perFile = 2 * MAX_NAMES_PER_LIST;
    const fileCount = MAX_NAMES_PER_SUMMARY / perFile + 1;
    const results = Array.from({ length: fileCount }, (_, f) =>
      entry(
        `f${f}.test.mts`,
        'failed',
        Array.from({ length: perFile }, (_, i) => assertion(`t${i}`, i % 2 ? 'passed' : 'failed')),
      ),
    );
    const summary = summarise({ testResults: results }, '/repo', {});
    expect(Object.keys(summary.tests ?? {})).toHaveLength(fileCount - 1);
    expect(summary.tests?.[`f${fileCount - 1}.test.mts`]).toBeUndefined();
  });
});

describe('parseSummary — test names are optional evidence', () => {
  const base = {
    schema: 1,
    sha: 's',
    runId: 1,
    attempt: 1,
    testsPassed: false,
    droppedForeignPaths: 0,
  };
  const files = { 'a.test.mts': 'failed' };

  it('keeps a well-formed tests map (an older reader ignores it the same way)', () => {
    const tests = { 'a.test.mts': { failed: ['g > x'], passed: [] } };
    expect(parseSummary(JSON.stringify({ ...base, files, tests }), 'l').tests).toEqual(tests);
  });

  it('drops a malformed tests map without blanking the file answers', () => {
    const parsed = parseSummary(
      JSON.stringify({ ...base, files, tests: { 'a.test.mts': { failed: 'x' } } }),
      'l',
    );
    expect(parsed.tests).toBeUndefined();
    expect(parsed.files).toEqual(files);
  });
});

describe('testVerdict — positive evidence or unknown', () => {
  const path = 'a.test.mts';
  const summary = (tests?: TestReportSummary['tests']): TestReportSummary => ({
    schema: 1,
    sha: 's',
    runId: 1,
    attempt: 1,
    testsPassed: false,
    files: { [path]: 'failed' },
    tests,
    droppedForeignPaths: 0,
  });
  const recorded = summary({ [path]: { failed: ['g > x'], passed: ['g > y'] } });
  const ask = (s: TestReportSummary, name: string, status: FileStatus = 'failed') =>
    testVerdict(s, status, path, name).status;

  it('answers failed and passed only from the names a failed file recorded', () => {
    expect(ask(recorded, 'g > x')).toBe('failed');
    expect(ask(recorded, 'g > y')).toBe('passed');
  });

  it('strips the console prefix `<file> > ` before matching', () => {
    expect(testVerdict(recorded, 'failed', path, `${path} > g > y`)).toEqual({
      name: 'g > y',
      status: 'passed',
    });
  });

  it('never reads a name in neither list as green, and says when the list was capped', () => {
    expect(ask(recorded, 'g > typo')).toBe('unknown');
    const capped = summary({ [path]: { failed: [], passed: [], truncated: true } });
    expect(testVerdict(capped, 'failed', path, 'g > z').reason).toContain('capped');
  });

  it('answers a passed file at file grain, even for a misspelt name', () => {
    expect(ask(recorded, 'g > typo', 'passed')).toBe('file-passed');
  });

  it('is unknown for an old artifact, a file past the budget, or a file that did not run', () => {
    // A runner other than vitest may emit the summary shape without names, so blame no version.
    expect(testVerdict(summary(), 'failed', path, 'g > x').reason).toBe(
      'this run recorded no test names (its producer does not record them, or predates them)',
    );
    expect(testVerdict(summary({}), 'failed', path, 'g > x').reason).toContain('budget');
    expect(ask(recorded, 'g > x', 'excluded')).toBe('unknown');
  });
});

describe('baseline-status --test, end to end through a stubbed gh', () => {
  let dir: string;
  let fixture: string;
  const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };
  let out: string[];

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef()]));
    const summary = JSON.parse(summaryFor({ 'cli/a.test.mts': 'failed' }, false));
    summary.tests = { 'cli/a.test.mts': { failed: ['g > broken'], passed: ['g > fine'] } };
    writeFileSync(join(fixture, 'summary-100.json'), JSON.stringify(summary));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => out.push(line));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    baselineStatus(['--ref', 'main', '--file', 'cli/a.test.mts', ...args], dir);

  it("reports a locally failing test that passed in CI, and lists the file's CI failures", () => {
    expect(run('--test', 'cli/a.test.mts > g > fine')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('✗ g > broken');
    expect(text).toContain('test "g > fine": PASSED in CI');
  });

  it('carries the same answer in --json', () => {
    expect(run('--test', 'g > broken', '--json')).toBe(0);
    const file = JSON.parse(out.join('\n')).file;
    expect(file.failingTests).toEqual(['g > broken']);
    expect(file.test).toEqual({ name: 'g > broken', status: 'failed' });
  });

  it('reads names the producer wrote, and a collect failure stays unknown end to end', () => {
    // The producer and the reader each own half of the name format; this joins them.
    const produced = summarise(
      {
        success: false,
        testResults: [
          entry('cli/a.test.mts', 'failed', [
            assertion('fine', 'passed'),
            assertion('bad', 'failed'),
          ]),
          entry('cli/b.test.mts', 'failed', []),
        ],
      },
      '/repo',
      { GITHUB_SHA: 'sha1', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' },
    );
    writeFileSync(join(fixture, 'summary-100.json'), JSON.stringify(produced));
    expect(run('--test', 'cli/a.test.mts > g > fine')).toBe(0);
    expect(out.join('\n')).toContain('test "g > fine": PASSED in CI');
    out = [];
    expect(
      baselineStatus(['--ref', 'main', '--file', 'cli/b.test.mts', '--test', 'g > fine'], dir),
    ).toBe(0);
    expect(out.join('\n')).toContain('test "g > fine": UNKNOWN');
  });

  it('refuses --test without --file', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(baselineStatus(['--test', 'g > x'], dir)).toBe(1);
  });
});
