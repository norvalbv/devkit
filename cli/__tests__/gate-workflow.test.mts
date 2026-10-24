/** gate.yml's contracts: the `required` job is main's one required status check and must need every
 *  other job; the sharded suite must still publish one complete per-file report. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from './_helpers.mts';

const gateWorkflow = fileURLToPath(new URL('../../.github/workflows/gate.yml', import.meta.url));
const text = readFileSync(gateWorkflow, 'utf8');
const jobs = text.slice(text.indexOf('\njobs:\n'));
/** A job key: two spaces in, nothing after the colon. Keys elsewhere either sit deeper or hold values. */
const JOB_KEY = /^ {2}([\w-]+):$/gm;

/** One job's own lines, up to the next job key. */
function jobBlock(id: string): string {
  const start = jobs.indexOf(`\n  ${id}:\n`);
  expect(start, `gate.yml must define a \`${id}\` job`).toBeGreaterThan(-1);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** A job's steps, each starting at its `- ` item. */
const stepsOf = (id: string): string[] =>
  jobBlock(id)
    .split(/^ {6}- /m)
    .slice(1);

/** The step whose `name:` is `name`, in job `id`. */
function step(id: string, name: string): string {
  const found = stepsOf(id).find((s) => s.startsWith(`name: ${name}\n`));
  expect(found, `${id} must have a \`${name}\` step`).toBeDefined();
  return found!;
}

/** A step's `run: |` body, dedented to column 0 so bash reads it as written. */
const script = (s: string): string =>
  (/run: \|\n([\s\S]*)$/.exec(s)?.[1] ?? '').replace(/^ {10}/gm, '');

const requiredJob = () => jobBlock('required');
const SHARDS = /^ {8}shard: \[([^\]]*)\]$/m.exec(jobBlock('tests'))?.[1].split(/,\s*/);

