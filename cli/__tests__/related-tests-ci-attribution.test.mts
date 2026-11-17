import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_REASON_ENV, readGateReason } from '../../gate-engine/deterministic/reason.mts';
import type { Comparison } from '../lib/baseline-status/compare.mts';
import type { BaselineAnswer } from '../lib/baseline-status/query.mts';
import {
  attributeToCi,
  ciBase,
  ciLines,
  runRelatedTests,
} from '../lib/husky/gate-policy/related-tests.mts';

const dirs: string[] = [];
beforeEach(() => vi.stubEnv(GATE_REASON_ENV, ''));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, 'add', file);
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A repo whose origin/main is its first commit and whose HEAD is one commit past it. */
function branchedRepo() {
  const repo = tempDir('related-ci-repo-');
  git(repo, 'init', '-q');
  const base = commit(repo, 'a.mts');
  git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  commit(repo, 'b.mts');
  return { repo, base };
}

function reasonFile(): string {
  const file = join(tempDir('related-ci-reason-'), 'reason.txt');
  vi.stubEnv(GATE_REASON_ENV, file);
  return file;
}

const failing = (file: string, ...titles: string[]) => ({
  name: file,
  status: 'failed',
  assertionResults: titles.map((title) => ({
    status: 'failed',
    title,
    ancestorTitles: ['d'],
    fullName: `d ${title}`,
    failureMessages: ['x'],
  })),
});

const reportPath = (args: string[]) =>
  args.find((a) => a.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);

/** A vitest run that exits `code` after writing `testResults` where the gate asked for its report. */
function reportingExec(code: number, testResults: unknown[]) {
  return vi.fn(async (_bin: string, args: string[]) => {
    const out = reportPath(args);
    if (out) writeFileSync(out, JSON.stringify({ success: code === 0, testResults }));
    return { code, interrupted: false };
  });
}

function answer(over: Partial<BaselineAnswer> = {}): BaselineAnswer {
  return {
    runStatus: 'red',
    testsStatus: 'red',
    ref: 'main',
    runId: 42,
    attempt: 1,
    sha: '96f4d96b8de965a6',
    failingFiles: [],
    head: '96f4d96b8de965a6',
    commitsBehindHead: 0,
    commitsWithoutRun: [],
    skippedRuns: [],
    ...over,
  };
}

const entries = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ file: `cli/${prefix}${i}.test.mts`, test: 'd t' }));

function comparison(inherited: number, fresh: number): Comparison {
  return {
    inherited: entries(inherited, 'old'),
    fresh: entries(fresh, 'new'),
    fixed: [],
    namesKnown: true,
  };
}

describe('ciLines', () => {
  it('names the answering run, the inherited failures, and ci-probe for the new ones', () => {
    expect(ciLines({ answer: answer(), comparison: comparison(1, 1) })).toEqual([
      'CI at 96f4d96b (main, run 42): 1 inherited, 1 new',
      'inherited · cli/old0.test.mts > d t',
      'to run this change in CI instead of on this machine: devkit ci-probe',
    ]);
  });

  it('adds no ci-probe line when every failure is inherited', () => {
    expect(ciLines({ answer: answer(), comparison: comparison(2, 0) })).toEqual([
      'CI at 96f4d96b (main, run 42): 2 inherited, 0 new',
      'inherited · cli/old0.test.mts > d t',
      'inherited · cli/old1.test.mts > d t',
    ]);
  });

  it('says how far before the base the answering run is', () => {
    const lines = ciLines({
      answer: answer({ commitsBehindHead: 2 }),
      comparison: comparison(1, 0),
    });
    expect(lines[0]).toBe(
      'CI at 96f4d96b (main, run 42, 2 commit(s) before the base): 1 inherited, 0 new',
    );
  });

  it('names three inherited failures and counts the rest', () => {
    const lines = ciLines({ answer: answer(), comparison: comparison(8, 4) });
    expect(lines).toHaveLength(6);
    expect(lines[4]).toBe('(+5 more inherited in the log above)');
  });
});

