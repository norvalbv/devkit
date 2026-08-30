/** sc-2245 edge cases — the inputs and states the happy-path suite does not model. */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import baselineStatus from '../commands/baseline/status.mts';
import { type RunRef, isUsableRun } from '../lib/baseline-status/gh.mts';
import { produceTestReport, summarise } from '../lib/baseline-status/produce.mts';
import { MAX_RUNS_CEILING, queryBaseline, resolveRef } from '../lib/baseline-status/query.mts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('summarise — a real vitest report, not a hand-built stand-in', () => {
  // Captured from a real `devkit test-report-run`. Hand-built objects agree with whatever the code
  // expects; this does not.
  const report = JSON.parse(readFileSync(join(FIXTURES, 'vitest-report.json'), 'utf8'));

  it('reduces the real reporter shape to per-file outcomes', () => {
    const summary = summarise(report, '/home/runner/work/devkit/devkit', {});
    expect(summary.files).toEqual({
      'cli/lib/git-tracked.test.mts': 'passed',
      'cli/__tests__/review-setup-worktree.test.mts': 'failed',
      'gate-engine/coverage/__tests__/produce.test.mts': 'passed',
    });
    expect(summary.droppedForeignPaths).toBe(1);
    expect(summary.testsPassed).toBe(false);
  });

  it('reads a suite-level status even when its assertionResults are empty', () => {
    // The nested-run entry carries status but no assertions. Deriving the file outcome from the
    // assertion list would silently score it as a pass.
    const summary = summarise(
      { testResults: [{ name: '/repo/cli/a.test.mts', status: 'failed' }] },
      '/repo',
      {},
    );
    expect(summary.files['cli/a.test.mts']).toBe('failed');
  });

  it('treats a pending/todo suite as skipped rather than passed', () => {
    const summary = summarise(
      { testResults: [{ name: '/repo/cli/a.test.mts', status: 'pending' }] },
      '/repo',
      {},
    );
    expect(summary.files['cli/a.test.mts']).toBe('skipped');
  });

  it('ignores a report entry with no name instead of crashing', () => {
    expect(summarise({ testResults: [{ status: 'passed' }] }, '/repo', {}).files).toEqual({});
  });

  it('rejects a non-numeric or zero CI run id rather than recording it', () => {
    // GITHUB_RUN_ID is absent outside Actions and empty in some self-hosted shims; 0 is not a run.
    const s = summarise({ success: true }, '/repo', {
      GITHUB_RUN_ID: '0',
      GITHUB_RUN_ATTEMPT: 'x',
    });
    expect(s.runId).toBeNull();
    expect(s.attempt).toBeNull();
  });
});

describe('produceTestReport — the guard branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'produce-guard-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses, naming the runner, when vitest is not installed', async () => {
    expect(await produceTestReport(dir, [])).toBe(1);
  });

  it('refuses forwarded args that would replace the reporter set', async () => {
    // Reached BEFORE vitest resolution would matter, so a repo with vitest present behaves the same.
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'node_modules', '.bin', 'vitest'), 0o755);
    expect(await produceTestReport(dir, ['--reporter=json'])).toBe(1);
    expect(await produceTestReport(dir, ['--outputFile.json=x'])).toBe(1);
  });

  it('returns the runner exit code and writes no summary when no report is produced', async () => {
    // A run killed before the reporter flushes. The absence must stay an absence: inventing an empty
    // summary would publish "nothing failed" for a run that never reported.
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin', 'vitest');
    writeFileSync(bin, '#!/bin/sh\nexit 137\n'); // 137 = SIGKILL, the OOM case
    chmodSync(bin, 0o755);
    expect(await produceTestReport(dir, [])).toBe(137);
    expect(() => readFileSync(join(dir, '.devkit/test-report-summary.json'))).toThrow();
  });

  it('survives a report that is not valid JSON', async () => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin', 'vitest');
    writeFileSync(bin, "#!/bin/sh\nprintf '{\"testRes' > .devkit/test-report.json\nexit 1\n");
    chmodSync(bin, 0o755);
    expect(await produceTestReport(dir, [])).toBe(1);
    expect(() => readFileSync(join(dir, '.devkit/test-report-summary.json'))).toThrow();
  });
});

