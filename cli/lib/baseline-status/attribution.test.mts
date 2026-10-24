import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RUN_LIST_BY_COMMIT } from '../../__tests__/_baseline-fixture.mts';
import type { CheckRow } from '../ship/wait-ci/wait.mts';
import {
  attributeFailures,
  attributionToken,
  capped,
  classifyFile,
  compareSummaries,
  newFailingSteps,
  newUnhandled,
} from './attribution.mts';
import type { FileTests, TestReportSummary } from './produce.mts';

const summary = (
  files: Record<string, 'passed' | 'failed' | 'skipped'>,
  tests: Record<string, FileTests> = {},
  runId = 100,
): TestReportSummary => ({
  schema: 1,
  sha: 'merge-sha',
  runId,
  attempt: 1,
  testsPassed: !Object.values(files).includes('failed'),
  files,
  tests,
  unhandled: 0,
  droppedForeignPaths: 0,
});
const names = (failed: string[], passed: string[] = [], truncated?: true): FileTests =>
  truncated ? { failed, passed, truncated } : { failed, passed };

describe('classifyFile', () => {
  const pr = summary({ 'a.test.mts': 'failed' }, { 'a.test.mts': names(['x > broke']) });

  it('calls a file new when the base passed, skipped or never had it', () => {
    for (const base of [
      summary({ 'a.test.mts': 'passed' }),
      summary({ 'a.test.mts': 'skipped' }),
      summary({}),
    ])
      expect(classifyFile('a.test.mts', pr, base)).toBe('fresh');
  });

  it('calls a file inherited only when the base failed the same tests', () => {
    const base = summary({ 'a.test.mts': 'failed' }, { 'a.test.mts': names(['x > broke']) });
    expect(classifyFile('a.test.mts', pr, base)).toBe('inherited');
  });

  it('calls a file new when it fails a test the base did not fail', () => {
    const base = summary({ 'a.test.mts': 'failed' }, { 'a.test.mts': names(['x > other']) });
    expect(classifyFile('a.test.mts', pr, base)).toBe('fresh');
  });

  it('trusts a test the base PASSED even when its failed list is truncated', () => {
    const base = summary(
      { 'a.test.mts': 'failed' },
      { 'a.test.mts': names(['x > other'], ['x > broke'], true) },
    );
    expect(classifyFile('a.test.mts', pr, base)).toBe('fresh');
  });

  it('is unsure, never inherited, when either list is missing, truncated or empty', () => {
    const failed = { 'a.test.mts': 'failed' } as const;
    const cases: [TestReportSummary, TestReportSummary][] = [
      [pr, summary(failed)],
      [pr, summary(failed, { 'a.test.mts': names(['x > broke'], [], true) })],
      // An import error fails the file with no test names on the PR side.
      [
        summary(failed, { 'a.test.mts': names([]) }),
        summary(failed, { 'a.test.mts': names(['x > broke']) }),
      ],
      [pr, summary(failed, { 'a.test.mts': names([]) })],
    ];
    for (const [p, b] of cases) expect(classifyFile('a.test.mts', p, b)).toBe('unsure');
  });

  it('reads a file named like an Object member as data, not an inherited property', () => {
    const odd = summary({ toString: 'failed' }, { toString: names(['t']) });
    expect(classifyFile('toString', odd, summary({}))).toBe('fresh');
  });
});

describe('attributionToken', () => {
  const files = (fresh: string[], unsure: string[] = []) => ({ inherited: ['a'], fresh, unsure });

  it('claims inherited-only only when every failure is accounted for', () => {
    expect(attributionToken(files([]), [], [], 0)).toBe('inherited-only');
    expect(attributionToken(files(['b']), [], [], 0)).toBe('new');
    expect(attributionToken(files([], ['b']), [], [], 0)).toBe('unknown');
  });

  it('never claims inherited-only past a new failing step or an unread check', () => {
    // A PR that breaks typecheck on a base whose tests are red must not read as "not yours".
    expect(attributionToken(files([]), ['gate › Typecheck'], [], 0)).toBe('new');
    expect(attributionToken(files([]), [], ['CodeRabbit'], 0)).toBe('unknown');
  });

  it('reads an extra outside-test error as new, and an unrecorded count as unknown', () => {
    // vitest's json `success` ignores unhandled errors, so only this count can show one.
    expect(attributionToken(files([]), [], [], 1)).toBe('new');
    expect(attributionToken(files([]), [], [], null)).toBe('unknown');
    const base = summary({ 'a.test.mts': 'failed' });
    expect(newUnhandled({ ...base, unhandled: 2 }, { ...base, unhandled: 1 })).toBe(1);
    expect(newUnhandled({ ...base, unhandled: 0 }, { ...base, unhandled: 3 })).toBe(0);
    expect(newUnhandled(base, { ...base, unhandled: undefined })).toBeNull();
  });
});

