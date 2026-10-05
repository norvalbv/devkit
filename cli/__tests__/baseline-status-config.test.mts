/**
 * sc-3445 — `devkit baseline-status` in a consumer that has no `gate.yml`: the missing workflow is
 * named, the workflow/artifact are configurable, and a remedy appears only where CI is the gap.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineStatus from '../commands/baseline/status.mts';
import type { RunRef } from '../lib/baseline-status/gh.mts';
import { workflowSelector } from '../lib/baseline-status/query.mts';
import { configuredSource } from '../lib/baseline-status/source.mts';
import { API_BRANCH_HEAD, RUN_LIST_BY_COMMIT, seedBranch } from './_baseline-fixture.mts';

/** gh stub: `list-stderr` makes `run list` fail with that text; argv is appended to `argv.log`. */
const GH_STUB = `#!/bin/sh
echo "$*" >> "$DEVKIT_TEST_FIXTURE/argv.log"
${API_BRANCH_HEAD}
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  if [ -f "$DEVKIT_TEST_FIXTURE/list-stderr" ]; then cat "$DEVKIT_TEST_FIXTURE/list-stderr" >&2; exit 1; fi
  ${RUN_LIST_BY_COMMIT}
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  id="$3"; out=""
  while [ $# -gt 0 ]; do if [ "$1" = "--dir" ]; then out="$2"; fi; shift; done
  if [ -f "$DEVKIT_TEST_FIXTURE/summary-$id.json" ]; then
    mkdir -p "$out/run-$id"; cp "$DEVKIT_TEST_FIXTURE/summary-$id.json" "$out/run-$id/summary.json"; exit 0
  fi
  echo "no artifact matches any of the names or patterns provided" >&2; exit 1
fi
exit 1
`;

