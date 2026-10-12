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
    expect(attributionToken(files([]), [], [])).toBe('inherited-only');
    expect(attributionToken(files(['b']), [], [])).toBe('new');
    expect(attributionToken(files([], ['b']), [], [])).toBe('unknown');
  });

  it('never claims inherited-only past a new failing step or an unread check', () => {
    // A PR that breaks typecheck on a base whose tests are red must not read as "not yours".
    expect(attributionToken(files([]), ['gate › Typecheck'], [])).toBe('new');
    expect(attributionToken(files([]), [], ['CodeRabbit'])).toBe('unknown');
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