describe('ciBase', () => {
  it('is where HEAD left origin/main', () => {
    const { repo, base } = branchedRepo();
    expect(ciBase(repo)).toBe(base);
  });

  it("is '' when there is no origin ref to measure from", () => {
    const repo = tempDir('related-ci-bare-');
    git(repo, 'init', '-q');
    commit(repo, 'a.mts');
    expect(ciBase(repo)).toBe('');
  });
});

describe('runRelatedTests CI attribution', () => {
  const list = async () => [];
  const silence = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('asks baseline-status about the base with the run summary, and appends its lines', async () => {
    silence();
    const file = reasonFile();
    const { repo, base } = branchedRepo();
    let summary: unknown;
    const attribute = vi.fn(async (argv: string[]) => {
      summary = JSON.parse(readFileSync(argv[argv.indexOf('--against') + 1], 'utf8'));
      return { answer: answer(), comparison: comparison(1, 1) };
    });
    const exec = reportingExec(1, [failing(join(repo, 'cli/a.test.mts'), 't')]);
    const run = await runRelatedTests(repo, { staged: ['a.mts'], list, exec, attribute });

    expect(run.code).toBe(1);
    const argv = attribute.mock.calls[0][0];
    expect(argv.slice(2, 5)).toEqual(['baseline-status', '--at', base]);
    expect(argv.at(-1)).toBe('--json');
    expect(summary).toMatchObject({ files: { 'cli/a.test.mts': 'failed' } });
    expect(readGateReason(file)).toEqual([
      '1 test file(s) failed:',
      'cli/a.test.mts > d t',
      'CI at 96f4d96b (main, run 42): 1 inherited, 1 new',
      'inherited · cli/old0.test.mts > d t',
      'to run this change in CI instead of on this machine: devkit ci-probe',
    ]);
  });

  it('keeps the reason as it was when CI cannot answer', async () => {
    silence();
    const file = reasonFile();
    const { repo } = branchedRepo();
    const exec = reportingExec(1, [failing(join(repo, 'cli/a.test.mts'), 't')]);
    const attribute = vi.fn(async () => null);
    await runRelatedTests(repo, { staged: ['a.mts'], list, exec, attribute });
    expect(attribute).toHaveBeenCalledOnce();
    expect(readGateReason(file)).toEqual(['1 test file(s) failed:', 'cli/a.test.mts > d t']);
  });

  it('keeps the reason as it was when the lookup throws', async () => {
    silence();
    const file = reasonFile();
    const { repo } = branchedRepo();
    const exec = reportingExec(1, [failing(join(repo, 'cli/a.test.mts'), 't')]);
    const attribute = vi.fn(async () => {
      throw new Error('boom');
    });
    expect((await runRelatedTests(repo, { staged: ['a.mts'], list, exec, attribute })).code).toBe(
      1,
    );
    expect(readGateReason(file)).toEqual(['1 test file(s) failed:', 'cli/a.test.mts > d t']);
  });

  it('keeps every line within the reason cap with many failures', async () => {
    silence();
    const file = reasonFile();
    const { repo } = branchedRepo();
    const results = Array.from({ length: 12 }, (_, i) =>
      failing(join(repo, `cli/f${i}.test.mts`), 't'),
    );
    const attribute = vi.fn(async () => ({ answer: answer(), comparison: comparison(8, 4) }));
    await runRelatedTests(repo, {
      staged: ['a.mts'],
      list,
      exec: reportingExec(1, results),
      attribute,
    });
    const reason = readGateReason(file);
    expect(reason.length).toBeLessThanOrEqual(20);
    expect(reason).toContain('(7 more in the full log above)');
    expect(reason).toContain('(+5 more inherited in the log above)');
  });

  it('never asks without an origin base, a test failure, or a finished run', async () => {
    silence();
    reasonFile();
    const attribute = vi.fn(async () => null);
    const bare = tempDir('related-ci-bare-');
    git(bare, 'init', '-q');
    commit(bare, 'a.mts');
    const fail = (root: string) => reportingExec(1, [failing(join(root, 'cli/a.test.mts'), 't')]);
    await runRelatedTests(bare, { staged: ['a.mts'], list, exec: fail(bare), attribute });

    const { repo } = branchedRepo();
    const opts = { staged: ['a.mts'], list, attribute };
    await runRelatedTests(repo, { ...opts, exec: reportingExec(0, []) });
    // exit 1 with no failing test: the unhandled-error path.
    await runRelatedTests(repo, { ...opts, exec: reportingExec(1, []) });
    const killed = vi.fn(async (_b: string, args: string[]) => {
      await fail(repo)(_b, args);
      return { code: 1, interrupted: true };
    });
    await runRelatedTests(repo, { ...opts, exec: killed });
    expect(attribute).not.toHaveBeenCalled();
  });

  // The runner's deadline replaces the reason with a timeout block, so a late lookup would hide the failure.
  it('skips the lookup when the gate deadline leaves no room, and bounds it otherwise', async () => {
    silence();
    const file = reasonFile();
    const { repo } = branchedRepo();
    const exec = () => reportingExec(1, [failing(join(repo, 'cli/a.test.mts'), 't')]);
    const attribute = vi.fn(async () => ({ answer: answer(), comparison: comparison(1, 0) }));
    vi.stubEnv('GUARD_GATE_TIMEOUT_MS', '1');
    await runRelatedTests(repo, { staged: ['a.mts'], list, exec: exec(), attribute });
    expect(attribute).not.toHaveBeenCalled();
    expect(readGateReason(file)).toEqual(['1 test file(s) failed:', 'cli/a.test.mts > d t']);

    vi.stubEnv('GUARD_GATE_TIMEOUT_MS', String(60 * 60_000));
    await runRelatedTests(repo, { staged: ['a.mts'], list, exec: exec(), attribute });
    expect(attribute.mock.calls[0][3]).toBe(25_000);
  });

  // A summary that dropped every failing path would otherwise print "0 inherited, 0 new" under a red run.
  it('adds nothing when the comparison holds none of the failures', async () => {
    silence();
    const file = reasonFile();
    const { repo } = branchedRepo();
    const exec = reportingExec(1, [failing(join(repo, 'cli/a.test.mts'), 't')]);
    const attribute = vi.fn(async () => ({ answer: answer(), comparison: comparison(0, 0) }));
    await runRelatedTests(repo, { staged: ['a.mts'], list, exec, attribute });
    expect(readGateReason(file)).toEqual(['1 test file(s) failed:', 'cli/a.test.mts > d t']);
  });
});