/** The stubbed-gh harness, shared by the query and command cases below. */
function ghHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-query-'));
  const fixture = mkdtempSync(join(tmpdir(), 'edge-fixture-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'gh');
  writeFileSync(
    stub,
    `#!/bin/sh
if [ -n "$DEVKIT_GH_FAIL" ]; then echo "$DEVKIT_GH_FAIL" >&2; exit 1; fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  while [ $# -gt 0 ]; do if [ "$1" = "--limit" ]; then echo "$2" > "$DEVKIT_TEST_FIXTURE/limit"; fi; shift; done
  cat "$DEVKIT_TEST_FIXTURE/runs.json"; exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  if [ -n "$DEVKIT_GH_DOWNLOAD_FAIL" ]; then echo "$DEVKIT_GH_DOWNLOAD_FAIL" >&2; exit 1; fi
  id="$3"; out=""
  while [ $# -gt 0 ]; do if [ "$1" = "--dir" ]; then out="$2"; fi; shift; done
  if [ -f "$DEVKIT_TEST_FIXTURE/empty-$id" ]; then exit 0; fi
  if [ -f "$DEVKIT_TEST_FIXTURE/summary-$id.json" ]; then
    mkdir -p "$out/run-$id"; cp "$DEVKIT_TEST_FIXTURE/summary-$id.json" "$out/run-$id/summary.json"; exit 0
  fi
  echo "no artifact matches any of the names or patterns provided" >&2; exit 1
fi
exit 1
`,
  );
  chmodSync(stub, 0o755);
  return { dir, fixture, bin };
}

// runId must match the run it is served for; the reader rejects a mismatched artifact by design.
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

const runRef = (over: Partial<RunRef> = {}): RunRef => ({
  databaseId: 100,
  attempt: 1,
  status: 'completed',
  conclusion: 'failure',
  headSha: 'deadbeefcafe',
  createdAt: '2026-08-29T00:00:00Z',
  ...over,
});

describe('--file path shapes', () => {
  let dir: string;
  let fixture: string;
  let sha: string;
  const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;

    // A REAL repo containing the file, so `absent` vs `excluded` is decided by real git, not by the
    // absence of a commit. This is what makes a wrong answer here confident rather than unknown.
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'a');
    mkdirSync(join(dir, 'cli'), { recursive: true });
    writeFileSync(join(dir, 'cli', 'a.test.mts'), '');
    git('add', '-A');
    git('commit', '-m', 'seed');
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef({ headSha: sha })]));
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true),
    );
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  const ask = (file: string) => queryBaseline({ cwd: dir, ref: 'main', file }).file;

  it('resolves a plain repo-relative path', () => {
    expect(ask('cli/a.test.mts')?.status).toBe('passed');
  });

  it('resolves a ./-prefixed path — shell completion produces these constantly', () => {
    // Wrong answer before the fix: git NORMALISES ./, so the existence probe succeeds and the file is
    // reported `excluded` ("the runner did not collect it") for a file that ran and PASSED.
    expect(ask('./cli/a.test.mts')?.status).toBe('passed');
  });

  it('resolves an absolute path — every tool-produced path is one', () => {
    // Wrong answer before the fix: git cannot resolve an absolute path in <sha>:<path>, so the probe
    // fails and the file is reported `absent` ("no such path at that commit"). It exists and passed.
    expect(ask(join(dir, 'cli/a.test.mts'))?.status).toBe('passed');
  });

  it('still reports a genuinely absent path as absent', () => {
    // The normalisation must not blur the distinction it exists to protect.
    expect(ask('cli/never-existed.test.mts')?.status).toBe('absent');
  });

  it('reports a file present at the commit but never collected as excluded', () => {
    writeFileSync(join(dir, 'cli', 'uncollected.test.mts'), '');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add', '--allow-empty'], { cwd: dir, stdio: 'ignore' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef({ headSha: head })]));
    expect(ask('cli/uncollected.test.mts')?.status).toBe('excluded');
  });

  it('resolves a path typed from a SUBDIRECTORY against the repo root', () => {
    // Same pathology as sc-2079 (cwd-relative ids the gate never looks up): summary keys are
    // repo-root-relative.
    expect(
      queryBaseline({ cwd: join(dir, 'cli'), ref: 'main', file: 'a.test.mts' }).file?.status,
    ).toBe('passed');
  });

  it('reads the default branch from the remote HEAD when one is set', () => {
    execFileSync('git', ['remote', 'add', 'origin', dir], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], {
      cwd: dir,
      stdio: 'ignore',
    });
    expect(resolveRef(dir)).toBe('trunk');
  });
});