describe('gate.yml required job', () => {
  it('needs every other job, so a job added later is required with no settings change', () => {
    const others = [...jobs.matchAll(JOB_KEY)].map((m) => m[1]).filter((id) => id !== 'required');
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(requiredJob())?.[1];
    expect(
      needs
        ?.split(',')
        .map((id) => id.trim())
        .toSorted(),
    ).toEqual(others.toSorted());
  });

  it('runs whatever its needs concluded, cancelled included, and reads them as RESULTS', () => {
    const job = requiredJob();
    expect(job).toMatch(/^ {4}if: always\(\)$/m);
    expect(job).toContain('RESULTS: ${{ toJSON(needs) }}');
  });

  it('posts its check run as `required`, the context main ruleset names, with no name or matrix', () => {
    expect(requiredJob()).not.toMatch(/^ {4}(name|strategy):/m);
  });

  it('runs on every pull request, so no PR waits forever on a check that never reports', () => {
    expect(text).toMatch(/^ {2}pull_request:\n(?!(?:[ \t]*(?:#.*)?\n)* {3})/m);
  });

  it.each([
    [{ gate: { result: 'success' } }, 0],
    [{ gate: { result: 'failure' } }, 1],
    [{ gate: { result: 'cancelled' } }, 1],
    [{ gate: { result: 'success' }, later: { result: 'skipped' } }, 1],
    [{}, 1],
  ])('needs %j exits %i', (needs, status) => {
    const body = /run: \|\n([\s\S]*)$/.exec(requiredJob())?.[1];
    expect(body).toBeDefined();
    const result = testSpawnSync('bash', ['-c', body!], {
      encoding: 'utf8',
      env: { ...process.env, RESULTS: JSON.stringify(needs) },
    });
    // Exactly 1, jq -e's false: a missing jq (127) or a syntax error (3) must not pass as a refusal.
    expect(result.status, result.stderr).toBe(status);
  });
});

describe('gate.yml checks and test shards', () => {
  // Ship's pre-push leaves typecheck to CI, so an early red step must never skip a later check.
  it('runs every check step of the gate job once Install succeeds, whatever failed before it', () => {
    const steps = stepsOf('gate');
    const install = steps.findIndex((s) => s.startsWith('name: Install\n'));
    expect(steps[install]).toContain('id: install');
    const checks = steps.slice(install + 1).filter((s) => !s.includes('if: always()'));
    expect(checks.length).toBeGreaterThan(0);
    for (const s of checks) {
      const name = s.slice(0, s.indexOf('\n'));
      // The step's own `if:` line, so a guard in a comment or `||` instead of `&&` cannot pass.
      const guard = s.split('\n').find((line) => line.startsWith('        if: '));
      expect(guard ?? '', name).toContain("!cancelled() && steps.install.outcome == 'success'");
    }
  });

  // A cancelled job is where `if: always()` stops being a guarantee, so the bound and the uploads
  // are one mechanism.
  it('bounds each vitest step itself, never a job that carries uploads', () => {
    // vitest has no run-level deadline, so an unbounded step inherits GitHub's 6-hour job default.
    for (const [job, name] of [
      ['tests', 'Tests'],
      ['test-report', 'Merge shard reports'],
    ]) {
      expect(step(job, name), name).toMatch(/^ {8}timeout-minutes: \d+$/m);
    }
    expect(
      text.match(/^ {0,5}timeout-minutes:/m),
      'timeout-minutes at job level would put the if: always() uploads at the mercy of cancellation',
    ).toBeNull();
  });

  it('names each shard apart and lets every shard finish', () => {
    const job = jobBlock('tests');
    // gh pr checks keeps one check per name, so shared names hide running shards from ship --wait-ci.
    expect(job).not.toMatch(/^ {4}name:/m);
    expect(job).toMatch(/^ {6}fail-fast: false$/m);
    expect(SHARDS?.length).toBeGreaterThan(1);
    expect(step('tests', 'Tests')).toContain(`--shard="$SHARD/${SHARDS?.length}" --reporter=blob`);
    const upload = step('tests', 'Upload shard blob');
    expect(upload).toContain('if: always()');
    expect(upload).toContain('include-hidden-files: true');
    expect(upload).toContain('if-no-files-found: error');
  });

  it('merges the shards unless the run was cancelled, and uploads both reports on red runs too', () => {
    const job = jobBlock('test-report');
    expect(job).toMatch(/^ {4}needs: \[tests\]$/m);
    expect(job).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
    expect(step('test-report', 'Merge shard reports')).toContain(
      'bun run test:run:report --mergeReports',
    );
    for (const name of ['test-report-summary', 'test-report']) {
      const upload = stepsOf('test-report').find((s) => s.includes(`name: ${name}\n`));
      // `.devkit` is a dot-folder: without include-hidden-files the upload is silently empty.
      expect(upload, name).toContain('if: always()');
      expect(upload, name).toContain('include-hidden-files: true');
    }
  });
});

describe('gate.yml shard completeness', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  /** A fresh cwd holding `.vitest/blob` with the given file names; null leaves no directory at all. */
  function blobDir(files: string[] | null): string {
    dir = mkdtempSync(join(tmpdir(), 'gate-shards-'));
    if (files === null) return dir;
    mkdirSync(join(dir, '.vitest/blob'), { recursive: true });
    for (const f of files) writeFileSync(join(dir, '.vitest/blob', f), '{}');
    return dir;
  }

  const blobs = (skip?: string) =>
    (SHARDS ?? []).filter((i) => i !== skip).map((i) => `blob-${i}-${SHARDS?.length}.json`);

  function guard(cwd: string) {
    return testSpawnSync('bash', ['-c', script(step('test-report', 'Every shard wrote a blob'))], {
      cwd,
      encoding: 'utf8',
    });
  }

  it('checks exactly the shards the matrix runs', () => {
    const loop = /for i in ([\d ]+); do/.exec(
      script(step('test-report', 'Every shard wrote a blob')),
    );
    expect(loop?.[1].trim().split(' ')).toEqual(SHARDS);
  });

  it('passes when every shard wrote a blob', () => {
    const result = guard(blobDir(blobs()));
    expect(result.status, result.stdout).toBe(0);
  });

  // null: no artifact matched the download pattern, so not even the directory exists.
  it.each([
    [blobs('2'), ' 2;'],
    [null, ` ${SHARDS?.join(' ')};`],
  ])('refuses, naming the missing shards, given %j', (files, named) => {
    const result = guard(blobDir(files));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`shard(s)${named}`);
  });

  it("refuses a shard's tombstone even beside an older attempt's blob", () => {
    const result = guard(blobDir([...blobs(), 'missing-3']));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('shard(s) 3;');
  });

  // null is a shard whose Install failed: vitest never ran, so `.vitest/blob` does not exist.
  it.each([
    [[], true],
    [null, true],
    [[`blob-2-${SHARDS?.length}.json`], false],
  ])('a shard holding %j leaves a tombstone=%s', (files, tombstone) => {
    const cwd = blobDir(files);
    const mark = script(step('tests', 'Mark a shard that wrote no blob'));
    const result = testSpawnSync('bash', ['-c', mark], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, SHARD: '2' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(cwd, '.vitest/blob/missing-2'))).toBe(tombstone);
  });
});