describe('attributeToCi', () => {
  const node = (script: string) => [process.execPath, '-e', script];
  const env = process.env;

  it('reads the comparison baseline-status printed', async () => {
    const printed = JSON.stringify({ ...answer(), comparison: comparison(1, 0) });
    const found = await attributeToCi(
      node(`process.stdout.write(${JSON.stringify(printed)})`),
      '.',
      env,
    );
    expect(found?.answer.runId).toBe(42);
    expect(found?.comparison.inherited).toHaveLength(1);
  });

  it.each([
    ['an unknown answer', `process.stdout.write(JSON.stringify({reason:'no-usable-run'}))`],
    ['a non-zero exit', `process.stdout.write(JSON.stringify({comparison:{}})); process.exit(2)`],
    ['output that is not json', `process.stdout.write('❔ no readable run summary')`],
  ])('is null for %s', async (_, script) => {
    expect(await attributeToCi(node(script), '.', env)).toBeNull();
  });

  it('is null when the command cannot start', async () => {
    expect(await attributeToCi(['/nonexistent/devkit-node'], '.', env)).toBeNull();
  });

  it('kills a lookup that outlives its deadline and answers null', async () => {
    const dir = tempDir('related-ci-hang-');
    const pidFile = join(dir, 'pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    expect(await attributeToCi(node(script), '.', env, 1500)).toBeNull();
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  });
});