describe('command-layer argument handling', () => {
  let dir: string;
  let fixture: string;
  const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };
  let out: string[];
  const log = console.log;
  const err = console.error;

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef()]));
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed', 'cli/b.test.mts': 'failed' }, false),
    );
    out = [];
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    console.error = (...a: unknown[]) => void out.push(a.join(' '));
  });

  afterEach(() => {
    console.log = log;
    console.error = err;
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('does not read the NEXT FLAG as the value of --file', () => {
    // Refused, not quietly downgraded to the run-level question.
    expect(baselineStatus(['--file', '--json', '--ref', 'main'], dir)).toBe(1);
    expect(out.join('\n')).toMatch(/--file needs a value/);
  });

  it('rejects a --max-runs that is zero, negative or not a number', () => {
    for (const bad of ['0', '-1', 'abc']) {
      expect(baselineStatus(['--max-runs', bad, '--ref', 'main'], dir)).toBe(1);
    }
  });

  it('clamps an absurd --max-runs before it reaches gh', () => {
    // Measured: real `gh run list --limit` does NOT reject a huge value, it returns all 335 runs.
    expect(
      baselineStatus(
        ['--max-runs', String(Number.MAX_SAFE_INTEGER), '--json', '--ref', 'main'],
        dir,
      ),
    ).toBe(0);
    expect(Number(readFileSync(join(fixture, 'limit'), 'utf8').trim())).toBe(MAX_RUNS_CEILING);
  });

  it('passes a reasonable --max-runs through unchanged', () => {
    expect(baselineStatus(['--max-runs', '3', '--json', '--ref', 'main'], dir)).toBe(0);
    expect(Number(readFileSync(join(fixture, 'limit'), 'utf8').trim())).toBe(3);
  });

  it('renders the human view without --json, naming the failing files', () => {
    expect(baselineStatus(['--ref', 'main'], dir)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('cli/b.test.mts');
    expect(text).toMatch(/run: red/);
  });

  it('exits 0 for a successful query whose answer is unknown', () => {
    // A caller branching on the exit code must not read "main has no data" as "the tool is broken".
    rmSync(join(fixture, 'summary-100.json'));
    expect(baselineStatus(['--json', '--ref', 'main'], dir)).toBe(0);
    expect(JSON.parse(out.join('\n')).reason).toBe('no-usable-run');
  });

  it('exits NON-ZERO when the query could not be performed at all', () => {
    // The documented contract, previously contradicted by an unconditional 0: a shell caller must be
    // able to tell "gh is missing" from "main is green".
    process.env.PATH = join(dir, 'empty-bin');
    expect(baselineStatus(['--json', '--ref', 'main'], dir)).toBe(2);
    expect(JSON.parse(out.join('\n')).reason).toBe('gh-missing');
  });
});

describe('artifact and gh failure shapes', () => {
  let dir: string;
  let fixture: string;
  const saved = {
    PATH: process.env.PATH,
    fx: process.env.DEVKIT_TEST_FIXTURE,
    fail: process.env.DEVKIT_GH_FAIL,
  };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef()]));
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    if (saved.fail === undefined) delete process.env.DEVKIT_GH_FAIL;
    else process.env.DEVKIT_GH_FAIL = saved.fail;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('names an unauthenticated gh distinctly from a generic failure', () => {
    process.env.DEVKIT_GH_FAIL = 'gh auth login required';
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('gh-unauthenticated');
  });

  it('names a non-GitHub remote distinctly', () => {
    process.env.DEVKIT_GH_FAIL =
      'none of the git remotes configured for this repository point to a known GitHub host';
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('not-a-github-repo');
  });

  it('treats an unparseable run list as a failure, not an empty run list', () => {
    // An empty list reads as "no runs on this branch"; garbage from gh is a different fact.
    writeFileSync(join(fixture, 'runs.json'), 'not json');
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('gh-failed');
  });

  it('handles an artifact that downloads successfully but contains no summary file', () => {
    writeFileSync(join(fixture, 'empty-100'), '');
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('artifact-unreadable');
  });

  it('rejects a summary whose files field is an array rather than a map', () => {
    writeFileSync(join(fixture, 'summary-100.json'), JSON.stringify({ schema: 1, files: [] }));
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
  });

  it('reports no-usable-run when the branch has no runs at all', () => {
    writeFileSync(join(fixture, 'runs.json'), '[]');
    const answer = queryBaseline({ cwd: dir, ref: 'main' });
    expect(answer.reason).toBe('no-usable-run');
    expect(answer.skippedRuns).toEqual([]);
  });
});

