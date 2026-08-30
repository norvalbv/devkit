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

// Status 124 requires the deadline to be REACHED, not to be short: the leader never exits on its own.
// Sized so the fixture's own registration cannot race it. Costs ~10s per case, since the cap must
// elapse before the supervisor reports 124.
const REAP_DEADLINE_MS = 10_000;
// Must outlast REAP_DEADLINE_MS by enough that a descheduled worker cannot let the grandchild exit
// NATURALLY before the assertion — that would read as a successful reap. Bounded rather than huge:
// if the reap ever regresses this is how long the stray sleep lingers, and killing it by PID
// afterwards is not safe because the number may already have been reused.
const GRANDCHILD_SLEEP_S = 120;
// A backgrounded sleep stays in the leader's process group, so it is reachable ONLY via the
// supervisor's group kill — the topology these assertions depend on.
const LEADER_SCRIPT = `/bin/sleep ${GRANDCHILD_SLEEP_S} & echo $! > "$1"; wait`;
const LEADER_ARGV0 = 'devkit-reap-fixture';

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

    const status = timeoutStatus('/bin/sh', ['-c', LEADER_SCRIPT, LEADER_ARGV0, childPidFile], {
      encoding: 'utf8',
      timeout: REAP_DEADLINE_MS,
    });
    const childPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, 'utf8')) : 0;

    expect(status).toBe(124);
    // Fixture integrity, asserted BEFORE the reaping claim: on a cold-start race childPid is 0, and
    // processAlive(0) signals our OWN process group and returns true — so a broken fixture would
    // have reported the reap as passing. This line is what makes the next one mean anything.
    expect(childPid).toBeGreaterThan(1);
    expect(processAlive(childPid)).toBe(false);
  });
});
