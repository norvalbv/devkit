import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { DEADLINE_NOTICE_ENV } from './test-subprocess.mts';

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

/** The status a supervised run reports, read off the error when the runner's own deadline throws. */
function timeoutStatus(run: () => void): number | null {
  try {
    run();
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
    { api: 'spawnSync', run: testSpawnSync },
    { api: 'execFileSync', run: testExecFileSync },
  ])('$api times out and reaps the command process group', ({ run }) => {
    const root = mkTmp('test-subprocess-');
    const childPidFile = join(root, 'child.pid');

    const status = timeoutStatus(() =>
      run('/bin/sh', ['-c', LEADER_SCRIPT, LEADER_ARGV0, childPidFile], {
        encoding: 'utf8',
        timeout: REAP_DEADLINE_MS,
      }),
    );
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

// A ship test asserting ship's own 124 must not pass, or fail as a banner mismatch, when the
// runner's deadline is what fired: that deadline throws, naming itself and the machine load.
describe("the runner's own deadline is told apart from the command's 124", () => {
  const HARNESS_LABEL =
    /^(testSpawnSync|testExecFileSync): 1s harness deadline fired running \/bin\/sleep 5 \(loadavg=[\d./]+ cpus=\d+\)/;

  it.each([
    { api: 'testSpawnSync', stderr: 'piped', run: testSpawnSync, options: { encoding: 'utf8' } },
    { api: 'testSpawnSync', stderr: 'ignored', run: testSpawnSync, options: { stdio: 'ignore' } },
    {
      api: 'testExecFileSync',
      stderr: 'ignored',
      run: testExecFileSync,
      options: { stdio: 'ignore' },
    },
  ])('$api throws a labelled error with status 124 ($stderr stderr)', ({ api, run, options }) => {
    let thrown: unknown;
    try {
      run('/bin/sleep', ['5'], { ...options, timeout: 1000 });
    } catch (cause) {
      thrown = cause;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(HARNESS_LABEL);
    expect(message.startsWith(`${api}:`)).toBe(true);
    expect(thrown).toMatchObject({ status: 124 });
  });

  // 224 pins that no exit status is reserved to carry the runner's deadline.
  it.each([124, 224])("returns the command's own exit %i unchanged", (status) => {
    const result = testSpawnSync('/bin/sh', ['-c', `exit ${status}`], { encoding: 'utf8' });

    expect(result.status).toBe(status);
  });

  // The label is only useful beside what the wedged command printed, on the message and the field.
  it.each([
    { api: 'testSpawnSync', run: testSpawnSync },
    { api: 'testExecFileSync', run: testExecFileSync },
  ])('$api keeps the stderr the wedged command wrote', ({ run }) => {
    let thrown: unknown;
    try {
      run('/bin/sh', ['-c', 'echo wedge-marker >&2; exec /bin/sleep 5'], {
        encoding: 'utf8',
        timeout: 1000,
      });
    } catch (cause) {
      thrown = cause;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/harness deadline fired[^\n]*\n\nwedge-marker\n$/);
    expect(thrown).toMatchObject({ status: 124, stderr: 'wedge-marker\n' });
  });

  // A clean leader that leaks a live tree is reaped as 124 long before the deadline. That 124 is the
  // runner's but not its deadline, so it stays a status and ship tests keep pairing their banner.
  it('returns the linger reap as a bare 124, not a deadline error', () => {
    const result = testSpawnSync('/bin/sh', ['-c', '/bin/sleep 30 & exit 0'], { encoding: 'utf8' });

    expect(result.status).toBe(124);
  });

  // A TERM-ignoring leak makes the reap settle (~15s) past an 8s deadline it cancelled at 5s, so
  // elapsed time alone would misname it the deadline, whether the leader exited 0 or 124.
  it.each([0, 124])('keeps a late linger reap of a leader exiting %i a bare 124', (exit) => {
    const result = testSpawnSync('/bin/sh', ['-c', `trap "" TERM; /bin/sleep 30 & exit ${exit}`], {
      encoding: 'utf8',
      timeout: 8000,
    });

    expect(result.status).toBe(124);
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

  it("keeps the runner's deadline-notice env out of the supervised command", () => {
    const result = testSpawnSync(
      process.execPath,
      ['-e', `process.stdout.write(String(process.env.${DEADLINE_NOTICE_ENV}))`],
      { encoding: 'utf8' },
    );

    expect(result.stdout).toBe('undefined');
  });

  // The runner's argv is a contract for direct callers such as docs/benchmarks, so the notice
  // stays optional: raw, because the runner itself is the subject.
  it('runs a direct caller that passes no deadline notice', () => {
    const runner = fileURLToPath(new URL('./test-subprocess.mts', import.meta.url));
    const result = spawnSync(process.execPath, [runner, '5000', '--', '/bin/sh', '-c', 'exit 7'], {
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(7);
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
