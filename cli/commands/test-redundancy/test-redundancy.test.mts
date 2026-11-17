/** `devkit test-redundancy` against real git repos, with fallow replaced by its recorded answer. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupRepos,
  git,
  repo,
  write,
} from '../../../gate-engine/coverage/__tests__/_provenance-fixtures.mts';
import type { KillMatrixReport } from './report.mts';
import testRedundancy, { type Deps } from './test-redundancy.mts';

const saved = new Map<string, string | undefined>();
beforeEach(() => {
  // A host-set base would silently redirect the default base below; the command sets the run id.
  for (const key of ['DEVKIT_BASE_REF', 'DEVKIT_AGENT_RUN_ID']) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupRepos();
  vi.restoreAllMocks();
});

const ADDS = 'src/a.test.mts::adds';
const ADDS_AGAIN = 'src/a.test.mts::adds again';
const answer: KillMatrixReport = {
  elapsed_ms: 2000,
  summary: { counts: { total: 7, pending: 0 } },
  kill_matrix: {
    candidates: [ADDS_AGAIN],
    coverage_without_kills: [],
    targets: [
      { target: 'src/a.test.mts', status: 'complete', reasons: [], test_ids: [ADDS, ADDS_AGAIN] },
    ],
  },
};

function fallow(version: string | null, stdout = JSON.stringify(answer)) {
  const runFallow = vi.fn<Deps['runFallow']>(() => ({ status: 0, stdout }));
  const deps: Deps = { detect: () => ({ available: version !== null, version }), runFallow };
  return { deps, runFallow };
}

function run(cwd: string, deps: Deps, ...args: string[]) {
  const lines: string[] = [];
  const capture = (...a: unknown[]) => {
    lines.push(a.join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  const code = testRedundancy(args, cwd, deps);
  vi.restoreAllMocks();
  return { code, out: lines.join('\n') };
}

/** repo() whose base holds the test "adds", with an origin/main ref and a feature branch cut from it. */
function featureRepo(pkg = '') {
  const r = repo(pkg);
  write(r.cwd, 'src/a.test.mts', 'test("adds", () => {});\n');
  git(r.root, 'commit', '-q', '-am', 'base test');
  git(r.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(r.root, 'switch', '-q', '-c', 'feature');
  return r;
}

/** The run's telemetry row, as written to the sink vitest.setup.mjs points at a temp file. */
function lastRow(): string {
  const rows = readFileSync(process.env.DEVKIT_GATE_EVENTS ?? '', 'utf8')
    .trim()
    .split('\n');
  return rows.findLast((r) => r.includes('"type":"test_redundancy_run"')) ?? '';
}

const addTest = (root: string) =>
  write(root, 'src/a.test.mts', 'test("adds", () => {});\ntest("adds again", () => {});\n');

describe('devkit test-redundancy', () => {
  it('asks fallow about the changed test file and lists what it flags', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    addTest(root);
    const { deps, runFallow } = fallow('3.41.0');
    let runIdSeenByFallow: string | undefined = 'unread';
    runFallow.mockImplementation(() => {
      runIdSeenByFallow = process.env.DEVKIT_AGENT_RUN_ID;
      return { status: 0, stdout: JSON.stringify(answer) };
    });

    const { code, out } = run(root, deps);

    expect(code).toBe(0);
    expect(runIdSeenByFallow).toBeUndefined();
    const row = lastRow();
    expect(row).not.toContain('src/');
    expect(JSON.parse(row)).toMatchObject({
      outcome: 'judged',
      run_mode: 'agent',
      fallow_version: '3.41.0',
      head: git(root, 'rev-parse', 'HEAD'),
      dirty: true,
      mutants_total: 7,
      mutants_ran: 7,
      redundant: 1,
      kills_nothing: 0,
      changed_uncaught: 0,
      wall_ms: expect.any(Number),
    });
    expect(runFallow.mock.calls[0][0]).toEqual([
      'mutation',
      'src/a.mts',
      '--kill-matrix-for',
      'src/a.test.mts',
      '--allow-dirty',
      '--time-budget',
      '4m',
      '--setup-timeout',
      '4m',
      '--format',
      'json',
      '--quiet',
    ]);
    expect(out).toContain(`redundant      ${ADDS_AGAIN}`);
  });

  it('says nothing to judge, without running fallow, when no test file changed', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    const { deps, runFallow } = fallow('3.41.0');

    expect(run(root, deps).out).toContain('nothing to judge');
    expect(runFallow).not.toHaveBeenCalled();
    expect(JSON.parse(lastRow())).toMatchObject({ outcome: 'no_test_change' });
  });

  it('is not judged on a fallow older than the kill matrix, naming the version it needs', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    addTest(root);
    const { deps, runFallow } = fallow('3.35.0');

    const { code, out } = run(root, deps);

    expect(code).toBe(0);
    expect(out).toContain('Not judged: fallow 3.35.0 has no --kill-matrix-for; it needs 3.40.0');
    expect(out).toContain('bun add -g fallow@3.42.0');
    expect(runFallow).not.toHaveBeenCalled();
    expect(JSON.parse(lastRow())).toMatchObject({
      outcome: 'fallow_too_old',
      fallow_version: '3.35.0',
    });
  });

  const otherTarget = { target: 'src/b.test.mts', status: 'incomplete', test_ids: [] };
  it.each([
    ['mutants left pending', { ...answer, summary: { counts: { total: 7, pending: 2 } } }, false],
    ['pending not reported', { ...answer, summary: { counts: { total: 7 } } }, false],
    ['total not reported', { ...answer, summary: { counts: { pending: 0 } } }, false],
    [
      'another target unjudged',
      {
        ...answer,
        kill_matrix: {
          ...answer.kill_matrix,
          targets: [...(answer.kill_matrix?.targets ?? []), otherTarget],
        },
      },
      false,
    ],
    ['a changed test file fallow did not list', answer, true],
  ])('records a run with one complete target as partial, not judged: %s', (_, report, twoFiles) => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    addTest(root);
    if (twoFiles) write(root, 'src/b.test.mts', 'test("b", () => {});\n');

    run(root, fallow('3.41.0', JSON.stringify(report)).deps);

    expect(JSON.parse(lastRow())).toMatchObject({ outcome: 'partial', redundant: 1 });
  });

  it('records no complete target with the mutant counts fallow did not report left out', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    addTest(root);
    const noneComplete: KillMatrixReport = {
      kill_matrix: {
        targets: [{ target: 'src/a.test.mts', status: 'incomplete', test_ids: [ADDS] }],
      },
    };

    run(root, fallow('3.41.0', JSON.stringify(noneComplete)).deps);

    const row = JSON.parse(lastRow());
    expect(row.outcome).toBe('no_target_complete');
    for (const field of ['mutants_total', 'mutants_ran', 'redundant', 'kills_nothing']) {
      expect(row).not.toHaveProperty(field);
    }
  });

  it('records a complete target with no tests as judged, not as no complete target', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    addTest(root);
    const noTests: KillMatrixReport = {
      ...answer,
      kill_matrix: { targets: [{ target: 'src/a.test.mts', status: 'complete', test_ids: [] }] },
    };

    run(root, fallow('3.41.0', JSON.stringify(noTests)).deps);

    expect(JSON.parse(lastRow())).toMatchObject({
      outcome: 'judged',
      redundant: 0,
      kills_nothing: 0,
    });
  });

  it('needs the source named for a test-only change, then mutates what it is given', () => {
    const { root } = featureRepo();
    addTest(root);
    const { deps, runFallow } = fallow('3.41.0');

    expect(run(root, deps).out).toContain('Not judged: the change touches no production source');
    expect(runFallow).not.toHaveBeenCalled();

    run(root, deps, '--', 'src/a.mts');
    expect(runFallow.mock.calls[0][0].slice(0, 2)).toEqual(['mutation', 'src/a.mts']);
  });

  it('is not judged when fallow refuses to run or prints no report, quoting its reason', () => {
    const { root } = featureRepo();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    addTest(root);
    const refusal = JSON.stringify({ error: true, message: 'vitest is not installed' });

    const { code, out } = run(root, fallow('3.41.0', refusal).deps);

    expect(code).toBe(0);
    expect(out).toContain('Not judged: fallow could not run: vitest is not installed');
    expect(JSON.parse(lastRow())).toMatchObject({
      outcome: 'not_judged',
      fallow_version: '3.41.0',
    });
    for (const noReport of ['null', 'not json']) {
      expect(run(root, fallow('3.41.0', noReport).deps).out).toContain(
        'Not judged: fallow printed no report (exit 0).',
      );
    }
  });

  it('never fails the run: a wrong argument or an unresolvable base says why nothing was judged', () => {
    const { root } = featureRepo();
    addTest(root);
    const { deps, runFallow } = fallow('3.41.0');

    const typo = run(root, deps, '--time-budjet', '1m');
    expect(typo.code).toBe(0);
    expect(typo.out).toContain('Not judged: unknown or incomplete argument: --time-budjet');

    const noBase = run(root, deps, '--base', 'no-such-ref');
    expect(noBase.code).toBe(0);
    expect(noBase.out).toContain('Not judged: cannot resolve --base no-such-ref to a commit.');
    expect(runFallow).not.toHaveBeenCalled();
  });

  it('lists uncaught planted bugs on changed lines even when no test could be judged', () => {
    const { root, cwd } = featureRepo('pkg');
    write(cwd, 'src/a.mts', 'export const a = 2;\n');
    addTest(cwd);
    const cutShort: KillMatrixReport = {
      summary: { counts: { total: 3, pending: 1 } },
      mutants: [
        {
          file: 'src/a.mts',
          line: 1,
          status: 'survived',
          operator: 'x',
          change: { from: '2', to: '0' },
        },
        { file: 'src/a.mts', line: 1, status: 'pending' },
        { file: 'src/a.mts', line: 7, status: 'survived' },
      ],
      kill_matrix: {
        targets: [
          { target: 'src/a.test.mts', status: 'incomplete', reasons: ['partial-mutation-run'] },
        ],
      },
    };

    const { out } = run(cwd, fallow('3.41.0', JSON.stringify(cutShort)).deps);

    expect(root).not.toBe(cwd);
    expect(out).toContain('not caught     src/a.mts:1  x: 2 → 0');
    expect(out).not.toContain('src/a.mts:7');
    expect(out).toContain('changed lines  1 not caught of 1 planted bugs that ran (2 planned)');
    expect(out).toContain('1 did not run before the time budget');
    expect(out).toContain('not judged     src/a.test.mts (0 tests): partial-mutation-run');
  });
});
