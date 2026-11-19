/** `baseline-status --history`: one file's or test's outcome across recent runs on every branch. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineStatus from '../commands/baseline/status.mts';
import { queryHistory } from '../lib/baseline-status/history.mts';
import type { FileTests } from '../lib/baseline-status/produce.mts';
import { ghHarness, runRef, summaryFor } from './_baseline-fixture.mts';

const FILE = 'cli/a.test.mts';

let dir: string;
let fixture: string;
let out: string[];
const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };

/** A usable run of FILE on `branch`, newest-first order is the caller's. */
const run = (id: number, branch: string, over: Parameters<typeof runRef>[0] = {}) =>
  runRef({
    databaseId: id,
    headBranch: branch,
    event: branch === 'main' ? 'push' : 'pull_request',
    createdAt: `2026-10-0${id % 10}T00:00:00Z`,
    ...over,
  });

/** Serve `files` (and, for a failed file, its test names) as run `id`'s summary artifact. */
function serve(id: number, files: Record<string, string>, tests?: Record<string, FileTests>) {
  const summary = JSON.parse(summaryFor(files, !Object.values(files).includes('failed'), id));
  if (tests) summary.tests = tests;
  writeFileSync(join(fixture, `summary-${id}.json`), JSON.stringify(summary));
}

const failedTest = { [FILE]: { failed: ['g > flaky'], passed: ['g > fine'] } };
const passedTest = { [FILE]: { failed: ['g > fine'], passed: ['g > flaky'] } };

const history = (...args: string[]) => baselineStatus(['--history', '--file', FILE, ...args], dir);

beforeEach(() => {
  const h = ghHarness();
  dir = h.dir;
  fixture = h.fixture;
  process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
  process.env.DEVKIT_TEST_FIXTURE = fixture;
  out = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => out.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => out.push(line));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.PATH = saved.PATH;
  if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
  else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
  rmSync(dir, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});

