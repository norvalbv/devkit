import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { superviseGateCommand } from '../lib/ship/review/process/gate-supervisor.mts';
import {
  processAlive,
  rootRegistry,
  supervisedCommand,
  TEST_SUBPROCESS_CLEANUP_MS,
  TEST_SUBPROCESS_TIMEOUT_MS,
  testExecFileSync,
  testSpawnSync,
  waitForPath,
} from './_helpers.mts';

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

// `shell` names how the SUPERVISED command runs. Forwarded to the supervisor's OWN invocation it
// made Node join that argv into one unquoted shell string, so the absolute path of
// `test-subprocess.mts` split on its first space and the run died with
// `Cannot find module '/Users/benji/Desktop/Personal'`. Asserted on the argv rather than by running
// a command, because every CI checkout sits at a space-free path where the bug cannot reproduce.
describe('the shell option applies to the supervised command, not the supervisor', () => {
  it('wraps the inner command and drops shell from the supervisor invocation', () => {
    const { args, options } = supervisedCommand('command', ['-v', 'git'], {
      shell: true,
      encoding: 'utf8',
    });

    expect(options.shell, 'shell must never reach the supervisor invocation').toBeUndefined();
    expect(options.encoding, 'unrelated options still pass through').toBe('utf8');
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'command -v git']);
  });

  it('honours an explicit shell path', () => {
    const { args } = supervisedCommand('echo', ['hi'], { shell: '/bin/bash' });

    expect(args.slice(-3)).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  it('leaves a shell-less call as a plain argv', () => {
    const { args, options } = supervisedCommand('git', ['status'], { encoding: 'utf8' });

    expect(args.slice(-2)).toEqual(['git', 'status']);
    expect(options.shell).toBeUndefined();
  });
});

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

  // A bare 124 says something timed out, not which command, so the argv must survive into the
  // throw. See docs/decisions/suite-hangs-bound-at-the-spawn-site.md (sc-2393).
  it('names the blocked command in the timeout it throws', () => {
    const root = mkTmp('test-subprocess-');
    const childPidFile = join(root, 'child.pid');

    let thrown: unknown;
    try {
      testExecFileSync('/bin/sh', ['-c', LEADER_SCRIPT, LEADER_ARGV0, childPidFile], {
        encoding: 'utf8',
        timeout: REAP_DEADLINE_MS,
      });
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown, 'a wedged command must not resolve as success').toBeDefined();
    expect(thrown).toMatchObject({ status: 124 });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message, 'the reader must be able to identify the wedged command').toContain(
      LEADER_ARGV0,
    );
  });
});

// Contracts the call sites moved onto this boundary depend on, none of which was pinned before.
// See docs/decisions/suite-hangs-bound-at-the-spawn-site.md (sc-2393).
describe('option passthrough the supervised call sites depend on', () => {
  it('forwards stdin to the supervised command, not to the supervisor', () => {
    const result = testSpawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(require("node:fs").readFileSync(0, "utf8").toUpperCase())'],
      { encoding: 'utf8', input: 'refs/heads/main\n' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('REFS/HEADS/MAIN\n');
  });

  it('runs the supervised command in the requested cwd', () => {
    const root = realpathSync(mkTmp('test-subprocess-cwd-'));
    const result = testSpawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: root,
      encoding: 'utf8',
    });

    // Not merely "not the supervisor's cwd": a fixture that silently ran in devkit's OWN checkout
    // is the hazard vitest.setup.mjs already strips GIT_DIR to prevent, so pin the exact directory.
    expect(result.stdout).toBe(root);
    expect(result.stdout).not.toBe(process.cwd());
  });

  it("reaches the supervised command with the caller's env, not the runner's", () => {
    const result = testSpawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.DEVKIT_ENV_PROBE))'],
      { encoding: 'utf8', env: { ...process.env, DEVKIT_ENV_PROBE: 'from-the-caller' } },
    );

    expect(result.stdout).toBe('from-the-caller');
    expect(process.env.DEVKIT_ENV_PROBE, 'the probe must not leak into the runner').toBeUndefined();
  });

  it.each([
    { label: 'zero', timeout: 0 },
    { label: 'negative', timeout: -1 },
  ])('falls back to the default deadline for a $label timeout', ({ timeout }) => {
    // Asserted on the argv, where the resolved deadline is observable without waiting 90s.
    const { args, options } = supervisedCommand('true', [], { timeout });

    expect(args).toContain(String(TEST_SUBPROCESS_TIMEOUT_MS));
    expect(options.timeout).toBe(TEST_SUBPROCESS_TIMEOUT_MS + TEST_SUBPROCESS_CLEANUP_MS);
  });

  // setTimeout clamps past 2^31-1 ms to 1ms, which inverted a huge deadline into an instant 124.
  // See docs/decisions/suite-hangs-bound-at-the-spawn-site.md (sc-2393).
  it.each([
    { label: 'MAX_SAFE_INTEGER', timeout: Number.MAX_SAFE_INTEGER },
    { label: 'one past the 32-bit timer ceiling', timeout: 2_147_483_648 },
  ])(
    'refuses a $label deadline instead of inverting it into an instant 124',
    async ({ timeout }) => {
      await expect(superviseGateCommand(timeout, ['/bin/sh', '-c', 'exit 0'])).rejects.toThrow(
        /deadline/i,
      );
    },
  );

  // The cap is INCLUSIVE: regression-proof.mts supervises with exactly this number, so a `>=`
  // would refuse the one production caller sitting on the boundary.
  it('accepts a deadline exactly at the 32-bit timer ceiling', async () => {
    await expect(superviseGateCommand(2_147_483_647, ['/bin/sh', '-c', 'exit 0'])).resolves.toBe(0);
  });
});

