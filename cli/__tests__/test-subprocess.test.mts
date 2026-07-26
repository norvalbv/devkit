import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processAlive, rootRegistry, testExecFileSync, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

describe('supervised synchronous test subprocesses', () => {
  it('preserves command output and natural exit status', () => {
    const result = testSpawnSync(
      process.execPath,
      ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(23)"],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(23);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('throws from execFileSync with the command exit status intact', () => {
    expect(() =>
      testExecFileSync(process.execPath, ['-e', 'process.exit(19)'], { stdio: 'ignore' }),
    ).toThrow(expect.objectContaining({ status: 19 }));
  });

  it('times out and reaps a command process group instead of blocking the Vitest worker', () => {
    const root = mkTmp('test-subprocess-');
    const childPidFile = join(root, 'child.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });',
      'writeFileSync(process.argv[1], String(child.pid));',
      'setInterval(() => {}, 1_000);',
    ].join('\n');

    const result = testSpawnSync(process.execPath, ['-e', script, childPidFile], {
      encoding: 'utf8',
      timeout: 250,
    });
    const childPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, 'utf8')) : 0;

    expect(result.status, result.stderr).toBe(124);
    expect(childPid).toBeGreaterThan(1);
    expect(processAlive(childPid)).toBe(false);
  });
});
