/** A PR run's failing tests split into NEW and inherited against its base run's summary. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineStatus from '../commands/baseline/status.mts';
import {
  compareFailures,
  renderComparison,
  writeStepSummary,
} from '../lib/baseline-status/compare.mts';
import type { FileTests, TestReportSummary } from '../lib/baseline-status/produce.mts';
import type { BaselineAnswer } from '../lib/baseline-status/query.mts';
import { addCommit, ghHarness } from './_baseline-fixture.mts';

/** Recorded names for failed files, shaped as the producer writes them. */
const named = (
  failedTests: Record<string, string[]> | undefined,
  truncated?: true,
): Record<string, FileTests> | undefined =>
  failedTests &&
  Object.fromEntries(
    Object.entries(failedTests).map(([file, failed]) => [
      file,
      { failed, passed: [], ...(truncated && { truncated }) },
    ]),
  );

const pr = (
  files: Record<string, 'passed' | 'failed'>,
  failedTests?: Record<string, string[]>,
): TestReportSummary => ({
  schema: 1,
  sha: null,
  runId: null,
  attempt: null,
  testsPassed: false,
  files,
  ...(failedTests && { tests: named(failedTests) }),
  droppedForeignPaths: 0,
});

const base = (
  failingFiles: string[],
  failingTests?: Record<string, string[]>,
  truncated?: true,
): BaselineAnswer => ({
  runStatus: 'red',
  testsStatus: 'red',
  ref: 'main',
  runId: 7,
  attempt: 1,
  sha: 'b'.repeat(40),
  failingFiles,
  ...(failingTests && { tests: named(failingTests, truncated) }),
  head: 'b'.repeat(40),
  commitsBehindHead: 0,
  commitsWithoutRun: [],
  skippedRuns: [],
});

describe('compareFailures', () => {
  it('reads a failure main gained after the branch point as inherited only', () => {
    const c = compareFailures(
      pr({ 'a.test.mts': 'failed' }, { 'a.test.mts': ['x'] }),
      base(['a.test.mts'], { 'a.test.mts': ['x'] }),
    );
    expect(c).toMatchObject({ fresh: [], inherited: [{ file: 'a.test.mts', test: 'x' }] });
    expect(renderComparison(c, base(['a.test.mts']))).toContain(
      'inherited only — every failure here also fails at bbbbbbbb',
    );
  });

  it('names exactly the new test inside a file that already fails at the base', () => {
    const c = compareFailures(
      pr({ 's.test.mts': 'failed' }, { 's.test.mts': ['old 1', 'new', 'old 2'] }),
      base(['s.test.mts'], { 's.test.mts': ['old 1', 'old 2'] }),
    );
    expect(c.fresh).toEqual([{ file: 's.test.mts', test: 'new' }]);
    expect(c.inherited).toHaveLength(2);
    expect(c.namesKnown).toBe(true);
  });

  it('counts every failure in a file that passes at the base as NEW', () => {
    const c = compareFailures(
      pr({ 'r.test.mts': 'failed', 'q.test.mts': 'failed' }, { 'r.test.mts': ['t'] }),
      base([]),
    );
    expect(c.fresh).toEqual([{ file: 'q.test.mts' }, { file: 'r.test.mts', test: 't' }]);
  });

  it.each([
    ['the base recorded no names', { 'a.test.mts': ['t'] }, undefined],
    ['the PR file failed at suite level', { 'a.test.mts': [] }, { 'a.test.mts': ['t'] }],
    ['the base file failed at suite level', { 'a.test.mts': ['t', 'u'] }, { 'a.test.mts': [] }],
  ])('compares by file, never guessing NEW, when %s', (_, prNames, baseNames) => {
    const c = compareFailures(
      pr({ 'a.test.mts': 'failed' }, prNames),
      base(['a.test.mts'], baseNames),
    );
    expect(c).toMatchObject({ fresh: [], inherited: [{ file: 'a.test.mts' }], namesKnown: false });
  });

  it('compares by file when the base list was truncated', () => {
    const c = compareFailures(
      pr({ 'a.test.mts': 'failed' }, { 'a.test.mts': ['beyond'] }),
      base(['a.test.mts'], { 'a.test.mts': ['t0'] }, true),
    );
    expect(c.fresh).toEqual([]);
  });

  it('lists base failures that pass here as fixed', () => {
    const c = compareFailures(
      pr({ 'a.test.mts': 'passed' }),
      base(['a.test.mts', 'gone.test.mts']),
    );
    expect(c.fixed).toEqual(['a.test.mts']);
  });

  it('names the sha that answered and its distance from the PR base', () => {
    const answer = { ...base([]), commitsBehindHead: 2 };
    expect(renderComparison(compareFailures(pr({}), answer), answer)[0]).toBe(
      'compared with main @ bbbbbbbb (run 7, 2 commit(s) before the PR base)',
    );
  });
});