describe('waitForPath with the child expected to write the path', () => {
  // The timeout message never says "exited 3", so matching it proves the fail-fast path.
  it('fails as soon as the child exits, quoting its stderr', async () => {
    const child = spawn('/bin/sh', ['-c', 'echo boom >&2; exit 3'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const never = join(mkTmp('test-subprocess-wait-'), 'never');
    await expect(waitForPath(never, 60_000, child)).rejects.toThrow(/child exited 3\nboom/);
  });

  // Exit 0 is falsy: a truthiness check would miss a clean early exit and wait out the timeout.
  it('fails on a clean exit that happened before the wait began', async () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await once(child, 'exit');
    const never = join(mkTmp('test-subprocess-wait-'), 'never');
    await expect(waitForPath(never, 60_000, child)).rejects.toThrow(/child exited 0/);
  });

  // The exit state is read before the path: this child writes the path just as its exit is read.
  it('resolves when the child wrote the path in the same instant it exited', async () => {
    const path = join(mkTmp('test-subprocess-wait-'), 'ready');
    const child = Object.defineProperty(new ChildProcess(), 'exitCode', {
      get: () => {
        writeFileSync(path, 'ready');
        return 0;
      },
    });
    await expect(waitForPath(path, 60_000, child)).resolves.toBeUndefined();
  });

  // Exit is observable before stderr drains, so the rejection waits for the pipe to close.
  it('waits for stderr to drain before quoting it', async () => {
    const stderr = new PassThrough();
    const child = Object.defineProperties(new ChildProcess(), {
      exitCode: { value: 4 },
      stderr: { value: stderr },
    });
    const never = join(mkTmp('test-subprocess-wait-'), 'never');
    const waiting = waitForPath(never, 60_000, child);
    setTimeout(() => stderr.end('root-cause\n'), 50);
    await expect(waiting).rejects.toThrow(/child exited 4\nroot-cause\n$/);
  });

  // Only a tail is kept, so a flooding child cannot exhaust the worker; the final line survives.
  it('reports a bounded stderr tail that still ends with the final line', async () => {
    const child = spawn(
      '/bin/sh',
      ['-c', 'yes x | head -c 1000000 >&2; echo root-cause >&2; exit 4'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const never = join(mkTmp('test-subprocess-wait-'), 'never');
    const waiting = waitForPath(never, 60_000, child);
    await expect(waiting).rejects.toThrow(/child exited 4\n[\s\S]*root-cause\n$/);
    await expect(waiting).rejects.toThrow(/^[\s\S]{1,70000}$/);
  });

  // An unread stderr pipe fills at the OS buffer size and blocks the child before it can exit.
  it('consumes the piped stderr, so a child that floods it can still exit', async () => {
    const path = join(mkTmp('test-subprocess-wait-'), 'ready');
    const child = spawn(
      '/bin/sh',
      ['-c', 'echo ready > "$1"; head -c 1000000 /dev/zero >&2', 'sh', path],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const exited = once(child, 'exit');
    await waitForPath(path, 60_000, child);
    await expect(exited).resolves.toEqual([0, null]);
  });
});
