import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNHANDLED_REPORTER } from '../../gate-engine/coverage/failures.mts';
import type { UnhandledError } from '../../gate-engine/coverage/unhandled-reporter.mts';
import {
  GATE_REASON_ENV,
  readGateReason,
  reasonDetail,
  reasonReport,
} from '../../gate-engine/deterministic/reason.mts';
import {
  relatedPaths,
  relatedTestsReason,
  runRelatedTests,
} from '../lib/husky/gate-policy/related-tests.mts';

type ExecOpts = { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv };

function fakeExec(status: number | null) {
  return vi.fn((_cmd: string, _args: string[], _opts: ExecOpts) => ({ status }));
}

const dirs: string[] = [];
// A failing run writes its reason only where a test points it, never into an enclosing gate's file.
beforeEach(() => vi.stubEnv(GATE_REASON_ENV, ''));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// A committed a.mts + b.mts, both then edited on disk, with nothing staged yet.
function editedRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'related-tests-')));
  dirs.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 1;\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 2;\n');
  return repo;
}

describe('relatedPaths', () => {
  it('drops the full-suite triggers and sorts the rest', () => {
    expect(
      relatedPaths([
        'src/b.mts',
        'package.json',
        'vitest.config.mjs',
        'src/a.mts',
        'vitest.setup.mjs',
      ]),
    ).toEqual(['src/a.mts', 'src/b.mts']);
  });

  // vitest's triggers are `**/package.json` and `**/{vitest,vite}.config.*`; every release stages dist/package.json.
  it('drops nested trigger files too, keeping look-alikes', () => {
    expect(
      relatedPaths([
        'dist/package.json',
        'templates/app/vite.config.ts',
        'vitest.e2e.config.mjs',
        'cli/package-json.mts',
      ]),
    ).toEqual(['cli/package-json.mts', 'vitest.e2e.config.mjs']);
  });
});

describe('runRelatedTests', () => {
  it('passes without running vitest when nothing is staged', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    expect(runRelatedTests('/repo', { staged: null, exec })).toBe(0);
    expect(runRelatedTests('/repo', { staged: ['package.json'], exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: none selected');
  });

  it('runs vitest related on the staged paths and propagates a failure', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      join('/repo', 'node_modules', '.bin', 'vitest'),
      [
        'related',
        '--run',
        '--reporter=dot',
        '--reporter=json',
        expect.stringMatching(/^--outputFile\.json=.+results\.json$/),
        `--reporter=${UNHANDLED_REPORTER}`,
        'cli/a.mts',
      ],
      { cwd: '/repo', stdio: 'inherit', env: expect.any(Object) },
    );
  });

  it('blocks when vitest is killed or cannot spawn', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(null);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
  });

  it('selects from the index, never from unstaged edits', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec.mock.calls[0][1].at(-1)).toBe('a.mts');
  });

  // `commit -a` / `commit <path>` stage into an alternate index the hook hands over via the carrier.
  it('selects from the commit index the hook carries, not the default index', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const alt = join(repo, '.git', 'next-index');
    execFileSync('git', ['read-tree', 'HEAD'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    execFileSync('git', ['add', 'b.mts'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    vi.stubEnv('DEVKIT_COMMIT_INDEX_FILE', alt);
    vi.stubEnv('DEVKIT_COMMIT_GIT_DIR', join(repo, '.git'));
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec.mock.calls[0][1].at(-1)).toBe('b.mts');
  });
});

const failed = (file: string, ...names: string[]) => ({
  name: file,
  status: 'failed',
  assertionResults: names.map((fullName) => ({
    status: 'failed',
    fullName,
    failureMessages: ['x'],
  })),
});

// vitest writes its json report where --outputFile.json points; this stands in for that run.
const reportPath = (args: string[]) =>
  args.find((a) => a.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);

interface FakeReport {
  testResults: unknown[];
}

// unhandled.json stands in for what devkit's unhandled reporter writes beside the json report.
function reportingExec(status: number, report: FakeReport, unhandled?: UnhandledError[]) {
  return vi.fn((_cmd: string, args: string[], _opts: ExecOpts) => {
    const out = reportPath(args);
    if (out) writeFileSync(out, JSON.stringify(report));
    if (out && unhandled)
      writeFileSync(join(dirname(out), 'unhandled.json'), JSON.stringify(unhandled));
    return { status };
  });
}

function reasonFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'related-tests-reason-')));
  dirs.push(dir);
  const file = join(dir, 'reason.txt');
  vi.stubEnv(GATE_REASON_ENV, file);
  return file;
}