describe('run-selection boundaries', () => {
  it('rejects every non-pass/fail conclusion GitHub can report as completed', () => {
    for (const conclusion of [
      'cancelled',
      'timed_out',
      'startup_failure',
      'skipped',
      'action_required',
      'neutral',
      '',
    ]) {
      expect(isUsableRun(runRef({ conclusion }))).toBe(false);
    }
  });
});

describe('wiring', () => {
  it('registers both commands in the dispatcher, and only baseline-status as git-needing', async () => {
    // `test-report-run` must NOT be in GIT_COMMANDS: it shells vitest, never git, so a missing-git
    // preflight would refuse to produce a report in a git-less container.
    const index = readFileSync(join(import.meta.dirname, '..', 'index.mts'), 'utf8');
    expect(index).toContain("'baseline-status': () => import('./commands/baseline/status.mts')");
    expect(index).toContain(
      "'test-report-run': () => import('./commands/baseline/test-report-run.mts')",
    );
    const gitCommands = index.slice(index.indexOf('const GIT_COMMANDS'));
    expect(gitCommands.slice(0, gitCommands.indexOf(']'))).toContain("'baseline-status'");
    expect(gitCommands.slice(0, gitCommands.indexOf(']'))).not.toContain("'test-report-run'");
  });

  it('exposes test-report-run as a runnable command that reaches the producer', async () => {
    const mod = await import('../commands/baseline/test-report-run.mts');
    expect(mod.meta.name).toBe('test-report-run');
    // A temp dir has no vitest, so the producer's own refusal branch is the observable proof that
    // the command is wired to it rather than to nothing.
    const dir = mkdtempSync(join(tmpdir(), 'wiring-'));
    try {
      expect(await mod.default([], dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gitignores every artifact the producer and reader write', () => {
    // An untracked-but-unignored .devkit sidecar was enough to make `devkit release` refuse on an
    // unclean tree — the reason .gitignore already carries that warning.
    const ignored = readFileSync(join(import.meta.dirname, '..', '..', '.gitignore'), 'utf8');
    for (const path of ['.devkit/test-reports/', '.devkit/baseline-status/']) {
      expect(ignored).toContain(path);
    }
  });

  it('uploads both artifacts from the gate, on red runs too', () => {
    // `if: always()` is the whole point: a red run is the one the per-file record decomposes.
    const gate = readFileSync(
      join(import.meta.dirname, '..', '..', '.github/workflows/gate.yml'),
      'utf8',
    );
    expect(gate).toContain('bun run test:run:report');
    expect(gate).toContain('name: test-report-summary');
    expect(gate).toContain('name: test-report');
    const uploads = gate.slice(gate.indexOf('Upload test report summary'));
    expect(uploads.match(/if: always\(\)/g)).toHaveLength(2);
    // `.devkit` is a dot-folder and upload-artifact skips "files within folders beginning with `.`"
    // unless told otherwise, so without this BOTH artifacts upload nothing — silently, because
    // `if-no-files-found: ignore` treats an empty match as success.
    expect(uploads.match(/include-hidden-files: true/g)).toHaveLength(2);
  });
});

describe('artifact validation and transient failures (correctness-reviewer findings)', () => {
  let dir: string;
  let fixture: string;
  const saved = {
    PATH: process.env.PATH,
    fx: process.env.DEVKIT_TEST_FIXTURE,
    dl: process.env.DEVKIT_GH_DOWNLOAD_FAIL,
  };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef()]));
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    if (saved.dl === undefined) delete process.env.DEVKIT_GH_DOWNLOAD_FAIL;
    else process.env.DEVKIT_GH_DOWNLOAD_FAIL = saved.dl;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('does not relabel a transient download error as "this run has no artifact"', () => {
    // "no artifact" is a claim ABOUT THE RUN and silently shrinks the walk-back window. A 500 from
    // the API is a claim about the network and must not masquerade as one.
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true),
    );
    process.env.DEVKIT_GH_DOWNLOAD_FAIL = 'HTTP 500: Internal Server Error (api.github.com)';
    const answer = queryBaseline({ cwd: dir, ref: 'main' });
    expect(answer.skippedRuns[0]?.why).not.toMatch(/has no .* artifact/);
    expect(answer.skippedRuns[0]?.why).toMatch(/500/);
  });

  it('rejects a summary whose per-file values are not real outcomes', () => {
    // `"bogus"` currently flows straight through to the caller as a FileStatus, so the command
    // reports a status it invented rather than one CI recorded.
    writeFileSync(
      join(fixture, 'summary-100.json'),
      JSON.stringify({ schema: 1, testsPassed: false, files: { 'cli/a.test.mts': 'bogus' } }),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
  });

  it('rejects a summary whose testsPassed is a string rather than a boolean', () => {
    // `"false"` is truthy, so an unvalidated read reports testsStatus green for a red test step.
    writeFileSync(
      join(fixture, 'summary-100.json'),
      JSON.stringify({ schema: 1, testsPassed: 'false', files: {} }),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
  });

  it('refetches rather than crashing on a cache entry that parses but has no files map', () => {
    // `{}` is valid JSON, so the JSON.parse try/catch does not fire; the value then reaches
    // Object.entries(summary.files) and throws, breaking the exit-0 / named-unknown contract.
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true),
    );
    mkdirSync(join(dir, '.devkit/baseline-status'), { recursive: true });
    writeFileSync(join(dir, '.devkit/baseline-status/100-1.json'), '{}');
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' });
    expect(answer.file?.status).toBe('passed');
  });
});

