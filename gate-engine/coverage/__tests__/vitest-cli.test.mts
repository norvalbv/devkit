/**
 * A `--` forwarded to `vitest run` makes vitest ignore every later token, so a scoped run silently
 * becomes the whole suite. Both vitest-forwarding commands must drop it before vitest sees it.
 */
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import testReportRun from '../../../cli/commands/baseline/test-report-run.mts';
import coverageRun from '../../../cli/commands/coverage/run.mts';
import { withoutSeparators } from '../vitest-cli.mts';

describe('withoutSeparators', () => {
  it.each([
    [['--', 'a.test.mts'], ['a.test.mts']],
    [
      ['--project', 'x', '--', 'a.test.mts'],
      ['--project', 'x', 'a.test.mts'],
    ],
    [['--', '--', 'a.test.mts'], ['a.test.mts']],
    [
      ['--project', 'x', 'a.test.mts'],
      ['--project', 'x', 'a.test.mts'],
    ],
  ])('%j → %j', (argv, expected) => {
    expect(withoutSeparators(argv)).toEqual(expected);
  });
});

describe('the commands hand vitest no `--`', () => {
  let root: string;
  let argvFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vitest-separator-'));
    argvFile = join(root, 'argv.json');
    const bin = join(root, 'node_modules', '.bin', 'vitest');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    // Exits 1 on the version probe; otherwise records what it was given and writes no report.
    writeFileSync(
      bin,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) process.exit(1);
require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
`,
    );
    chmodSync(bin, 0o755);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['test-report-run', testReportRun],
    ['coverage-run', coverageRun],
  ])('%s forwards the file filter, not the separator', async (_name, command) => {
    await command(['--', 'a.test.mts'], root);

    const forwarded: string[] = JSON.parse(readFileSync(argvFile, 'utf8'));
    expect(forwarded).toContain('a.test.mts');
    expect(forwarded).not.toContain('--');
  });

  it('still refuses a reserved flag that follows the separator', async () => {
    expect(await testReportRun(['--', '--reporter=json'], root)).toBe(1);
    expect(existsSync(argvFile)).toBe(false);
  });
});