describe('writeStepSummary', () => {
  it('appends only when the runner provides a step summary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-summary-'));
    const file = join(dir, 'summary.md');
    writeStepSummary(['line'], {});
    expect(existsSync(file)).toBe(false);
    writeStepSummary(['line'], { GITHUB_STEP_SUMMARY: file });
    expect(readFileSync(file, 'utf8')).toContain('```text\nline\n```');
    rmSync(dir, { recursive: true, force: true });
  });
});

/** The CLI end to end against a stubbed `gh`, walking from an explicit `--at`. */
describe('baseline-status --at / --against', () => {
  let dir: string;
  let fixture: string;
  let head: string;
  let stepSummary: string;
  const saved = {
    PATH: process.env.PATH,
    fixture: process.env.DEVKIT_TEST_FIXTURE,
    summary: process.env.GITHUB_STEP_SUMMARY,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  /** The base run's summary as CI would upload it — provenance must match the run it serves. */
  const serveBase = (sha: string) => {
    const run = { databaseId: 100, attempt: 1, status: 'completed', conclusion: 'failure' };
    const meta = { createdAt: '', headBranch: 'main', event: 'push' };
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([{ ...run, ...meta, headSha: sha }]));
    writeFileSync(
      join(fixture, 'summary-100.json'),
      JSON.stringify({
        ...pr({ 's.test.mts': 'failed' }, { 's.test.mts': ['old'] }),
        runId: 100,
        attempt: 1,
      }),
    );
  };

  const run = (args: string[]) => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)));
    try {
      return { code: baselineStatus(args, dir), out: out.join('\n') };
    } finally {
      log.mockRestore();
    }
  };

  beforeEach(() => {
    ({ dir, fixture, head } = ghHarness());
    stepSummary = join(fixture, 'step-summary.md');
    process.env.PATH = `${join(dir, 'bin')}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    writeFileSync(
      join(dir, 'pr.json'),
      JSON.stringify(pr({ 's.test.mts': 'failed' }, { 's.test.mts': ['old', 'new'] })),
    );
  });

  afterEach(() => {
    restore('PATH', saved.PATH);
    restore('DEVKIT_TEST_FIXTURE', saved.fixture);
    restore('GITHUB_STEP_SUMMARY', saved.summary);
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('walks from the --at commit, not the branch head, and names the new test', () => {
    const baseSha = head;
    addCommit(dir); // the branch head moves on; --at must still answer from baseSha
    serveBase(baseSha);
    const { code, out } = run(['--ref', 'main', '--at', 'HEAD~1', '--against', 'pr.json']);
    expect(code).toBe(0);
    expect(out).toContain(`compared with main @ ${baseSha.slice(0, 8)} (run 100)`);
    expect(out).toContain('NEW — not failing at');
    expect(out).toContain('✗ s.test.mts > new');
    expect(out).toContain('· s.test.mts > old');
    expect(existsSync(join(fixture, 'api.log'))).toBe(false);
    expect(readFileSync(stepSummary, 'utf8')).toContain('s.test.mts > new');
  });

  it('reports an unknown base without writing a step summary', () => {
    writeFileSync(join(fixture, 'runs.json'), '[]');
    const { code, out } = run(['--ref', 'main', '--at', 'HEAD', '--against', 'pr.json']);
    expect(code).toBe(0);
    expect(out).toContain('baseline unknown on main');
    expect(existsSync(stepSummary)).toBe(false);
  });

  it("names the older run it fell back to when the base commit's own run is still in flight", () => {
    const older = head;
    const baseSha = addCommit(dir);
    serveBase(older);
    const runs = JSON.parse(readFileSync(join(fixture, 'runs.json'), 'utf8'));
    const inFlight = { ...runs[0], databaseId: 101, status: 'in_progress', conclusion: '' };
    runs.push({ ...inFlight, headSha: baseSha });
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify(runs));
    const { out } = run(['--ref', 'main', '--at', baseSha, '--against', 'pr.json']);
    expect(out).toContain(
      `compared with main @ ${older.slice(0, 8)} (run 100, 1 commit(s) before the PR base)`,
    );
  });

  it('emits the comparison beside the base answer under --json', () => {
    serveBase(head);
    const { out } = run(['--ref', 'main', '--at', 'HEAD', '--against', 'pr.json', '--json']);
    expect(JSON.parse(out)).toMatchObject({
      runId: 100,
      tests: { 's.test.mts': { failed: ['old'] } },
      comparison: { fresh: [{ file: 's.test.mts', test: 'new' }], namesKnown: true },
    });
  });

  it('refuses --file with --against rather than silently answering only one', () => {
    serveBase(head);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { code } = run(['--ref', 'main', '--file', 's.test.mts', '--against', 'pr.json']);
      expect(code).toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toContain('--file and --against');
    } finally {
      error.mockRestore();
    }
  });

  it('refuses an --at that is not a commit here, and a missing PR summary', () => {
    expect(run(['--ref', 'main', '--at', 'nope', '--against', 'pr.json']).out).toContain(
      '--at nope is not a commit in this checkout',
    );
    const missing = run(['--ref', 'main', '--against', 'absent.json']);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain('no readable run summary at absent.json');
  });
});