describe('baseline-status --history', () => {
  it('counts one failure across branches and names the latest', () => {
    const runs = [run(8, 'main'), run(7, 'sc-1'), run(6, 'sc-2'), run(5, 'main')];
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify(runs));
    serve(8, { [FILE]: 'failed' }, passedTest);
    serve(7, { [FILE]: 'failed' }, failedTest);
    serve(6, { [FILE]: 'failed' }, passedTest);
    serve(5, { [FILE]: 'failed' }, passedTest);
    expect(history('--test', `${FILE} > g > flaky`)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('run 7  sc-1 (pull_request,');
    expect(text).toContain(
      'failed 1 of 4 run(s) with a test-level verdict (latest failure: run 7, 2026-10-07T00:00:00Z)',
    );
    expect(text).toContain('failed on: sc-1 · passed on 2 branch(es)');
    expect(text).not.toContain('\u001b');
  });

  it('keeps file-passed runs out of the rate, since the test may not exist there', () => {
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([run(3, 'sc-new'), run(2, 'main')]));
    serve(3, { [FILE]: 'failed' }, failedTest);
    serve(2, { [FILE]: 'passed' });
    expect(history('--test', 'g > flaky')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('failed 1 of 1 run(s) with a test-level verdict');
    expect(text).toContain('file passed in 1 more run(s): test presence unverified, not counted');
  });

  it('skips in-flight, cancelled and artifact-less runs and never counts them as passed', () => {
    const runs = [
      run(9, 'sc-1', { status: 'in_progress', conclusion: '' }),
      run(8, 'sc-2', { conclusion: 'cancelled' }),
      run(7, 'sc-3'),
      run(6, 'main', { conclusion: 'success' }),
      run(5, 'sc-4', { conclusion: 'success' }),
    ];
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify(runs));
    serve(6, { [FILE]: 'passed' });
    serve(5, { [FILE]: 'skipped' });
    const answer = queryHistory({
      cwd: dir,
      workflow: 'gate.yml',
      artifact: 'test-report-summary',
      path: FILE,
      maxRuns: 20,
    });
    expect(answer.skippedRuns.map((s) => [s.runId, s.conclusion])).toEqual([
      [9, 'in_progress'],
      [8, 'cancelled'],
      [7, 'failure'],
    ]);
    expect(answer.skippedRuns[2]?.why).toContain('has no `test-report-summary` artifact');
    // A file the runner skipped is no evidence the test passes.
    expect(answer).toMatchObject({ listed: 5, counts: { failed: 0, passed: 1, other: 1 } });
  });

  it('reports a file missing from a run as not-in-run, with no git remedy for a foreign head', () => {
    writeFileSync(
      join(fixture, 'runs.json'),
      JSON.stringify([run(4, 'sc-gone', { headSha: 'f'.repeat(40) })]),
    );
    serve(4, { 'cli/other.test.mts': 'passed' });
    expect(history('--test', 'g > flaky', '--json')).toBe(0);
    const answer = JSON.parse(out.join('\n'));
    expect(answer.rows[0]).toMatchObject({ status: 'not-in-run' });
    expect(answer.rows[0].reason).not.toContain('git fetch');
    expect(answer.counts).toEqual({ failed: 0, passed: 0, filePassed: 0, other: 1 });
  });

  it('answers at file level for a ./-relative path, naming the newest failure', () => {
    const runs = [run(3, 'sc-1'), run(2, 'main'), run(1, 'main')];
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify(runs));
    serve(3, { [FILE]: 'failed' });
    serve(2, { [FILE]: 'passed' });
    serve(1, { [FILE]: 'failed' });
    expect(baselineStatus(['--history', '--file', `./${FILE}`], dir)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(
      'failed 2 of 3 run(s) with a file verdict (latest failure: run 3, 2026-10-03T00:00:00Z)',
    );
    expect(text).toContain('failed on: sc-1, main · passed on 1 branch(es)');
  });

  it('lists the workflow without a branch or commit filter, bounded by --max-runs', () => {
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([]));
    expect(history('--max-runs', '7')).toBe(0);
    const listed = readFileSync(join(fixture, 'list.log'), 'utf8');
    expect(listed).toContain('run list --workflow gate.yml --limit 7');
    expect(listed).not.toMatch(/--commit|--branch/);
    expect(history('--max-runs', '9999', '--workflow', 'ci.yml')).toBe(0);
    expect(readFileSync(join(fixture, 'list.log'), 'utf8')).toContain(
      'run list --workflow ci.yml --limit 50',
    );
    expect(history('--max-runs', '0')).toBe(1);
  });

  it('exits 2 with the named reason when gh cannot list runs', () => {
    process.env.DEVKIT_GH_FAIL = 'gh auth login required';
    try {
      expect(history()).toBe(2);
    } finally {
      delete process.env.DEVKIT_GH_FAIL;
    }
    expect(out.join('\n')).toContain('gh-unauthenticated');
    // A gh failure while downloading is the same failed lookup, not a window of skipped runs.
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([run(2, 'sc-1'), run(1, 'main')]));
    process.env.DEVKIT_GH_DOWNLOAD_FAIL = 'HTTP 403: API rate limit exceeded';
    try {
      expect(history('--json')).toBe(2);
    } finally {
      delete process.env.DEVKIT_GH_DOWNLOAD_FAIL;
    }
    expect(JSON.parse(out.at(-1) ?? '{}')).toMatchObject({ reason: 'gh-failed', skippedRuns: [] });
    // Garbage from gh is a failed lookup, never an empty window that reads "failed 0 of 0".
    writeFileSync(join(fixture, 'runs.json'), 'not json');
    expect(history()).toBe(2);
    expect(out.join('\n')).toContain('gh-failed');
  });

  it('refuses a single-run, single-branch or PR flag, and a missing --file', () => {
    for (const extra of [
      ['--ref', 'main'],
      ['--run', '5'],
      ['--pr', '5'],
      ['--at', 'abc'],
    ]) {
      expect(history(...extra)).toBe(1);
    }
    expect(out.join('\n')).toContain('cannot take --pr');
    expect(baselineStatus(['--history'], dir)).toBe(1);
  });
});
