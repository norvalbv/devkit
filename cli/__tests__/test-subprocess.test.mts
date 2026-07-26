import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processAlive, rootRegistry, testExecFileSync, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function execTimeoutStatus(
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
): number | null {
  try {
    testExecFileSync(command, args, options);
    return 0;
  } catch (cause) {
    return cause !== null && typeof cause === 'object' && 'status' in cause
      ? Number(cause.status)
      : null;
  }
}

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

  it.each([
    {
      api: 'spawnSync',
      timeoutStatus: (command: string, args: readonly string[], options: Record<string, unknown>) =>
        testSpawnSync(command, args, options).status,
    },
    { api: 'execFileSync', timeoutStatus: execTimeoutStatus },
  ])('$api times out and reaps the command process group', ({ timeoutStatus }) => {
    const root = mkTmp('test-subprocess-');
    const childPidFile = join(root, 'child.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });',
      'writeFileSync(process.argv[1], String(child.pid));',
      'setInterval(() => {}, 1_000);',
    ].join('\n');

    const status = timeoutStatus(process.execPath, ['-e', script, childPidFile], {
      encoding: 'utf8',
      timeout: 250,
    });
    const childPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, 'utf8')) : 0;

    expect(status).toBe(124);
    expect(childPid).toBeGreaterThan(1);
    expect(processAlive(childPid)).toBe(false);
  });
});