describe('relatedTestsReason', () => {
  const ran = { status: 1 };

  it('names up to five failing tests by file and title, then counts the rest', () => {
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    const diagnosis = {
      failedFiles: ['/repo/cli/a.test.mts'],
      flaky: [],
      failures: {
        tests: names.map((name) => ({ file: '/repo/cli/a.test.mts', name })),
        allTimedOut: false,
        timeoutMs: null,
      },
    };
    expect(relatedTestsReason(ran, diagnosis, '/repo')).toEqual([
      '1 test file(s) failed:',
      ...names.slice(0, 5).map((n) => `cli/a.test.mts > ${n}`),
      '(2 more in the full log above)',
    ]);
  });

  it('names a file that failed to load with the first line of its error', () => {
    const diagnosis = {
      failedFiles: ['/repo/cli/b.test.mts'],
      flaky: [],
      failures: { tests: [], allTimedOut: false, timeoutMs: null },
      collection: [
        { file: '/repo/cli/b.test.mts', message: 'Error: Cannot find module x\n  at y' },
      ],
    };
    expect(relatedTestsReason(ran, diagnosis, '/repo')).toEqual([
      '1 test file(s) failed:',
      'cli/b.test.mts — failed to load: Error: Cannot find module x',
    ]);
  });

  it('names what ended a run in which no test failed', () => {
    const diagnosis = {
      failedFiles: [],
      flaky: [],
      unhandled: [
        { file: '/repo/cli/c.test.mts', message: 'TypeError: boom' },
        { file: null, message: 'Error: late' },
      ],
    };
    expect(relatedTestsReason(ran, diagnosis, '/repo')).toEqual([
      'No test failed; the run ended on:',
      'cli/c.test.mts: TypeError: boom',
      'Error: late',
    ]);
  });

  it('says there is no report rather than inventing a cause', () => {
    expect(relatedTestsReason(ran, null, '/repo')).toEqual([
      'vitest exited 1 without a test report — its output is in the full log above',
    ]);
  });

  it('says vitest could not run when it never started or was killed', () => {
    const error = new Error('spawn ENOENT');
    expect(relatedTestsReason({ status: null, error }, null, '/repo')).toEqual([
      'related-tests could not run vitest: spawn ENOENT',
    ]);
    expect(relatedTestsReason({ status: null }, null, '/repo')).toEqual([
      'related-tests could not run vitest: it was killed before exiting',
    ]);
  });
});

describe('runRelatedTests failure reason', () => {
  it('records the failing test for the aggregated block and the digest, then removes its report', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    const exec = reportingExec(1, {
      testResults: [
        failed('/repo/cli/__tests__/x.test.mts', 'readCodexRateLimits > keeps the answer'),
      ],
    });
    expect(runRelatedTests('/repo', { staged: ['cli/x.mts'], exec })).toBe(1);

    const reason = readGateReason(file);
    expect(reason).toEqual([
      '1 test file(s) failed:',
      'cli/__tests__/x.test.mts > readCodexRateLimits > keeps the answer',
    ]);
    expect(reasonReport([{ label: 'related-tests', reason }]).join('\n')).toContain(
      '     cli/__tests__/x.test.mts > readCodexRateLimits > keeps the answer',
    );
    expect(reasonDetail('related-tests', reason)).toBe(
      'related-tests: 1 test file(s) failed: · cli/__tests__/x.test.mts > readCodexRateLimits > keeps the answer',
    );
    const [, args, opts] = exec.mock.calls[0];
    expect(opts.env[GATE_REASON_ENV]).toBeUndefined();
    const out = reportPath(args)!;
    expect(existsSync(dirname(out))).toBe(false);
  });

  it('keeps the count and the first test inside the digest detail cap', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    const long = 'x'.repeat(300);
    const exec = reportingExec(1, {
      testResults: [failed('/repo/cli/a.test.mts', `${long} 1`, `${long} 2`, `${long} 3`)],
    });
    runRelatedTests('/repo', { staged: ['cli/a.mts'], exec });
    const detail = reasonDetail('related-tests', readGateReason(file));
    expect(Array.from(detail).length).toBeLessThanOrEqual(500);
    expect(detail).toContain(`1 test file(s) failed: · cli/a.test.mts > ${long} 1`);
  });

  // vitest exits 1 on an error thrown outside any test; "0 test file(s) failed" would hide it.
  it("names the unhandled error devkit's reporter wrote beside the report", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    const exec = reportingExec(1, { testResults: [] }, [
      { file: '/repo/cli/__tests__/y.test.mts', message: 'TypeError: late boom' },
    ]);
    expect(runRelatedTests('/repo', { staged: ['cli/y.mts'], exec })).toBe(1);
    expect(readGateReason(file)).toEqual([
      'No test failed; the run ended on:',
      'cli/__tests__/y.test.mts: TypeError: late boom',
    ]);
  });

  it('records nothing when the related tests pass', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    expect(
      runRelatedTests('/repo', {
        staged: ['cli/a.mts'],
        exec: reportingExec(0, { testResults: [] }),
      }),
    ).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('still runs, unnarrated, when no report directory can be made', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('TMPDIR', join(tmpdir(), 'related-tests-missing', 'nope'));
    const exec = fakeExec(0);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(0);
    expect(exec.mock.calls[0][1]).toEqual(['related', '--run', '--reporter=dot', 'cli/a.mts']);
  });
});