describe("the producer never publishes another run's summary", () => {
  let dir: string;

  const fakeVitest = (script: string) => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin', 'vitest');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'produce-stale-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves no directory of its own when this run produces no report', async () => {
    // A killed run must contribute nothing rather than an empty or stale-looking summary.
    fakeVitest('exit 137');
    expect(await produceTestReport(dir, [])).toBe(137);
    expect(readdirSync(join(dir, '.devkit/test-reports'))).toHaveLength(0);
  });

  it('never reads a report left in the workspace by another run', async () => {
    // Parallel agents sharing a checkout is devkit's stated premise; each run reads only its own
    // directory, so a sibling's report cannot be summarised under this run's identity.
    mkdirSync(join(dir, '.devkit/test-reports/other'), { recursive: true });
    writeFileSync(
      join(dir, '.devkit/test-reports/other/report.json'),
      JSON.stringify({
        success: true,
        testResults: [{ name: `${dir}/x.test.mts`, status: 'passed' }],
      }),
    );
    fakeVitest('exit 1');
    await produceTestReport(dir, []);
    expect(existsSync(join(dir, '.devkit/test-reports/other/summary.json'))).toBe(false);
  });
});

describe('provenance and malformed-primitive rejection (reviewer round 2)', () => {
  let dir: string;
  let fixture: string;
  const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef()]));
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('rejects a primitive `files` that survives the array/null guard', () => {
    // Object.entries(42) is [], so the per-value loop never runs and `testsPassed: true` sails
    // through as a confident green over zero files.
    for (const files of [42, true, 1, 'x']) {
      writeFileSync(
        join(fixture, 'summary-100.json'),
        JSON.stringify({ schema: 1, testsPassed: true, files }),
      );
      expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
    }
  });

  it('rejects a summary whose recorded run identity is not the run it was fetched for', () => {
    // `if: always()` plus a shared workspace can attach one run's summary to another. Believing it
    // reports a per-file result for the WRONG COMMIT, stated with full confidence.
    writeFileSync(
      join(fixture, 'summary-100.json'),
      JSON.stringify({
        schema: 1,
        sha: 'someothersha',
        runId: 999,
        attempt: 1,
        testsPassed: true,
        files: { 'cli/a.test.mts': 'passed' },
      }),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
  });

  it('rejects a summary that carries no run identity at all', () => {
    // An artifact fetched FROM a CI run was produced by it and so carries its ids. One that carries
    // none came from somewhere else; absent is not the same as uncontradicted, and requiring a
    // positive match is what turns every producer-side race into a missing answer, never a wrong one.
    writeFileSync(
      join(fixture, 'summary-100.json'),
      JSON.stringify({
        schema: 1,
        sha: null,
        runId: null,
        attempt: null,
        testsPassed: true,
        files: { 'cli/a.test.mts': 'passed' },
      }),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
  });
});

describe('paths that merely begin with dots', () => {
  it('does not classify `..smoke.test.mts` as escaping the repo', () => {
    // `rel.startsWith('..')` is a prefix test, not a path-segment test: a legitimate filename whose
    // first two characters are dots gets dropped as foreign and then reported `absent`.
    const summary = summarise(
      { success: true, testResults: [{ name: '/repo/..smoke.test.mts', status: 'passed' }] },
      '/repo',
      {},
    );
    expect(summary.files['..smoke.test.mts']).toBe('passed');
    expect(summary.droppedForeignPaths).toBe(0);
  });
});

