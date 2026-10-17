/** `devkit baseline-status --run <id>`: one named run of any event or branch, through a stubbed gh. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineStatus from '../commands/baseline/status.mts';
import type { RunRef } from '../lib/baseline-status/gh.mts';
import { CACHE_DIR, cacheName } from '../lib/baseline-status/source.mts';
import { addCommit, apiRun, ghHarness, runRef, summaryFor } from './_baseline-fixture.mts';

const PR_RUN = 200;

/** Raw API fields forced to null, as GitHub's REST schema allows for some of them. */
type NullFields = Partial<Record<keyof ReturnType<typeof apiRun>, null>>;

describe('baseline-status --run', () => {
  let dir: string;
  let fixture: string;
  let head: string;
  let out: string[];
  let err: string[];
  const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };

  /** Serve run 200 as GitHub's REST API does, defaulting to a red pull_request run. */
  const putRun = (over: Partial<RunRef> = {}, path?: string, raw: NullFields = {}) => {
    const run = runRef({
      databaseId: PR_RUN,
      event: 'pull_request',
      headBranch: 'feat/x',
      headSha: head,
      ...over,
    });
    writeFileSync(
      join(fixture, `run-${PR_RUN}.json`),
      JSON.stringify({ ...apiRun(run, path), ...raw }),
    );
  };
  /** Serve run 200's artifact; `sha` is the commit the run tested (a merge, for a PR run). */
  const putSummary = (sha: string | null, files: Record<string, string>, attempt = 1) => {
    const summary = JSON.parse(summaryFor(files, false, PR_RUN, attempt));
    summary.sha = sha;
    summary.tests = { 'cli/a.test.mts': { failed: ['g > broken'], passed: ['g > fine'] } };
    writeFileSync(join(fixture, `summary-${PR_RUN}.json`), JSON.stringify(summary));
  };
  const status = (...args: string[]) => baselineStatus(args, dir);
  const json = (...args: string[]) => {
    const code = status(...args, '--json');
    return { code, answer: JSON.parse(out.join('\n')) };
  };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    head = h.head;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => out.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => err.push(line));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('answers a red pull_request run, naming its event, branch, head and tested merge', () => {
    const merge = addCommit(dir);
    putRun();
    putSummary(merge, { 'cli/a.test.mts': 'failed', 'cli/b.test.mts': 'passed' });
    const { code, answer } = json('--run', String(PR_RUN));
    expect(code).toBe(0);
    expect(answer).toMatchObject({
      runStatus: 'red',
      testsStatus: 'red',
      ref: 'feat/x',
      event: 'pull_request',
      runId: PR_RUN,
      sha: head,
      testedSha: merge,
      failingFiles: ['cli/a.test.mts'],
      head: null,
      commitsBehindHead: null,
    });
    out = [];
    expect(status('--run', String(PR_RUN))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`run ${PR_RUN} · pull_request on feat/x`);
    expect(text).toContain(`tested merge ${merge.slice(0, 8)}`);
  });

  it('gives the per-file and per-test answers from that run, without a walk-back', () => {
    putRun();
    putSummary(null, { 'cli/a.test.mts': 'failed' });
    const { answer } = json(
      '--run',
      String(PR_RUN),
      '--file',
      'cli/a.test.mts',
      '--test',
      'g > broken',
    );
    expect(answer.file).toMatchObject({
      status: 'failed',
      failingTests: ['g > broken'],
      test: { name: 'g > broken', status: 'failed' },
      lastPassed: null,
      lastPassedReason: 'single-run',
    });
    out = [];
    status('--run', String(PR_RUN), '--file', 'cli/a.test.mts');
    expect(out.join('\n')).toContain('last passed: not searched (--run reads one run)');
  });

  it('judges an uncollected path at the merge the run tested, not at the PR head', () => {
    mkdirSync(join(dir, 'cli'));
    writeFileSync(join(dir, 'cli', 'base-only.test.mts'), '');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base adds a file'], { cwd: dir });
    const merge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    putRun();
    putSummary(merge, { 'cli/a.test.mts': 'failed' });
    // At the PR head the path never existed, so a head probe would answer a confident `absent`.
    expect(
      json('--run', String(PR_RUN), '--file', 'cli/base-only.test.mts').answer.file.status,
    ).toBe('excluded');
  });

  it('refuses to judge an uncollected path when a pull_request summary recorded no tested sha', () => {
    putRun();
    putSummary(null, { 'cli/a.test.mts': 'failed' });
    // The PR head is not what the run tested, so `absent` there would be a guess about the merge.
    const { file } = json('--run', String(PR_RUN), '--file', 'cli/gone.test.mts').answer;
    expect(file.status).toBe('unknown');
    expect(file.reason).toContain('did not record');
  });

  it('names the fetch that brings a tested merge into the checkout', () => {
    const missing = 'f'.repeat(40);
    putRun();
    putSummary(missing, { 'cli/a.test.mts': 'failed' });
    const { file } = json('--run', String(PR_RUN), '--file', 'cli/gone.test.mts').answer;
    expect(file.status).toBe('unknown');
    expect(file.reason).toContain(`git fetch origin ${missing}`);
  });

  it('answers unknown for a run without the artifact, advising CI only for the configured workflow', () => {
    putRun();
    const own = json('--run', String(PR_RUN));
    expect(own.code).toBe(0);
    expect(own.answer).toMatchObject({
      runStatus: 'unknown',
      reason: 'no-artifact',
      runId: PR_RUN,
    });
    expect(own.answer.remedy).toContain('devkit test-report-run');
    out = [];
    putRun({}, '.github/workflows/release.yml');
    const other = json('--run', String(PR_RUN)).answer;
    expect(other.reason).toBe('no-artifact');
    expect(other.remedy).toBeUndefined();
    expect(other.detail).toContain('run of release.yml');
  });

  it.each([
    ['in_progress', ''],
    ['completed', 'cancelled'],
  ])('refuses a %s/%s run as carrying no report, even with an artifact on hand', (s, c) => {
    putRun({ status: s, conclusion: c });
    putSummary(null, { 'cli/a.test.mts': 'passed' });
    const { code, answer } = json('--run', String(PR_RUN));
    expect(code).toBe(0);
    expect(answer).toMatchObject({ runStatus: 'unknown', reason: 'no-usable-run' });
    expect(answer.detail).toContain(c || s);
  });

  it("never answers a re-run from its first attempt's artifact", () => {
    putRun({ attempt: 2 });
    putSummary(null, { 'cli/a.test.mts': 'passed' }, 1);
    const { answer } = json('--run', String(PR_RUN));
    expect(answer).toMatchObject({ runStatus: 'unknown', reason: 'schema-mismatch', attempt: 2 });
    expect(answer.detail).toContain('cli/cli#12437');
  });

  it('answers a run GitHub sends with a null head_branch (the REST schema marks it nullable)', () => {
    putRun({}, undefined, { head_branch: null });
    putSummary(null, { 'cli/a.test.mts': 'failed' });
    const { code, answer } = json('--run', String(PR_RUN));
    expect(code).toBe(0);
    expect(answer).toMatchObject({ runStatus: 'red', ref: '', failingFiles: ['cli/a.test.mts'] });
  });

  it('reads a null status as a run with no report, not a gh failure', () => {
    putRun({}, undefined, { status: null, conclusion: null });
    putSummary(null, { 'cli/a.test.mts': 'passed' });
    const { answer } = json('--run', String(PR_RUN));
    expect(answer.reason).toBe('no-usable-run');
    expect(answer.detail).toContain('is unreported, so');
  });

  it('refuses a run object missing the fields it reads, as a gh failure (exit 2)', () => {
    putRun({}, undefined, { path: null, run_attempt: null });
    expect(json('--run', String(PR_RUN))).toMatchObject({
      code: 2,
      answer: { reason: 'gh-failed' },
    });
  });

  it('exits 2 naming the run when GitHub has no such run', () => {
    expect(status('--run', '999')).toBe(2);
    expect(out.join('\n')).toContain('baseline unknown on run 999 — gh-failed');
  });

  it.each([
    ['0x10'],
    ['1.5'],
    ['abc'],
    ['0'],
    ['12345678901234567890'],
    ['5', '--ref', 'main'],
    ['5', '--max-runs', '3'],
    ['5', '--workflow', 'gate.yml'],
  ])('refuses --run %s as a usage error, before any gh call', (...args) => {
    expect(status('--run', ...args)).toBe(1);
    expect(err.join('\n')).toMatch(/--run/);
    expect(existsSync(join(fixture, 'api.log'))).toBe(false);
  });

  it("reads the artifact named in the consumer's guard.config.json", () => {
    writeFileSync(join(dir, 'guard.config.json'), '{"baselineStatus":{"artifact":"custom"}}');
    putRun();
    putSummary(null, { 'cli/a.test.mts': 'failed' });
    expect(json('--run', String(PR_RUN)).answer.runStatus).toBe('red');
    expect(existsSync(join(dir, CACHE_DIR, cacheName(PR_RUN, 1, 'custom')))).toBe(true);
  });

  it("gates the CI remedy on the consumer's configured workflow, not devkit's gate.yml", () => {
    writeFileSync(join(dir, 'guard.config.json'), '{"baselineStatus":{"workflow":"ci.yml"}}');
    putRun();
    expect(json('--run', String(PR_RUN)).answer.remedy).toBeUndefined();
    out = [];
    putRun({}, '.github/workflows/ci.yml');
    expect(json('--run', String(PR_RUN)).answer.remedy).toContain('If that is not ci.yml');
  });
});
