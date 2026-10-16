import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../vitest.config.mjs';
import BaselinePointerReporter, { formatBaselinePointer } from './_baseline-pointer.mts';
import { testSpawnSync } from './_helpers.mts';

const HEADER =
  "devkit test baseline: check whether these files are already red on main's CI before re-running anything:";
const commandFor = (file: string) => `  node cli/index.mts baseline-status --file ${file} --json`;

afterEach(() => vi.restoreAllMocks());

describe('baseline pointer lines', () => {
  it('prints nothing when no file failed', () => {
    expect(formatBaselinePointer([], [50, 50, 50], 10)).toEqual([]);
  });

  it('names the exact command for each failing file, with no load line within the cpu count', () => {
    expect(formatBaselinePointer(['cli/__tests__/a.test.mts'], [3, 2, 1], 10)).toEqual([
      HEADER,
      commandFor('cli/__tests__/a.test.mts'),
    ]);
  });

  // Windows reports [0, 0, 0]: never read as overload.
  it('prints no load line for an all-zero load', () => {
    expect(formatBaselinePointer(['a.test.mts'], [0, 0, 0], 4)).toEqual([
      HEADER,
      commandFor('a.test.mts'),
    ]);
  });

  it('says a clean-base re-run proves nothing when the 1-minute load exceeds the cpu count', () => {
    expect(formatBaselinePointer(['a.test.mts'], [35.71, 40.35, 38.4], 10)).toEqual([
      HEADER,
      '  loadavg 35.71 > 10 cpus: a re-run on a clean base under this load proves nothing',
      commandFor('a.test.mts'),
    ]);
  });

  it('caps the list at 10 files and points the rest at the run-level query', () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.test.mts`);
    const lines = formatBaselinePointer(files, [1, 1, 1], 10);

    expect(lines).toHaveLength(12);
    expect(lines.slice(1, 11)).toEqual(files.slice(0, 10).map(commandFor));
    expect(lines[11]).toBe(
      '  …and 15 more — node cli/index.mts baseline-status --json lists every file failing on main',
    );
  });

  // An off-by-one cap would print "…and 0 more" at exactly the cap.
  it('lists exactly 10 failing files with no overflow line', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.test.mts`);

    expect(formatBaselinePointer(files, [1, 1, 1], 10)).toEqual([HEADER, ...files.map(commandFor)]);
  });
});

const testModule = (relativeModuleId: string, state: string) => ({
  relativeModuleId,
  state: () => state,
});

describe('baseline pointer reporter', () => {
  const runEnd = (
    modules: ReturnType<typeof testModule>[],
    reason: 'passed' | 'failed' | 'interrupted',
  ) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    new BaselinePointerReporter().onTestRunEnd(modules, [], reason);
    return errors.mock.calls.map(([line]) => line);
  };

  it('stays silent on a passing run', () => {
    expect(runEnd([testModule('a.test.mts', 'passed')], 'passed')).toEqual([]);
  });

  it('stays silent on an interrupted run, even with a failed file', () => {
    expect(runEnd([testModule('a.test.mts', 'failed')], 'interrupted')).toEqual([]);
  });

  it('stays silent when the run failed on an unhandled error but no file did', () => {
    expect(runEnd([testModule('a.test.mts', 'passed')], 'failed')).toEqual([]);
  });

  it('points only at the failed files', () => {
    const lines = runEnd(
      [testModule('a.test.mts', 'passed'), testModule('b.test.mts', 'failed')],
      'failed',
    );

    expect(lines).toContain(commandFor('b.test.mts'));
    expect(lines.join('\n')).not.toContain('a.test.mts');
  });
});

const REPO = path.resolve(import.meta.dirname, '../..');
const MODULE = path.join(REPO, 'cli/__tests__/_baseline-pointer.mts');

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'baseline-pointer-')));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Mirrors the root config's inline `projects: [{ extends: false }]` layout, which sets relativeModuleId. */
function runFixture(files: Record<string, string>) {
  mkdirSync(path.join(scratch, 'sub'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(scratch, name), body);
  writeFileSync(
    path.join(scratch, 'vitest.config.mjs'),
    `export default { test: { projects: [{ extends: false, test: { name: 'fx', include: ['sub/*.test.mts'] } }], reporters: ['default', ${JSON.stringify(MODULE)}] } };\n`,
  );
  return testSpawnSync(
    process.execPath,
    [path.join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', scratch],
    { cwd: scratch, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  );
}

const PASSING = "import { it } from 'vitest';\nit('passes', () => {});\n";

describe('baseline pointer reporter inside a real vitest run', () => {
  it('is registered in the root config', () => {
    expect(config.test?.reporters).toContain('./cli/__tests__/_baseline-pointer.mts');
  });

  // Pins vitest's real state() and root-relative relativeModuleId, including an import-time throw.
  it('prints the command for a failing assertion and a file that throws at import', () => {
    const result = runFixture({
      'sub/ok.test.mts': PASSING,
      'sub/red.test.mts':
        "import { expect, it } from 'vitest';\nit('fails', () => expect(1).toBe(2));\n",
      'sub/boom.test.mts': "throw new Error('import-time');\n",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(HEADER);
    expect(result.stderr).toContain(commandFor('sub/red.test.mts'));
    expect(result.stderr).toContain(commandFor('sub/boom.test.mts'));
    expect(result.stderr).not.toContain('sub/ok.test.mts --json');
  });

  it('prints nothing new on a passing run', () => {
    const result = runFixture({ 'sub/ok.test.mts': PASSING });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('baseline-status');
  });
});