/** One failed step of matrix shard `n`: siblings share a key, so a moved failure still matches. */
const shard = (n: number) => ({ label: `tests (${n}) › Tests`, key: 'shards › Tests' });
const plain = (label: string) => ({ label, key: label });

describe('newFailingSteps', () => {
  it('matches an inherited failure that moved to another shard', () => {
    expect(newFailingSteps([shard(3)], [shard(2)], 1)).toEqual([]);
  });

  it('calls a shard new when more shards fail than on the base', () => {
    expect(newFailingSteps([shard(2), shard(3)], [shard(2)], 1)).toEqual(['tests (3) › Tests']);
    expect(newFailingSteps([shard(3), shard(1)], [shard(2)], 1)).toEqual(['tests (1) › Tests']);
  });

  it('spends one inherited file per failing shard, so a fixed shard cannot hide a new one', () => {
    // Base fails shards 2 and 4; the PR fixes 4, keeps 2, and shard 1 fails with no new file.
    expect(newFailingSteps([shard(2), shard(1)], [shard(2), shard(4)], 1)).toEqual([
      'tests (1) › Tests',
    ]);
  });

  it('never matches a step outside a matrix by anything but its label', () => {
    const base = [plain('gate › Tests')];
    expect(newFailingSteps([plain('gate › Typecheck')], base, 5)).toEqual(['gate › Typecheck']);
    expect(newFailingSteps([plain('gate › Tests')], base, 0)).toEqual([]);
  });
});

describe('compareSummaries and capped', () => {
  it('buckets only the files the PR failed', () => {
    const pr = summary({ 'a.test.mts': 'failed', 'b.test.mts': 'failed', 'c.test.mts': 'passed' });
    const base = summary({ 'a.test.mts': 'failed', 'c.test.mts': 'failed' });
    expect(compareSummaries(pr, base)).toEqual({
      inherited: [],
      fresh: ['b.test.mts'],
      unsure: ['a.test.mts'],
    });
  });

  it('bounds a list and keeps every value on one line', () => {
    expect(capped([])).toBe('none');
    expect(capped(['a b', 'c\nd'])).toBe('a b,c d');
    expect(capped(['1', '2', '3', '4', '5', '6', '7'])).toBe('1,2,3,4,5,+2');
    expect(capped(['1', '2', '3', '4', '5'])).toBe('1,2,3,4,5');
  });
});

/** A gh stub answering the five calls attribution makes, from files under $DEVKIT_TEST_FIXTURE. */
const GH_STUB = `#!/bin/sh
F="$DEVKIT_TEST_FIXTURE"
if [ "$1" = "api" ]; then
  case "$2" in
    */actions/runs/*) cat "$F/run-\${2##*/}.tsv" 2>/dev/null && exit 0; echo "HTTP 404" >&2; exit 1 ;;
    */commits/*) echo base-sha; exit 0 ;;
  esac
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo main; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then cat "$F/checks.json"; exit 1; fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then cat "$F/view-$3.json"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  ${RUN_LIST_BY_COMMIT}
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  id="$3"; out=""
  while [ $# -gt 0 ]; do if [ "$1" = "--dir" ]; then out="$2"; fi; shift; done
  [ -f "$F/summary-$id.json" ] || { echo "no artifact matches any of the names" >&2; exit 1; }
  mkdir -p "$out/run-$id"; cp "$F/summary-$id.json" "$out/run-$id/summary.json"; exit 0
fi
exit 1
`;

const check = (name: string, link: string): CheckRow => ({
  bucket: 'fail',
  name,
  state: 'FAILURE',
  link,
  workflow: name,
});
const PR_CHECK = check('gate', 'https://github.com/o/r/actions/runs/200/job/1');
/** A run of four identical matrix shards, `failing` naming the shards whose Tests step failed. */
const shardsView = (...failing: number[]) =>
  JSON.stringify({
    url: 'https://x',
    jobs: [1, 2, 3, 4].map((n) => ({
      name: `tests (${n})`,
      conclusion: failing.includes(n) ? 'failure' : 'success',
      steps: [
        { name: 'Install', conclusion: 'success' },
        { name: 'Tests', conclusion: failing.includes(n) ? 'failure' : 'success' },
      ],
    })),
  });