describe('baseline-status workflow source (sc-3445)', () => {
  let repo: string;
  let fixture: string;
  let head: string;
  let out: string[];
  const saved = { PATH: process.env.PATH, fixture: process.env.DEVKIT_TEST_FIXTURE };

  const run = (over: Partial<RunRef> = {}) => ({
    databaseId: 100,
    attempt: 1,
    status: 'completed',
    conclusion: 'failure',
    headSha: head,
    createdAt: '2026-09-28T00:00:00Z',
    headBranch: 'main',
    event: 'push',
    ...over,
  });
  const withRuns = (runs: unknown[]) =>
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify(runs));
  const withSummary = (runId = 100) =>
    writeFileSync(
      join(fixture, `summary-${runId}.json`),
      JSON.stringify({
        schema: 1,
        sha: 'sha1',
        runId,
        attempt: 1,
        testsPassed: false,
        files: { 'a.test.mts': 'failed' },
        droppedForeignPaths: 0,
      }),
    );
  const listFails = (stderr: string) => writeFileSync(join(fixture, 'list-stderr'), stderr);
  const argv = () => readFileSync(join(fixture, 'argv.log'), 'utf8');
  const configRaw = (dir: string, text: string) =>
    writeFileSync(join(dir, 'guard.config.json'), text);
  const config = (dir: string, body: { baselineStatus: Record<string, string | number> }) =>
    configRaw(dir, JSON.stringify(body));
  const text = () => out.join('\n');
  const json = () => JSON.parse(text());

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'baseline-cfg-repo-'));
    head = seedBranch(repo);
    fixture = mkdtempSync(join(tmpdir(), 'baseline-cfg-fixture-'));
    const bin = join(fixture, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), GH_STUB);
    chmodSync(join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = saved.PATH;
    if (saved.fixture === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fixture;
    rmSync(repo, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  describe('a missing workflow is named, not a generic gh-failed', () => {
    it("names gh's filename-selector 404 as workflow-missing, exits 2 and says how to fix it", () => {
      listFails(
        'HTTP 404: workflow gate.yml not found on the default branch ' +
          '(https://api.github.com/repos/benord-labs/frink/actions/workflows/gate.yml)\n',
      );
      expect(baselineStatus(['--json'], repo)).toBe(2);
      const answer = json();
      expect(answer.reason).toBe('workflow-missing');
      expect(answer.remedy).toContain('No workflow `gate.yml` exists on the default branch');
      expect(answer.remedy).toContain('devkit test-report-run');
      expect(answer.remedy).toContain('--workflow');
    });

    it("names gh's name-selector wording as workflow-missing too", () => {
      listFails('could not find any workflows named Test Suite\n');
      expect(baselineStatus(['--json', '--workflow', 'Test Suite'], repo)).toBe(2);
      expect(json().reason).toBe('workflow-missing');
    });

    it.each([
      'authentication',
      'not logged',
      'gh auth login',
      'no git remotes',
      'could not determine',
    ])(
      'names a missing workflow called %j as workflow-missing, not as the auth/remote it echoes',
      (name) => {
        listFails(`could not find any workflows named ${name}\n`);
        expect(baselineStatus(['--json', '--workflow', name], repo)).toBe(2);
        expect(json().reason).toBe('workflow-missing');
      },
    );

    it('still reports a real auth failure as gh-unauthenticated', () => {
      listFails('To get started with GitHub CLI, please run:  gh auth login\n');
      expect(baselineStatus(['--json'], repo)).toBe(2);
      expect(json().reason).toBe('gh-unauthenticated');
    });

    it('keeps a bare 404 (an inaccessible repo) as gh-failed with no workflow remedy', () => {
      listFails('HTTP 404: Not Found (https://api.github.com/repos/acme/private/actions/runs)\n');
      expect(baselineStatus(['--json'], repo)).toBe(2);
      const answer = json();
      expect(answer.reason).toBe('gh-failed');
      expect(answer.remedy).toBeUndefined();
    });

    it('prints the remedy in the human rendering as well as in --json', () => {
      listFails('HTTP 404: workflow gate.yml not found on the default branch\n');
      baselineStatus([], repo);
      expect(text()).toMatch(/workflow-missing[\s\S]*→ No workflow `gate\.yml`/);
    });
  });

  describe('which workflow and artifact are queried', () => {
    beforeEach(() => {
      withRuns([run()]);
      withSummary();
    });

    it('defaults to gate.yml and test-report-summary when nothing is configured', () => {
      expect(baselineStatus(['--json'], repo)).toBe(0);
      expect(argv()).toMatch(/run list --workflow gate\.yml /);
      expect(argv()).toMatch(/--name test-report-summary /);
    });

    it('reads workflow and artifact from guard.config.json', () => {
      config(repo, { baselineStatus: { workflow: 'test-suite.yml', artifact: 'per-file' } });
      withSummary(); // the stub serves by run id, whatever the artifact name
      baselineStatus(['--json'], repo);
      expect(argv()).toMatch(/--workflow test-suite\.yml /);
      expect(argv()).toMatch(/--name per-file /);
    });

    it('lets --workflow beat the configured workflow while keeping the configured artifact', () => {
      config(repo, { baselineStatus: { workflow: 'test-suite.yml', artifact: 'per-file' } });
      baselineStatus(['--json', '--workflow', 'nightly.yml'], repo);
      expect(argv()).toMatch(/--workflow nightly\.yml /);
      expect(argv()).not.toMatch(/test-suite\.yml/);
      expect(argv()).toMatch(/--name per-file /);
    });

    it('turns a path-shaped workflow — flag or config — into the filename gh accepts', () => {
      baselineStatus(['--json', '--workflow', '.github/workflows/test-suite.yml'], repo);
      config(repo, { baselineStatus: { workflow: '.github\\workflows\\ci.yml' } });
      baselineStatus(['--json'], repo);
      const lists = argv()
        .split('\n')
        .filter((l) => l.startsWith('run list'));
      expect(lists[0]).toMatch(/--workflow test-suite\.yml /);
      expect(lists[1]).toMatch(/--workflow ci\.yml /);
    });

    it('finds the root guard.config.json from a subdirectory, and prefers a nearer package one', () => {
      config(repo, { baselineStatus: { workflow: 'root.yml' } });
      const pkg = join(repo, 'packages', 'app');
      const deep = join(pkg, 'src');
      mkdirSync(deep, { recursive: true });
      baselineStatus(['--json'], deep);
      expect(argv()).toMatch(/--workflow root\.yml /);

      config(pkg, { baselineStatus: { workflow: 'app.yml' } });
      baselineStatus(['--json'], deep);
      const lists = argv()
        .split('\n')
        .filter((l) => l.startsWith('run list'));
      expect(lists.at(-1)).toMatch(/--workflow app\.yml /);
    });

    it('falls back to the default for an empty or non-string configured workflow', () => {
      config(repo, { baselineStatus: { workflow: '   ', artifact: 42 } });
      baselineStatus(['--json'], repo);
      expect(argv()).toMatch(/--workflow gate\.yml /);
      expect(argv()).toMatch(/--name test-report-summary /);
    });

    it("never serves one artifact's cached summary when another artifact is configured", () => {
      baselineStatus(['--json'], repo); // caches run 100 under the default artifact
      config(repo, { baselineStatus: { artifact: 'other-summary' } });
      baselineStatus(['--json'], repo);
      expect(argv()).toMatch(/download 100 --name other-summary /);
    });

    it('carries no remedy on a normal answer', () => {
      baselineStatus(['--json'], repo);
      expect(json().remedy).toBeUndefined();
      expect(json().failingFiles).toEqual(['a.test.mts']);
    });
  });

  describe('bad input is a usage error (exit 1), never a gh call or a stack trace', () => {
    it.each([
      [['--workflow']],
      [['--workflow', '--json']],
      [['--workflow', '   ']],
      [['--workflow', '.github/workflows/']],
      [['--workflow', 'a.yml', '--workflow', 'b.yml']],
    ])('refuses %j', (args) => {
      withRuns([run()]);
      expect(baselineStatus(args, repo)).toBe(1);
      expect(text()).toMatch(/^🚫/);
    });

    it('reports a corrupt guard.config.json as exit 1 with a message', () => {
      configRaw(repo, '{ "baselineStatus": ');
      withRuns([run()]);
      expect(baselineStatus(['--json'], repo)).toBe(1);
      expect(text()).toMatch(/^🚫 .*guard\.config\.json/);
    });

    it.each(['.github/workflows/', '.github\\workflows\\', '/'])(
      'refuses a configured workflow %j that names no file, without calling gh',
      (workflow) => {
        config(repo, { baselineStatus: { workflow } });
        withRuns([run()]);
        expect(baselineStatus(['--json'], repo)).toBe(1);
        expect(text()).toMatch(/^🚫 .*baselineStatus\.workflow/);
        expect(() => argv()).toThrow(); // the stub never ran, so it never wrote its log
      },
    );
  });

  describe('the remedy appears only where the producer is the gap', () => {
    it('explains a workflow that never ran on the branch (e.g. PR-only triggers)', () => {
      withRuns([]);
      expect(baselineStatus(['--json'], repo)).toBe(0);
      const answer = json();
      expect(answer.reason).toBe('no-usable-run');
      expect(answer.detail).toBe('gate.yml has no runs on the last 1 commit(s) of main');
      expect(answer.remedy).toContain('pushes to main');
    });

    it('explains runs that carried no summary artifact', () => {
      withRuns([run(), run({ databaseId: 99 })]);
      expect(baselineStatus(['--json'], repo)).toBe(0);
      const answer = json();
      expect(answer.reason).toBe('no-usable-run');
      expect(answer.remedy).toContain('upload `test-report-summary`');
    });

    it('gives no CI-wiring advice when every run was merely cancelled', () => {
      withRuns([run({ conclusion: 'cancelled' }), run({ databaseId: 99, conclusion: 'skipped' })]);
      baselineStatus(['--json'], repo);
      const answer = json();
      expect(answer.reason).toBe('no-usable-run');
      expect(answer.remedy).toBeUndefined();
    });
  });
});

describe('workflowSelector', () => {
  it.each([
    ['gate.yml', 'gate.yml'],
    ['  gate.yml  ', 'gate.yml'],
    ['.github/workflows/gate.yml', 'gate.yml'],
    ['.github\\workflows\\gate.yml', 'gate.yml'],
    ['Test Suite', 'Test Suite'],
    ['12345', '12345'],
    ['.github/workflows/', ''],
  ])('%j → %j', (input, expected) => {
    expect(workflowSelector(input)).toBe(expected);
  });
});

describe('configuredSource', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'baseline-source-'));
    mkdirSync(join(dir, '.git'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (body: string) => writeFileSync(join(dir, 'guard.config.json'), body);
  const DEFAULT = { workflow: 'gate.yml', artifact: 'test-report-summary' };

  it('defaults with no guard.config.json anywhere up to the git root', () => {
    expect(configuredSource(dir)).toEqual(DEFAULT);
  });

  it('overrides per key, trimming the value', () => {
    write('{"baselineStatus":{"workflow":"  ci.yml "}}');
    expect(configuredSource(dir)).toEqual({ ...DEFAULT, workflow: 'ci.yml' });
  });

  it.each([
    '{}',
    '{"baselineStatus":null}',
    '{"baselineStatus":"ci.yml"}',
    '{"baselineStatus":[1]}',
  ])('ignores a missing or non-object block: %s', (body) => {
    write(body);
    expect(configuredSource(dir)).toEqual(DEFAULT);
  });

  it('throws, naming the file, on a config that is not a JSON object', () => {
    write('[]');
    expect(() => configuredSource(dir)).toThrow(/guard\.config\.json.*JSON object/);
  });

  it('throws, naming the key, on a workflow path that names no file', () => {
    write('{"baselineStatus":{"workflow":".github/workflows/"}}');
    expect(() => configuredSource(dir)).toThrow(/baselineStatus\.workflow.*names no workflow file/);
  });
});
