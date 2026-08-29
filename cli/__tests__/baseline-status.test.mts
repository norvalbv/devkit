/** sc-2245 — `devkit baseline-status` and its producer. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunRef, isUsableRun } from '../lib/baseline-status/gh.mts';
import { reservesReporter, summarise } from '../lib/baseline-status/produce.mts';
import { fileExistsAt, queryBaseline, resolveRef } from '../lib/baseline-status/query.mts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** A vitest report entry as the runner emits it: an ABSOLUTE path, rooted at the CI checkout. */
const entry = (root: string, path: string, status: string) => ({ name: join(root, path), status });

describe('summarise — the report reduction', () => {
  it('relativises runner-absolute paths against the repo root', () => {
    // The whole point: CI writes /home/runner/work/devkit/devkit/..., the querying developer types
    // cli/__tests__/x.test.mts. Without this the answer is "never ran" for every file.
    const ciRoot = '/home/runner/work/devkit/devkit';
    const summary = summarise(
      { success: true, testResults: [entry(ciRoot, 'cli/__tests__/x.test.mts', 'passed')] },
      ciRoot,
      {},
    );
    expect(summary.files).toEqual({ 'cli/__tests__/x.test.mts': 'passed' });
  });

  it('drops and COUNTS entries from nested runs outside the repo root', () => {
    // Real leakage: gate-engine/coverage/__tests__/produce.test.mts spawns a vitest child over a tmp
    // fixture, and that child's file shows up in this repo's live CI annotations.
    const summary = summarise(
      {
        success: false,
        testResults: [
          entry('/repo', 'cli/a.test.mts', 'passed'),
          { name: '/tmp/coverage-produce-4TDZDO/boom.test.mjs', status: 'failed' },
        ],
      },
      '/repo',
      {},
    );
    expect(Object.keys(summary.files)).toEqual(['cli/a.test.mts']);
    expect(summary.droppedForeignPaths).toBe(1);
  });

  it('merges a file appearing in two projects pessimistically', () => {
    // A per-project green must never mask a per-project red for the same path. FAILED FIRST is the
    // order that discriminates: a naive last-write-wins would report this pair as passed.
    const summary = summarise(
      {
        testResults: [
          entry('/repo', 'cli/a.test.mts', 'failed'),
          entry('/repo', 'cli/a.test.mts', 'passed'),
        ],
      },
      '/repo',
      {},
    );
    expect(summary.files['cli/a.test.mts']).toBe('failed');
  });

  it('merges passed/skipped the same way whichever project reports first', () => {
    // Order-dependent merging made these two inputs disagree: a file that PASSED in one project and
    // was skipped in another must resolve to passed either way.
    const both = (first: string, second: string) =>
      summarise(
        {
          testResults: [
            entry('/repo', 'cli/a.test.mts', first),
            entry('/repo', 'cli/a.test.mts', second),
          ],
        },
        '/repo',
        {},
      ).files['cli/a.test.mts'];
    expect(both('passed', 'skipped')).toBe('passed');
    expect(both('skipped', 'passed')).toBe('passed');
  });

  it('does not read an empty report as a pass', () => {
    // A truncated report (killed run) has no `success` flag and no entries. Deriving "passed" from
    // that is the fabricated green this whole feature exists to prevent.
    expect(summarise({}, '/repo', {}).testsPassed).toBe(false);
  });

  it('carries the CI run identity, and nulls it off CI', () => {
    const onCi = summarise({ success: true }, '/repo', {
      GITHUB_SHA: 'abc123',
      GITHUB_RUN_ID: '99',
      GITHUB_RUN_ATTEMPT: '2',
    });
    expect(onCi).toMatchObject({ sha: 'abc123', runId: 99, attempt: 2 });
    expect(summarise({ success: true }, '/repo', {})).toMatchObject({ sha: null, runId: null });
  });
});