const view = (...steps: string[]) =>
  JSON.stringify({
    url: 'https://x',
    jobs: [
      {
        name: 'gate',
        conclusion: 'failure',
        steps: steps.map((name) => ({ name, conclusion: 'failure' })),
      },
    ],
  });

describe('attributeFailures against a stubbed gh', () => {
  let cwd: string;
  let fixture: string;
  const put = (name: string, body: string) => writeFileSync(join(fixture, name), body);
  const baseRun = (over: Record<string, string> = {}) =>
    put(
      'runs.json',
      JSON.stringify([
        {
          databaseId: 100,
          attempt: 1,
          status: 'completed',
          conclusion: 'failure',
          headSha: 'base-sha',
          createdAt: '',
          headBranch: 'main',
          event: 'push',
          ...over,
        },
      ]),
    );
  const attribute = (failures = [PR_CHECK]) => {
    const env = { ...process.env };
    process.env.PATH = `${join(cwd, 'bin')}:${process.env.PATH}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    try {
      return attributeFailures({ cwd, pr: '7', failures });
    } finally {
      process.env.PATH = env.PATH;
      process.env.DEVKIT_TEST_FIXTURE = env.DEVKIT_TEST_FIXTURE;
    }
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'attr-'));
    fixture = mkdtempSync(join(tmpdir(), 'attr-fixture-'));
    mkdirSync(join(cwd, 'bin'));
    writeFileSync(join(cwd, 'bin', 'gh'), GH_STUB);
    chmodSync(join(cwd, 'bin', 'gh'), 0o755);
    put('run-200.tsv', '.github/workflows/gate.yml\t1\n');
    put('view-200.json', view('Tests'));
    put('view-100.json', view('Tests'));
    baseRun();
    const a = { 'a.test.mts': names(['x > broke']) };
    put('summary-100.json', JSON.stringify(summary({ 'a.test.mts': 'failed' }, a, 100)));
    const b = { ...a, 'b.test.mts': names(['y > new']) };
    put(
      'summary-200.json',
      JSON.stringify(summary({ 'a.test.mts': 'failed', 'b.test.mts': 'failed' }, b, 200)),
    );
  });

  it('names the new failure and counts the inherited one against the tested base', () => {
    expect(attribute()).toEqual({
      token: 'new',
      inherited: 1,
      fresh: 1,
      line: 'attribution=new inherited=1 new=1 new-failing=b.test.mts new-steps=none base-run=100 base-ci=red',
    });
  });

  it('reads inherited-only when the PR fails nothing the base did not', () => {
    const a = { 'a.test.mts': names(['x > broke']) };
    put('summary-200.json', JSON.stringify(summary({ 'a.test.mts': 'failed' }, a, 200)));
    expect(attribute().line).toMatch(/^attribution=inherited-only inherited=1 new=0 /);
  });

  it('calls a step the base did not fail new, even with only inherited tests', () => {
    const a = { 'a.test.mts': names(['x > broke']) };
    put('summary-200.json', JSON.stringify(summary({ 'a.test.mts': 'failed' }, a, 200)));
    put('view-200.json', view('Typecheck', 'Tests'));
    expect(attribute().line).toContain(
      'attribution=new inherited=1 new=0 new-failing=none new-steps=gate › Typecheck',
    );
  });

  it('reads an inherited file that hashed into another shard as inherited-only', () => {
    const a = { 'a.test.mts': names(['x > broke']) };
    put('summary-200.json', JSON.stringify(summary({ 'a.test.mts': 'failed' }, a, 200)));
    put('view-100.json', shardsView(2));
    put('view-200.json', shardsView(3));
    expect(attribute().line).toMatch(/^attribution=inherited-only inherited=1 new=0 /);
  });

  it('calls an outside-test error new even when a moved shard explains every failing step', () => {
    // Base fails shards 1 and 2 on two files; the PR runs both in shard 1, and shard 3 errors.
    const both = { 'a.test.mts': names(['x > broke']), 'b.test.mts': names(['y > broke']) };
    const failed = { 'a.test.mts': 'failed', 'b.test.mts': 'failed' } as const;
    put('summary-100.json', JSON.stringify(summary(failed, both, 100)));
    put('summary-200.json', JSON.stringify({ ...summary(failed, both, 200), unhandled: 1 }));
    put('view-100.json', shardsView(1, 2));
    put('view-200.json', shardsView(1, 3));
    expect(attribute().line).toContain('attribution=new inherited=2 new=0 ');
    expect(attribute().line).toContain('new-steps=none unhandled=+1 ');
  });

  it('never treats a shard that failed before any step ran as a moved shard', () => {
    // A runner that never started reports the job with no steps, so no sibling signature matches it.
    const a = { 'a.test.mts': names(['x > broke']) };
    put('summary-200.json', JSON.stringify(summary({ 'a.test.mts': 'failed' }, a, 200)));
    put('view-100.json', shardsView(2));
    const view = JSON.parse(shardsView(2));
    view.jobs[2] = { name: 'tests (3)', conclusion: 'failure', steps: [] };
    put('view-200.json', JSON.stringify(view));
    expect(attribute().line).toContain('attribution=new inherited=1 new=0 ');
    expect(attribute().line).toContain('new-steps=tests (3) ');
  });

  it('reads a summary without an outside-test error count as unknown, never inherited', () => {
    const { unhandled: _, ...unrecorded } = summary({ 'a.test.mts': 'failed' }, {}, 200);
    put('summary-200.json', JSON.stringify(unrecorded));
    expect(attribute().line).toContain(' unhandled=unrecorded ');
  });

  it('leaves a failing check from outside the workflow unattributed, never inherited', () => {
    const line = attribute([PR_CHECK, check('CodeRabbit', '')]).line;
    expect(line).toContain('unattributed=CodeRabbit');
  });

  it('attributes every job of the workflow run, skipping another workflow listed first', () => {
    // gate.yml's `required` job fails beside `gate` on every red run; it is the same run, not a stray.
    const a = { 'a.test.mts': names(['x > broke']) };
    put('summary-200.json', JSON.stringify(summary({ 'a.test.mts': 'failed' }, a, 200)));
    put('run-300.tsv', '.github/workflows/lint.yml\t1\n');
    const lint = check('lint', 'https://github.com/o/r/actions/runs/300/job/9');
    const required = check('required', 'https://github.com/o/r/actions/runs/200/job/2');
    const line = attribute([lint, PR_CHECK, required]).line;
    expect(line).toMatch(/^attribution=unknown inherited=1 new=0 /);
    expect(line).toContain(' unattributed=lint base-run=100');
  });

  it("reads the consumer's configured workflow, not devkit's gate.yml", () => {
    writeFileSync(join(cwd, 'guard.config.json'), '{"baselineStatus":{"workflow":"ci.yml"}}');
    execFileSync('git', ['init', '-q'], { cwd });
    expect(attribute().line).toBe('attribution=unknown reason=no-workflow-run');
    put('run-200.tsv', '.github/workflows/ci.yml\t1\n');
    expect(attribute().line).toMatch(/^attribution=new inherited=1 new=1 /);
  });

  it('names every input it cannot read instead of guessing', () => {
    baseRun({ status: 'in_progress', conclusion: '' });
    expect(attribute().line).toBe('attribution=unknown reason=base-pending');
    baseRun();
    rmSync(join(fixture, 'summary-100.json'));
    expect(attribute().line).toBe(
      'attribution=unknown reason=no-artifact base-run=100 base-ci=red',
    );
    put('run-200.tsv', '.github/workflows/other.yml\t1\n');
    expect(attribute().line).toBe('attribution=unknown reason=no-workflow-run');
  });

  it('keeps the verdict line when attribution itself cannot load its config', () => {
    // A corrupt guard.config.json throws inside attribution; the wait still prints its verdict.
    writeFileSync(join(cwd, 'guard.config.json'), '{ not json');
    put('checks.json', JSON.stringify([PR_CHECK]));
    execFileSync('git', ['init', '-q'], { cwd });
    const out = execFileSync(
      'sh',
      [
        '-c',
        `node "${join(import.meta.dirname, '../ship/wait-ci/wait.mts')}" --pr 7 --repo o/r --timeout 60 2>&1`,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
          DEVKIT_TEST_FIXTURE: fixture,
          DEVKIT_WAIT_CI_INTERVAL_MS: '5',
          DEVKIT_WAIT_CI_SETTLE_MS: '1',
        },
      },
    );
    expect(out).toContain('ship: ci-outcome=failed pr=7 failing=gate:');
    expect(out).toContain('attribution=unknown reason=attribution-error');
  });
});