describe('provenance, list validation and status vocabulary (reviewer round 3)', () => {
  let dir: string;
  let fixture: string;
  const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('returns a named unknown when gh run list yields JSON that is not an array', () => {
    // `null` and `{}` parse fine and were cast straight to RunRef[]; the for-of then threw, breaking
    // the exit-0 contract at the boundary whose whole job is to keep gh failures survivable.
    for (const body of ['null', '{}', '"text"']) {
      writeFileSync(join(fixture, 'runs.json'), body);
      expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('gh-failed');
    }
  });

  it('rejects an artifact from an earlier ATTEMPT of the same run', () => {
    // A re-run keeps the run id and bumps the attempt, so validating the id alone lets attempt 1's
    // results be reported — and cached — as attempt 2's. That is the exact staleness the
    // runId+attempt cache key exists to prevent.
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef({ attempt: 2 })]));
    writeFileSync(
      join(fixture, 'summary-100.json'),
      JSON.stringify({
        schema: 1,
        sha: 'sha1',
        runId: 100,
        attempt: 1,
        testsPassed: true,
        files: { 'cli/a.test.mts': 'passed' },
      }),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main' }).reason).toBe('schema-mismatch');
  });

  it('refetches a cache entry whose payload names a different run than its filename', () => {
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef()]));
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true),
    );
    mkdirSync(join(dir, '.devkit/baseline-status'), { recursive: true });
    // Schema-valid, correctly named, but describing run 555 — believing it reports another run's
    // per-file results under this run's identity.
    writeFileSync(
      join(dir, '.devkit/baseline-status/100-1.json'),
      summaryFor({ 'cli/a.test.mts': 'failed' }, false, 555),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' }).file?.status).toBe(
      'passed',
    );
  });
});

describe('report statuses the producer does not recognise', () => {
  it('omits an entry whose status is missing or unknown rather than calling it skipped', () => {
    // Mapping every non-passed/failed value to `skipped` publishes confident evidence about a file
    // whose real outcome is unknown — and would silently absorb a future vitest status.
    const summary = summarise(
      {
        testResults: [
          { name: '/repo/known.test.mts', status: 'passed' },
          { name: '/repo/weird.test.mts', status: 'quantum' },
          { name: '/repo/missing.test.mts' },
        ],
      },
      '/repo',
      {},
    );
    expect(summary.files).toEqual({ 'known.test.mts': 'passed' });
  });

  it("still recognises vitest's own pending and todo statuses as skipped", () => {
    const summary = summarise(
      {
        testResults: [
          { name: '/repo/a.test.mts', status: 'pending' },
          { name: '/repo/b.test.mts', status: 'todo' },
          { name: '/repo/c.test.mts', status: 'skipped' },
        ],
      },
      '/repo',
      {},
    );
    expect(summary.files).toEqual({
      'a.test.mts': 'skipped',
      'b.test.mts': 'skipped',
      'c.test.mts': 'skipped',
    });
  });
});