describe('run selection', () => {
  const run = (status: string, conclusion: string) => ({
    databaseId: 1,
    attempt: 1,
    status,
    conclusion,
    headSha: 'a',
    createdAt: '',
  });

  it('accepts only runs that reached a pass/fail conclusion', () => {
    expect(isUsableRun(run('completed', 'success'))).toBe(true);
    expect(isUsableRun(run('completed', 'failure'))).toBe(true);
    // All three of these are `status: completed` and carry no report — selecting on status alone is
    // what would make one cancelled push run blank out an otherwise answerable question.
    expect(isUsableRun(run('completed', 'cancelled'))).toBe(false);
    expect(isUsableRun(run('completed', 'startup_failure'))).toBe(false);
    expect(isUsableRun(run('completed', 'timed_out'))).toBe(false);
    expect(isUsableRun(run('in_progress', ''))).toBe(false);
  });
});

describe('reservesReporter', () => {
  it('rejects args that would replace the reporter set', () => {
    expect(reservesReporter(['--reporter=json'])).toBe(true);
    expect(reservesReporter(['--outputFile.json=x'])).toBe(true);
    expect(reservesReporter(['--run', 'cli/a.test.mts'])).toBe(false);
  });
});

describe('the package script', () => {
  it('names all three reporters, so the human and annotation channels survive', () => {
    // `--reporter` REPLACES the set: dropping one silently kills the console summary or the
    // PR annotations.
    const produce = readFileSync(join(REPO_ROOT, 'cli/lib/baseline-status/produce.mts'), 'utf8');
    for (const reporter of ['--reporter=default', '--reporter=github-actions', '--reporter=json']) {
      expect(produce).toContain(`'${reporter}'`);
    }
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:run:report']).toBe('node cli/index.mts test-report-run');
  });
});

