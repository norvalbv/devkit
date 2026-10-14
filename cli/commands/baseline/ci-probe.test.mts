import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from '../../__tests__/_helpers.mts';
import type { TestReportSummary } from '../../lib/baseline-status/produce.mts';
import ciProbe, { type ProbeResult, runProbe } from './ci-probe.mts';

/** gh, faked from a fixture dir: the probe's run is whatever commit the probe asks about. */
const GH_STUB = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const F = process.env.DEVKIT_TEST_FIXTURE;
const a = process.argv.slice(2);
const at = (f) => path.join(F, f);
const val = (flag) => a[a.indexOf(flag) + 1];
fs.appendFileSync(at('gh.log'), a.join(' ') + '\\n');
if (a[0] === 'workflow' && a[1] === 'run') {
  if (!fs.existsSync(at('no-dispatch'))) process.exit(0);
  process.stderr.write("HTTP 422: Workflow does not have 'workflow_dispatch' trigger\\n");
  process.exit(1);
}
if (a[0] === 'run' && a[1] === 'list') {
  const sha = val('--commit');
  if (sha === fs.readFileSync(at('base-sha'), 'utf8')) {
    process.stdout.write(fs.readFileSync(at('base-runs.json'), 'utf8'));
  } else if (fs.existsSync(at('probe-run.json'))) {
    fs.writeFileSync(at('probe-sha'), sha);
    const run = JSON.parse(fs.readFileSync(at('probe-run.json'), 'utf8'));
    process.stdout.write(JSON.stringify([{ ...run, headSha: sha, headBranch: 'devkit-probe/' + sha.slice(0, 12) }]));
  } else process.stdout.write('[]');
  process.exit(0);
}
if (a[0] === 'run' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({ url: 'https://gh/runs/' + a[2], jobs: [] }));
  process.exit(0);
}
if (a[0] === 'run' && a[1] === 'download') {
  if (!fs.existsSync(at('summary-' + a[2] + '.json'))) {
    process.stderr.write('no valid artifacts found to download\\n');
    process.exit(1);
  }
  const probe = fs.existsSync(at('probe-sha')) ? fs.readFileSync(at('probe-sha'), 'utf8') : '';
  const body = fs.readFileSync(at('summary-' + a[2] + '.json'), 'utf8').replace('__PROBE__', probe);
  fs.mkdirSync(path.join(val('--dir'), a[2]), { recursive: true });
  fs.writeFileSync(path.join(val('--dir'), a[2], 'summary.json'), body);
  process.exit(0);
}
if (a[0] === 'api' && a[2] === 'DELETE') process.exit(0);
process.exit(1);
`;

const run = (databaseId: number, over: Record<string, string> = {}) => ({
  databaseId,
  attempt: 1,
  status: 'completed',
  conclusion: 'failure',
  headSha: '',
  createdAt: '',
  headBranch: 'main',
  event: 'push',
  ...over,
});

const summary = (
  runId: number,
  sha: string,
  files: TestReportSummary['files'],
  failedNames: Record<string, string[]> = {},
): TestReportSummary => ({
  schema: 1,
  sha,
  runId,
  attempt: 1,
  testsPassed: !Object.values(files).includes('failed'),
  files,
  tests: Object.fromEntries(
    Object.entries(failedNames).map(([file, failed]) => [file, { failed, passed: [] }]),
  ),
  droppedForeignPaths: 0,
});

let repo: string;
let origin: string;
let fixture: string;
let saved: NodeJS.ProcessEnv;
type Run = ReturnType<typeof run>;
const put = (name: string, body: string) => writeFileSync(join(fixture, name), body);
const putJson = (name: string, body: Run | Run[] | TestReportSummary) =>
  put(name, JSON.stringify(body));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const read = (name: string) => readFileSync(join(fixture, name), 'utf8');
const ghLog = () => read('gh.log');

async function probe(
  budgetMs = 60_000,
  cwd = repo,
): Promise<{ result: ProbeResult; lines: string[] }> {
  const lines: string[] = [];
  const opts = { cwd, workflow: 'gate.yml', artifact: 'test-report-summary', budgetMs };
  const result = await runProbe({ ...opts, pollMs: 1, log: (l) => lines.push(l) });
  return { result, lines };
}

beforeEach(() => {
  saved = { ...process.env };
  origin = mkdtempSync(join(tmpdir(), 'probe-origin-'));
  repo = mkdtempSync(join(tmpdir(), 'probe-repo-'));
  fixture = mkdtempSync(join(tmpdir(), 'probe-fixture-'));
  git(origin, 'init', '-q', '--bare');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.c');
  git(repo, 'config', 'user.name', 'a');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  writeFileSync(join(repo, 'c.test.mts'), '');
  git(repo, 'add', 'a.txt', 'c.test.mts');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'remote', 'add', 'origin', origin);
  // The summary cache lives in .devkit/, which a consumer ignores.
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.devkit/\n');
  git(repo, 'push', '-q', 'origin', 'main');
  const base = git(repo, 'rev-parse', 'HEAD');
  mkdirSync(join(fixture, 'bin'));
  writeFileSync(join(fixture, 'bin', 'gh'), GH_STUB);
  chmodSync(join(fixture, 'bin', 'gh'), 0o755);
  put('base-sha', base);
  putJson('base-runs.json', [run(100, { headSha: base })]);
  putJson('probe-run.json', run(200, { event: 'workflow_dispatch' }));
  const baseNames = { 'a.test.mts': ['x > broke'] };
  putJson(
    'summary-100.json',
    summary(
      100,
      base,
      { 'a.test.mts': 'failed', 'b.test.mts': 'passed', 'c.test.mts': 'passed' },
      baseNames,
    ),
  );
  const probeNames = { 'a.test.mts': ['x > broke'], 'b.test.mts': ['y > new'] };
  putJson(
    'summary-200.json',
    summary(200, '__PROBE__', { 'a.test.mts': 'failed', 'b.test.mts': 'failed' }, probeNames),
  );
  process.env.PATH = `${join(fixture, 'bin')}:${process.env.PATH}`;
  process.env.DEVKIT_TEST_FIXTURE = fixture;
  // The uncommitted change under test, plus an untracked file the probe must leave out.
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  writeFileSync(join(repo, 'untracked.txt'), 'x\n');
});

afterEach(() => {
  process.env = saved;
  for (const dir of [repo, origin, fixture]) rmSync(dir, { recursive: true, force: true });
});

describe('runProbe', () => {
  it('names new and lost files against the base, then deletes the probe branch', async () => {
    const { result, lines } = await probe();
    expect(result).toMatchObject({
      answer: 'answered',
      newFailing: ['b.test.mts', 'c.test.mts'],
      lost: ['c.test.mts'],
      inherited: ['a.test.mts'],
      unsure: [],
      baseRun: 100,
      runUrl: 'https://gh/runs/200',
    });
    expect(lines).toContain('ci-probe: 1 untracked file(s) left out — git add them to include');
    expect(ghLog()).toContain(`workflow run gate.yml --ref ${result.ref}`);
    expect(ghLog()).toContain(`api -X DELETE repos/{owner}/{repo}/git/refs/heads/${result.ref}`);
  });

  it('pushes the tracked change and leaves the branch, index and worktree as they were', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const status = git(repo, 'status', '--porcelain');
    const { result } = await probe();
    expect(git(origin, 'show', `${result.sha}:a.txt`)).toBe('changed');
    expect(() => git(origin, 'show', `${result.sha}:untracked.txt`)).toThrow();
    expect(git(origin, 'rev-parse', `${result.sha}^`)).toBe(head);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
  });

  it('reads the same answer from a subdirectory, where git paths are cwd-relative', async () => {
    mkdirSync(join(repo, 'pkg'));
    const { result, lines } = await probe(60_000, join(repo, 'pkg'));
    expect(result).toMatchObject({ answer: 'answered', lost: ['c.test.mts'] });
    expect(git(origin, 'show', `${result.sha}:a.txt`)).toBe('changed');
    expect(lines).toContain('ci-probe: 1 untracked file(s) left out — git add them to include');
  });

  it('does not call a test file the change deletes lost', async () => {
    rmSync(join(repo, 'c.test.mts'));
    const { result } = await probe();
    expect(result).toMatchObject({ answer: 'answered', newFailing: ['b.test.mts'], lost: [] });
  });

  it.each([
    [
      'the run is still going',
      'run 200 is in_progress',
      () => putJson('probe-run.json', run(200, { status: 'in_progress', conclusion: '' })),
    ],
    ['no run ever started', 'no run started', () => rmSync(join(fixture, 'probe-run.json'))],
  ])(
    'keeps the branch and answers timed-out when %s at the deadline',
    async (_l, detail, arrange) => {
      arrange();
      const { result } = await probe(0);
      expect(result).toMatchObject({
        answer: 'unknown',
        reason: 'timed-out',
        detail,
        newFailing: [],
      });
      expect(ghLog()).not.toContain('DELETE');
    },
  );

  it.each([
    [
      'the push is refused',
      'push-failed',
      () => git(repo, 'remote', 'set-url', 'origin', '/nonexistent'),
    ],
    [
      'git has no committer identity',
      'snapshot-failed',
      () => {
        process.env.GIT_COMMITTER_NAME = '';
        process.env.GIT_AUTHOR_NAME = '';
      },
    ],
  ])('answers unknown and calls no gh when %s', async (_label, reason, arrange) => {
    arrange();
    const { result } = await probe();
    expect(result).toMatchObject({ answer: 'unknown', reason, newFailing: [] });
    expect(existsSync(join(fixture, 'gh.log'))).toBe(false);
  });

  it.each([
    [
      'the base run is still going',
      'base-pending',
      () =>
        putJson('base-runs.json', [
          run(100, { headSha: read('base-sha'), status: 'in_progress', conclusion: '' }),
        ]),
    ],
    [
      'the run was cancelled',
      'run-unusable',
      () => putJson('probe-run.json', run(200, { conclusion: 'cancelled' })),
    ],
    ['the run uploaded no summary', 'no-artifact', () => rmSync(join(fixture, 'summary-200.json'))],
    [
      'the run tested another commit',
      'sha-mismatch',
      () => putJson('summary-200.json', summary(200, 'f'.repeat(40), {})),
    ],
    [
      'the tests failed without naming a file',
      'no-results',
      () => putJson('summary-200.json', { ...summary(200, '__PROBE__', {}), testsPassed: false }),
    ],
    [
      'the default branch has no remote-tracking ref',
      'base-unknown',
      () => git(repo, 'update-ref', '-d', 'refs/remotes/origin/main'),
    ],
    [
      'the workflow cannot be dispatched',
      'workflow-not-dispatchable',
      () => put('no-dispatch', ''),
    ],
  ])('answers unknown, never "none new", when %s', async (_label, reason, arrange) => {
    arrange();
    const { result } = await probe();
    expect(result).toMatchObject({ answer: 'unknown', reason, newFailing: [] });
    expect(ghLog()).toContain('DELETE');
  });
});

describe('devkit ci-probe', () => {
  it.each([[['--bogus']], [['--timeout', 'soon']], [['--timeout', '']], [['stray']]])(
    'refuses %j as a usage error',
    async (args) => {
      expect(await ciProbe(args, repo)).toBe(1);
    },
  );

  it('exits 0 with the verdict line once answered, through the CLI entry', () => {
    const cli = join(import.meta.dirname, '../../index.mts');
    const { status, stdout } = testSpawnSync(process.execPath, [cli, 'ci-probe'], {
      cwd: repo,
      encoding: 'utf8',
      env: process.env,
    });
    expect(status).toBe(0);
    expect(stdout).toMatch(
      /^ci-probe: new=2 lost=1 inherited=1 unsure=0 new-failing=b.test.mts,c.test.mts /,
    );
    expect(existsSync(join(fixture, 'probe-sha'))).toBe(true);
  });
});