describe('the producer clears stale artifacts on EVERY exit path', () => {
  let dir: string;
  const summaries = () => {
    const root = join(dir, '.devkit/test-reports');
    try {
      return readdirSync(root).flatMap((d) => {
        try {
          return readdirSync(join(root, d)).filter((f) => f === 'summary.json');
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'produce-exit-'));
    mkdirSync(join(dir, '.devkit/test-reports/leftover'), { recursive: true });
    writeFileSync(
      join(dir, '.devkit/test-reports/leftover/summary.json'),
      JSON.stringify({ schema: 1, testsPassed: true, files: {} }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds no summary of its own when vitest cannot be resolved', async () => {
    // A leftover directory may remain, but it carries another run's provenance, so the reader
    // refuses it rather than reading it as this run's result.
    expect(await produceTestReport(dir, [])).toBe(1);
    expect(summaries()).toHaveLength(1);
  });

  it('adds no summary of its own when reserved reporter flags are forwarded', async () => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin', 'vitest');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    expect(await produceTestReport(dir, ['--reporter=json'])).toBe(1);
    expect(summaries()).toHaveLength(1);
  });
});

describe('final hardening (reviewer round 4)', () => {
  it('errors on a flag written with no value instead of silently ignoring it', () => {
    // `--file` with nothing after it currently answers the RUN-level question, so the user is shown
    // a confident answer to a question they did not ask.
    const dir = mkdtempSync(join(tmpdir(), 'flagless-'));
    try {
      expect(baselineStatus(['--file'], dir)).toBe(1);
      expect(baselineStatus(['--file', '--json'], dir)).toBe(1);
      expect(baselineStatus(['--ref'], dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let a prototype-named test file corrupt the summary', () => {
    // `files` was a plain object literal, so an entry named `constructor` reads back as a FUNCTION
    // from Object.prototype and the merge then compares against it instead of an outcome.
    const summary = summarise(
      {
        testResults: [
          { name: '/repo/constructor', status: 'failed' },
          { name: '/repo/__proto__', status: 'failed' },
          { name: '/repo/toString', status: 'passed' },
        ],
      },
      '/repo',
      {},
    );
    expect(summary.files.constructor).toBe('failed');
    expect(summary.files.toString).toBe('passed');
  });

  it('keys the summary with POSIX separators regardless of host platform', () => {
    // CI writes the artifact on Linux; a Windows reader relativises to `cli\\a.test.mts` and misses
    // every key. One separator convention has to win, and it is the artifact's.
    const summary = summarise(
      { testResults: [{ name: join('/repo', 'cli', 'a.test.mts'), status: 'passed' }] },
      '/repo',
      {},
    );
    expect(Object.keys(summary.files)).toEqual(['cli/a.test.mts']);
  });
});

describe('boundary inputs and evidence availability (reviewer round 5)', () => {
  let dir: string;
  let fixture: string;
  const saved = {
    PATH: process.env.PATH,
    fx: process.env.DEVKIT_TEST_FIXTURE,
    dl: process.env.DEVKIT_GH_DOWNLOAD_FAIL,
  };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    if (saved.dl === undefined) delete process.env.DEVKIT_GH_DOWNLOAD_FAIL;
    else process.env.DEVKIT_GH_DOWNLOAD_FAIL = saved.dl;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('rejects a non-integer --max-runs instead of forwarding it to gh', () => {
    // `--limit 1.5` fails inside gh, so the invalid ARGUMENT was reported as a gh failure (exit 2).
    expect(baselineStatus(['--max-runs', '1.5'], dir)).toBe(1);
  });

  it('rejects an empty --file rather than answering the run-level question', () => {
    expect(baselineStatus(['--file', ''], dir)).toBe(1);
  });

  it('does not read an inherited Object.prototype member as a recorded outcome', () => {
    // `summary.files.toString` is a FUNCTION on any JSON-parsed object, so a query for a file named
    // `toString` was answered with it instead of resolving to absent/excluded.
    writeFileSync(join(fixture, 'runs.json'), JSON.stringify([runRef()]));
    writeFileSync(
      join(fixture, 'summary-100.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'toString' });
    expect(['absent', 'excluded', 'unknown']).toContain(answer.file?.status);
  });

  it('stops at an UNREADABLE newest run instead of answering from an older one', () => {
    // "I could not read this run's evidence" is not "this run has no evidence". Walking past the
    // first and reporting the second as the baseline hides that the current answer is unavailable.
    writeFileSync(
      join(fixture, 'runs.json'),
      JSON.stringify([runRef({ databaseId: 100 }), runRef({ databaseId: 99 })]),
    );
    writeFileSync(join(fixture, 'summary-100.json'), '{"schema":1,"files":{}, truncated');
    writeFileSync(
      join(fixture, 'summary-99.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true, 99),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main' });
    expect(answer.runId).toBeNull();
    expect(answer.reason).toBe('artifact-unreadable');
  });

  it('still walks past a run that genuinely has no artifact', () => {
    writeFileSync(
      join(fixture, 'runs.json'),
      JSON.stringify([runRef({ databaseId: 100 }), runRef({ databaseId: 99 })]),
    );
    writeFileSync(
      join(fixture, 'summary-99.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true, 99),
    );
    expect(queryBaseline({ cwd: dir, ref: 'main' }).runId).toBe(99);
  });
});

describe('the producer fails loudly when it produces nothing', () => {
  let dir: string;

  const fakeVitest = (script: string) => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin', 'vitest');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'produce-loud-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exits non-zero when vitest passes but writes no report', async () => {
    // Green tests with no artifact is not a green run of THIS command: the one thing it exists to
    // produce is missing, and reporting 0 sends the operator to a baseline query three steps later.
    fakeVitest('exit 0');
    expect(await produceTestReport(dir, [])).toBe(1);
  });

  it('exits non-zero when the report cannot be summarised', async () => {
    fakeVitest('mkdir -p "$1" 2>/dev/null; exit 0');
    // A report that is not valid JSON: vitest succeeded, the artifact is unusable.
    fakeVitest(
      'd=$(ls -d .devkit/test-reports/*/ | head -1); printf "{oops" > "$d/report.json"; exit 0',
    );
    expect(await produceTestReport(dir, [])).toBe(1);
  });
});

describe('final round: unsupported input and unestablishable history', () => {
  let dir: string;
  let fixture: string;
  const saved = { PATH: process.env.PATH, fx: process.env.DEVKIT_TEST_FIXTURE };

  beforeEach(() => {
    const h = ghHarness();
    dir = h.dir;
    fixture = h.fixture;
    process.env.PATH = `${h.bin}:${saved.PATH ?? ''}`;
    process.env.DEVKIT_TEST_FIXTURE = fixture;
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.fx === undefined) delete process.env.DEVKIT_TEST_FIXTURE;
    else process.env.DEVKIT_TEST_FIXTURE = saved.fx;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('rejects a repeated option rather than silently using the first', () => {
    // The value lookup takes the first occurrence, so `--file a --file b` would answer about `a`.
    expect(baselineStatus(['--file', 'a.test.mts', '--file', 'b.test.mts'], dir)).toBe(1);
    expect(baselineStatus(['--json', '--json'], dir)).toBe(1);
  });

  it('rejects a positional path instead of answering the run-level question', () => {
    // `devkit baseline-status cli/foo.test.mts` reads as "tell me about this file"; silently
    // answering the run-level question hands back a confident answer to a different question.
    expect(baselineStatus(['cli/foo.test.mts', '--json'], dir)).toBe(1);
  });

  it("will not claim a LAST passing run when a newer run's evidence is unavailable", () => {
    // With run 100's artifact missing, run 99 is only the latest run whose evidence we HAVE — 100
    // may also have passed. Reporting 99 as "last passed" states more than is known.
    writeFileSync(
      join(fixture, 'runs.json'),
      JSON.stringify([
        runRef({ databaseId: 101 }),
        runRef({ databaseId: 100 }),
        runRef({ databaseId: 99 }),
      ]),
    );
    writeFileSync(
      join(fixture, 'summary-101.json'),
      summaryFor({ 'cli/a.test.mts': 'failed' }, false, 101),
    );
    // 100 has no artifact; 99 passed.
    writeFileSync(
      join(fixture, 'summary-99.json'),
      summaryFor({ 'cli/a.test.mts': 'passed' }, true, 99),
    );
    const answer = queryBaseline({ cwd: dir, ref: 'main', file: 'cli/a.test.mts' });
    expect(answer.file?.lastPassed).toBeNull();
    expect(answer.file?.lastPassedReason).toBe('no-artifact-history');
  });
});

describe('a report with no run-level verdict', () => {
  it('is not summarised as green', () => {
    // vitest's json reporter always writes `success`; its absence means a truncated or foreign
    // report, and deriving "everything passed" from the entries present is the fabricated green.
    const summary = summarise(
      { testResults: [{ name: '/repo/a.test.mts', status: 'passed' }] },
      '/repo',
      {},
    );
    expect(summary.testsPassed).toBe(false);
  });
});

describe('a report that is valid JSON but not a vitest report', () => {
  let dir: string;

  const fakeVitest = (payload: string) => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      bin,
      `#!/bin/sh\nd=$(ls -d .devkit/test-reports/*/ | head -1); printf '%s' '${payload}' > "$d/report.json"; exit 0\n`,
    );
    chmodSync(bin, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'produce-foreign-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a payload whose testResults is not an array', async () => {
    // `for...of` over a string iterates CHARACTERS, so this yields an empty file map while
    // `success: true` carries straight through — a green published over zero files.
    fakeVitest('{"success":true,"testResults":"nope"}');
    expect(await produceTestReport(dir, [])).toBe(1);
    expect(existsSync(join(dir, '.devkit/test-reports'))).toBe(true);
    expect(readdirSync(join(dir, '.devkit/test-reports'))).toHaveLength(0);
  });

  it('refuses a payload with no run-level success flag', async () => {
    fakeVitest('{"testResults":[]}');
    expect(await produceTestReport(dir, [])).toBe(1);
  });
});