/** The query, driven against a stubbed `gh` on PATH — the pattern reship.test.mts uses. */
describe('queryBaseline', () => {
  let dir: string;
  let fixture: string;
  const saved = { PATH: process.env.PATH, fixture: process.env.DEVKIT_TEST_FIXTURE };

  // runId MUST match the run it is served for — the reader rejects an artifact that names another
  // run, so a fixture that lies about its provenance is correctly refused.
  const summaryFor = (
    files: Record<string, string>,
    testsPassed: boolean,
    runId = 100,
    attempt = 1,
  ) =>
    JSON.stringify({
      schema: 1,
      sha: 'sha1',
      runId,
      attempt,
      testsPassed,
      files,
      droppedForeignPaths: 0,
    });

  const withRuns = (runs: unknown[]) =>
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify(runs));

  const run = (over: Partial<RunRef> = {}) => ({
    databaseId: 100,
    attempt: 1,
    status: 'completed',
    conclusion: 'failure',
    headSha: 'deadbeefcafe',
    createdAt: '2026-08-29T00:00:00Z',
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'baseline-query-'));
    fixture = mkdtempSync(join(tmpdir(), 'baseline-fixture-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, 'gh');
    writeFileSync(
      stub,
      `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "list" ]; then cat "$DEVKIT_TEST_FIXTURE/runs.json"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  id="$3"; out=""
  while [ $# -gt 0 ]; do if [ "$1" = "--dir" ]; then out="$2"; fi; shift; done
  if [ -f "$DEVKIT_TEST_FIXTURE/summary-$id.json" ]; then
    mkdir -p "$out/run-$id"; cp "$DEVKIT_TEST_FIXTURE/summary-$id.json" "$out/run-$id/summary.json"; exit 0
  fi
  echo "no artifact matches any of the names or patterns provided" >&2; exit 1
fi
exit 1
`,
    );
    chmodSync(stub, 0o755);
    process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fixture === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fixture;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('reports a RED run whose queried file PASSED — the distinction sc-2245 was filed for', () => {
    withRuns([run()]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed', 'cli/b.test.mts': 'failed' }, false),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' });
    expect(answer.runStatus).toBe('red');
    expect(answer.file?.status).toBe('passed');
    expect(answer.failingFiles).toEqual(['cli/b.test.mts']);
  });

  it('separates the run verdict from the test verdict', () => {
    // A run reddened by lint while every test passed: two different facts, reported separately.
    withRuns([run()]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main' });
    expect(answer.runStatus).toBe('red');
    expect(answer.testsStatus).toBe('green');
  });

  it('skips a cancelled run and answers from the usable one behind it, naming the skip', () => {
    withRuns([run({ databaseId: 101, conclusion: 'cancelled' }), run({ databaseId: 100 })]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'failed' }, false),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main' });
    expect(answer.runId).toBe(100);
    expect(answer.skippedRuns[0]).toMatchObject({ runId: 101, conclusion: 'cancelled' });
  });

  it('caches per run ATTEMPT, so a re-run of the same sha is not served a stale answer', () => {
    withRuns([run({ attempt: 1 })]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'failed' }, false),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' }).file?.status).toBe(
      'failed',
    );

    // Same sha, same runId, new attempt — the flake was re-run and it now passes.
    withRuns([run({ attempt: 2 })]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true, 100, 2),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' }).file?.status).toBe(
      'passed',
    );
  });

  it('calls a null history "no-artifact-history" while any run in the window lacks data', () => {
    // Day one: the newest run has a summary, everything behind it predates the feature. "It has never
    // passed" would be a fabricated fact; the honest answer is that the window has holes.
    withRuns([run({ databaseId: 100 }), run({ databaseId: 99 })]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'failed' }, false),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' });
    expect(answer.file?.lastPassed).toBeNull();
    expect(answer.file?.lastPassedReason).toBe('no-artifact-history');
    expect(answer.file?.runsWithoutArtifact).toBe(1);
  });

  it('finds the last passing run when the window is complete', () => {
    withRuns([run({ databaseId: 100 }), run({ databaseId: 99, headSha: 'oldersha1234' })]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'failed' }, false),
    );
    writeFileSync(
      join(fixture, 'summary-99.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true, 99),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' });
    expect(answer.file?.lastPassed).toMatchObject({ runId: 99, sha: 'oldersha1234' });
    expect(answer.file?.lastPassedReason).toBe('found');
  });

  it('never reports a file it has no data for as anything but unknown', () => {
    // The commit is not in this checkout, so "absent" cannot be distinguished from "excluded" —
    // and a fact about the local clone must not be reported as a fact about the baseline.
    withRuns([run()]);
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'cli/zzz.test.mts' });
    expect(answer.file?.status).toBe('unknown');
    expect(answer.file?.reason).toMatch(/not in this checkout/);
  });

  it('returns a named unknown when every run predates the artifact', () => {
    withRuns([run({ databaseId: 100 }), run({ databaseId: 99 })]);
    const answer = queryBaseline({ cwd: dir, ref: 'main' });
    expect(answer.runStatus).toBe('unknown');
    expect(answer.reason).toBe('no-usable-run');
    expect(answer.skippedRuns).toHaveLength(2);
  });

  it('degrades to a named unknown, not a crash, when gh is absent', () => {
    process.env.PATH = join(dir, 'empty-bin');
    const answer = queryBaseline({ cwd: dir, ref: 'main' });
    expect(answer.reason).toBe('gh-missing');
    expect(answer.runStatus).toBe('unknown');
  });

  it('rejects a summary written by an incompatible schema rather than misreading it', () => {
    withRuns([run()]);
    writeFileSync(join(fixture, 'summary-100.json'), JSON.stringify({ schema: 99, files: {} }));
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
  });

  it('never turns a truncated artifact into a partial pass', () => {
    withRuns([run()]);
    writeFileSync(join(fixture, 'summary-100.json'), '{"schema":1,"files":{"cli/a.test.mts":"pas');
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' });
    expect(answer.reason).toBe('artifact-unreadable');
    expect(answer.file).toBeUndefined();
  });
});

describe('git-backed resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'baseline-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-b', 'trunk');
    // Fixtures set their own identity — an inherited-identity fixture is exactly what reddens CI.
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'a');
    writeFileSync(join(dir, 'kept.test.mts'), '');
    git('add', '-A');
    git('commit', '-m', 'seed');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('distinguishes a path absent at a commit from one the runner skipped', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(fileExistsAt(dir, sha, 'kept.test.mts')).toBe(true);
    expect(fileExistsAt(dir, sha, 'never-existed.test.mts')).toBe(false);
  });

  it('returns null — not false — for a commit this checkout has not fetched', () => {
    // Without this, "I have not fetched that commit" would be reported as "the file did not exist".
    expect(fileExistsAt(dir, '0'.repeat(40), 'kept.test.mts')).toBeNull();
  });

  it('falls back to main when the remote has no HEAD ref', () => {
    expect(resolveRef(dir)).toBe('main');
    expect(resolveRef(dir, 'explicit')).toBe('explicit');
  });
});
