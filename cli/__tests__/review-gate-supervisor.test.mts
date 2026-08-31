import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { superviseGateCommand } from '../lib/ship/review/process/gate-supervisor.mts';
import {
  findModernBash,
  processAlive,
  rootRegistry,
  testSpawnSync as spawnSync,
  waitForPath,
} from './_helpers.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(HERE, '../lib/ship/review/process/gate-supervisor.mts');
const GATE_RUNNER = join(HERE, '../lib/ship/run-gates-with-capture.sh');
const HANDOFF = join(HERE, '../lib/ship/review/process/gate-signal-handoff.sh');
const { mkTmp, cleanup } = rootRegistry();
const SIGNAL_RECORDER_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  'const [ready, signalFile] = process.argv.slice(1);',
  "for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {",
  '  process.on(signal, () => { writeFileSync(signalFile, signal); process.exit(0); });',
  '}',
  "writeFileSync(ready, 'ready');",
  'setInterval(() => {}, 1_000);',
].join('\n');

afterEach(cleanup);

function supervisor(...args: string[]) {
  return spawnSync(process.execPath, [SUPERVISOR, ...args], { encoding: 'utf8' });
}

// 30s, not 5s. These are CEILINGS, not delays — every wait resolves on its event, so a healthy run
// is exactly as fast as before and only a load-starved one spends the extra budget. vitest.config.mjs
// already raised testTimeout to 120s for this repo for precisely this reason ("on a box at load
// ~50-70 … clipped 2-4 DIFFERENT tests each run … always a timeout, never an assertion, and every one
// passes in isolation"), but these test-local budgets were left at 5s and so became the new binding
// constraint — reintroducing the same false redness one layer down. This file already had the
// workaround applied piecemeal: several call sites below pass an explicit 15_000. One budget in one
// place replaces that. A genuine hang still fails here, with a specific message, well inside the 120s.
const WAIT_MS = 30_000;

function waitForExit(child: ChildProcess, timeoutMs = WAIT_MS): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('supervisor test process did not exit')),
      timeoutMs,
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

interface InspectedProcess {
  pid: number;
  parentPid: number;
  groupId: number;
  identity: string;
  ownershipToken: boolean;
}

function fixturePid(path: string): number {
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
}

function fixtureProcessAlive(pid: number): boolean {
  return pid > 1 && processAlive(pid);
}

function addInspectedProcess(
  table: Map<number, InspectedProcess>,
  alive: boolean,
  record: InspectedProcess,
): void {
  if (alive) table.set(record.pid, record);
}

function orphanedFixtureChild(
  leaderPid: number,
  leaderAlive: boolean,
  childAlive: boolean,
): boolean {
  return leaderPid > 1 && !leaderAlive && childAlive;
}

function markFixtureInspected(
  leaderAlive: boolean,
  childPid: number,
  childReady: string,
  inspected: string,
): void {
  if (!leaderAlive || childPid <= 1) return;
  if (!existsSync(childReady) || existsSync(inspected)) return;
  writeFileSync(inspected, 'inspected');
}

function signalFixture(root: string): {
  script: string;
  leaderReady: string;
  descendantReady: string;
  leaderSignal: string;
  descendantSignal: string;
} {
  const script = join(root, 'signal-fixture.mjs');
  const leaderReady = join(root, 'leader-ready');
  const descendantReady = join(root, 'descendant-ready');
  const leaderSignal = join(root, 'leader-signal');
  const descendantSignal = join(root, 'descendant-signal');
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const [leaderReady, descendantReady, leaderSignal, descendantSignal] = process.argv.slice(2);',
      `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(SIGNAL_RECORDER_SOURCE)}, descendantReady, descendantSignal], { stdio: 'inherit' });`,
      "for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {",
      '  process.on(signal, () => { writeFileSync(leaderSignal, signal); process.exit(0); });',
      '}',
      'const ready = setInterval(() => {',
      '  if (!existsSync(descendantReady)) return;',
      '  clearInterval(ready);',
      "  writeFileSync(leaderReady, 'ready');",
      '}, 5);',
      'setInterval(() => {}, 1_000);',
    ].join('\n'),
  );
  return { script, leaderReady, descendantReady, leaderSignal, descendantSignal };
}

// A leader that spawns a descendant sharing its stdio, then exits — leaving the gate's output pipe
// held open by a process the supervisor must find and reap. `exitCode` picks which half of the
// linger contract is under test: 0 (a "clean" leader that leaked) or non-zero (a gate rejection).
function backgroundFixture(
  root: string,
  exitCode = 0,
): { script: string; ready: string; signal: string } {
  const script = join(root, `background-fixture-${exitCode}.mjs`);
  const ready = join(root, `background-ready-${exitCode}`);
  const signal = join(root, `background-signal-${exitCode}`);
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { existsSync } from 'node:fs';",
      'const [ready, signalFile] = process.argv.slice(2);',
      `const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(SIGNAL_RECORDER_SOURCE)}, ready, signalFile], { stdio: 'inherit' });`,
      'child.unref();',
      'const check = setInterval(() => {',
      '  if (!existsSync(ready)) return;',
      '  clearInterval(check);',
      `  process.exit(${exitCode});`,
      '}, 5);',
    ].join('\n'),
  );
  return { script, ready, signal };
}

function detachedCrashFixture(root: string) {
  const script = join(root, 'detached-crash-fixture.mjs');
  const paths = Object.fromEntries(
    ['leaderReady', 'childReady', 'leaderPid', 'childPid', 'leaderSignal', 'childSignal'].map(
      (name) => [name, join(root, name)],
    ),
  ) as Record<
    'leaderReady' | 'childReady' | 'leaderPid' | 'childPid' | 'leaderSignal' | 'childSignal',
    string
  >;
  const childSource = [
    "import { writeFileSync } from 'node:fs';",
    'const [ready, pid, signalFile] = process.argv.slice(1);',
    'writeFileSync(pid, String(process.pid));',
    "process.on('SIGTERM', () => { writeFileSync(signalFile, 'SIGTERM'); process.exit(0); });",
    "writeFileSync(ready, 'ready');",
    'setInterval(() => {}, 1_000);',
  ].join('\n');
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const [leaderReady, childReady, leaderPid, childPid, leaderSignal, childSignal] = process.argv.slice(2);',
      'writeFileSync(leaderPid, String(process.pid));',
      `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childSource)}, childReady, childPid, childSignal], { detached: true, stdio: 'ignore' }).unref();`,
      "process.on('SIGTERM', () => { writeFileSync(leaderSignal, 'SIGTERM'); process.exit(0); });",
      'const poll = setInterval(() => {',
      '  if (!existsSync(childReady)) return;',
      '  clearInterval(poll);',
      "  writeFileSync(leaderReady, 'ready');",
      '}, 5);',
      'setInterval(() => {}, 1_000);',
    ].join('\n'),
  );
  return { script, ...paths };
}

function gateHarness(
  root: string,
  mode: 'review' | 'ship',
  seconds: string,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const log = join(root, 'gate.log');
  const progress = join(root, 'progress.json');
  const shell = [
    'set -euo pipefail',
    'source "$1"',
    'shift',
    'mode=$1; seconds=$2; root=$3; log=$4; progress=$5',
    'shift 5',
    'DEVKIT_RUN_MODE="$mode" SHIP_COMMIT_TIMEOUT="$seconds" run_gates_with_capture "$root" "$root" gate "$log" "$progress" -- "$@"',
  ].join('\n');
  return spawnSync(
    '/bin/bash',
    ['-c', shell, 'review-gate-test', GATE_RUNNER, mode, seconds, root, log, progress, ...command],
    { encoding: 'utf8', env },
  );
}

function outerReviewWrapper(root: string, command: string[], env: NodeJS.ProcessEnv = process.env) {
  const wrapper = join(root, 'outer-review-wrapper.sh');
  const identityFile = join(root, 'supervisor.identity');
  const log = join(root, 'outer-gate.log');
  const progress = join(root, 'outer-progress.json');
  writeFileSync(
    wrapper,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'gate_runner=$1; root=$2; identity_file=$3; log=$4; progress=$5',
      'shift 5',
      'source "$gate_runner"',
      'supervisor_pid=',
      'signal_status=0',
      'review_gate_started() {',
      '  supervisor_pid=$1',
      '  supervisor_parent=$(/bin/ps -o ppid= -p "$supervisor_pid" | tr -d " ")',
      '  printf "%s %s %s\\n" "$$" "$supervisor_parent" "$supervisor_pid" > "$identity_file"',
      '}',
      'review_gate_reaped() { supervisor_pid=; }',
      'review_gate_finished() { supervisor_pid=; }',
      'forward_signal() {',
      '  local signal=$1 status=$2',
      '  [ "$signal_status" -ne 0 ] || signal_status=$status',
      '  [ -z "$supervisor_pid" ] || kill -s "$signal" "$supervisor_pid" 2>/dev/null || true',
      '}',
      "trap 'forward_signal HUP 129' HUP",
      "trap 'forward_signal INT 130' INT",
      "trap 'forward_signal QUIT 131' QUIT",
      "trap 'forward_signal TERM 143' TERM",
      'export DEVKIT_RUN_MODE=review',
      'export SHIP_COMMIT_TIMEOUT=30',
      'set +e',
      'if run_gates_with_capture "$root" "$root" gate "$log" "$progress" -- "$@"; then rc=0; else rc=$?; fi',
      '[ "$signal_status" -eq 0 ] || rc=$signal_status',
      'set -e',
      'exit "$rc"',
    ].join('\n'),
  );
  return {
    identityFile,
    child: spawn(
      '/bin/bash',
      [wrapper, GATE_RUNNER, root, identityFile, log, progress, ...command],
      { env, stdio: 'ignore' },
    ),
  };
}

// bash >= 4 reports 128+signum from a `wait` that a pending trap interrupted, without collecting the
// job; bash 3.2 collects on the first read. The resolver lives in _helpers.mts — ship-branch's
// empty-array expansions split on the same version boundary and need the identical probe.
const MODERN_BASH = findModernBash();

// Ship-shaped on purpose: only ship sets GATE_SIGNAL_DEFER_EXIT, and without it forward_gate_signal
// exits inside the trap so the drain wait is never reached. Reports the runner's rc as data on stdout
// instead of exiting with it — masking rc is what let sc-1711 ship.
interface DeferredSignalOptions {
  teeExit?: number;
  signal?: string;
  // 'parent' signals the runner's shell (the sc-1711 window); 'self' makes tee die of the signal.
  target?: 'parent' | 'self';
  // Defaults to the real runner; a stripped copy proves the interrupted read actually happened.
  runner?: string;
}

// Builds a copy of the runner with the sc-1711 re-read deleted, so a test can prove the interrupted
// read really happened: the pre-fix copy must FAIL on the same run that the real one passes. This is
// the only honest observable available. Instrumenting the runner's own `wait` (shadowing the builtin
// to log each status) was tried and DESTROYS the phenomenon — the extra function call gives bash a
// chance to service the pending trap, so the read returns tee's status and the window silently
// closes. Sibling paths are symlinked because the runner resolves the supervisor and the progress
// reader relative to BASH_SOURCE.
function runnerWithoutReread(root: string): string {
  const shipDir = join(root, 'prefix/cli/lib/ship');
  mkdirSync(shipDir, { recursive: true });
  symlinkSync(join(HERE, '../lib/ship/review'), join(shipDir, 'review'));
  symlinkSync(join(HERE, '../../gate-engine'), join(root, 'prefix/gate-engine'));
  const source = readFileSync(GATE_RUNNER, 'utf8');
  const stripped = source.replace(
    /\n *if \[ "\$drain_stage" -eq 0 \] && \[ "\$tee_status" -gt 128 \]; then\n[\s\S]*?\n *fi\n/,
    '\n',
  );
  // Fail loudly rather than silently comparing a runner against itself.
  if (stripped === source) throw new Error('could not strip the re-read — the guard shape changed');
  const path = join(shipDir, 'run-gates-with-capture.sh');
  writeFileSync(path, stripped);
  return path;
}

function deferredSignalGateHarness(root: string, options: DeferredSignalOptions = {}) {
  const { teeExit = 0, signal = 'TERM', target = 'parent', runner = GATE_RUNNER } = options;
  const bin = join(root, 'bin');
  const log = join(root, 'gate.log');
  const progress = join(root, 'progress.json');
  mkdirSync(bin, { recursive: true });
  // Resolved, not hardcoded: tee is not at /usr/bin on every distro, and a stub that cannot find the
  // real binary reddens for the wrong reason. Same lookup ship-branch.test.mts uses.
  const realTee = execFileSync('/bin/sh', ['-c', 'command -v tee'], { encoding: 'utf8' }).trim();
  const kill = target === 'parent' ? `kill -${signal} "$PPID"` : `kill -${signal} $$`;
  writeFileSync(join(bin, 'tee'), `#!/bin/sh\n"$REAL_TEE" "$@"\n${kill}\nexit ${teeExit}\n`);
  chmodSync(join(bin, 'tee'), 0o755);
  const shell = [
    'set -euo pipefail',
    'gate_runner=$1; handoff=$2; root=$3; log=$4; progress=$5',
    'shift 5',
    'source "$gate_runner"',
    'source "$handoff"',
    // init BEFORE arming: it resets GATE_SIGNAL_DEFER_EXIT, so the reverse order tests review.
    'gate_signal_handoff_init',
    'GATE_SIGNAL_DEFER_EXIT=1',
    'export DEVKIT_RUN_MODE=ship SHIP_COMMIT_TIMEOUT=30',
    'if run_gates_with_capture "$root" "$root" gate "$log" "$progress" -- "$@"; then rc=0; else rc=$?; fi',
    'printf "RUNNER_RC=%s\\n" "$rc"',
    'printf "SIGNAL_STATUS=%s\\n" "$REQUESTED_SIGNAL_STATUS"',
    'exit 0',
  ].join('\n');
  const result = spawnSync(
    MODERN_BASH ?? 'bash',
    [
      '-c',
      shell,
      'pending-trap-test',
      runner,
      HANDOFF,
      root,
      log,
      progress,
      process.execPath,
      '-e',
      'console.log("pending-trap gate output")',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        REAL_TEE: realTee,
      },
    },
  );
  return { ...result, log };
}

describe('review gate supervisor', () => {
  it('streams the command output and returns its status', () => {
    const result = supervisor(
      '5',
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('stdout-marker'); process.stderr.write('stderr-marker'); process.exit(23)",
    );

    expect(result.status, result.stderr).toBe(23);
    expect(result.stdout).toContain('stdout-marker');
    expect(result.stderr).toContain('stderr-marker');
  });

  // sc-2088: the deferred checklist recovery decides whether to start a judge by reading this
  // deadline. Nothing else publishes it, so if the supervisor stops exporting it the recovery
  // silently falls back to a duration it measures from the WRONG origin (the review gate's start,
  // blind to the deterministic prefix the supervisor's own clock already counted).
  it('publishes an absolute deadline to the child that matches the timer it arms', () => {
    const before = Date.now();
    const result = supervisor(
      '30',
      '--',
      process.execPath,
      '-e',
      "process.stdout.write(String(process.env.DEVKIT_GATE_DEADLINE_MS ?? 'ABSENT'))",
    );
    const after = Date.now();

    expect(result.status, result.stderr).toBe(0);
    const published = Number(result.stdout.trim());
    expect(Number.isFinite(published)).toBe(true);
    // An ABSOLUTE epoch, not the 30 it was handed as a duration — a duration is exactly what the
    // downstream phase cannot use, since it cannot see when the chain started.
    expect(published).toBeGreaterThanOrEqual(before + 30_000);
    expect(published).toBeLessThanOrEqual(after + 30_000);
  });

  it('returns 127 when the command cannot be spawned', () => {
    const result = supervisor('5', '--', join(mkTmp('devkit-review-missing-'), 'absent'));

    expect(result.status, result.stderr).toBe(127);
  });

  it.each([124, 129, 130, 131, 143])(
    'normalizes a natural reserved exit %d to an ordinary rejection',
    (status) => {
      const result = supervisor('5', '--', process.execPath, '-e', `process.exit(${status})`);

      expect(result.status, result.stderr).toBe(1);
    },
  );

  it('can preserve a natural reserved exit for the synchronous test-process boundary', async () => {
    await expect(
      superviseGateCommand(
        5_000,
        [process.execPath, '-e', 'process.exit(124)'],
        undefined,
        undefined,
        false,
      ),
    ).resolves.toBe(124);
  });

  it('returns 124 and terminates the complete command group on timeout', () => {
    const fixture = signalFixture(mkTmp('devkit-review-timeout-'));
    const result = supervisor(
      '5',
      '--',
      process.execPath,
      fixture.script,
      fixture.leaderReady,
      fixture.descendantReady,
      fixture.leaderSignal,
      fixture.descendantSignal,
    );

    expect(result.status, result.stderr).toBe(124);
    expect(readFileSync(fixture.leaderSignal, 'utf8')).toBe('SIGTERM');
    expect(readFileSync(fixture.descendantSignal, 'utf8')).toBe('SIGTERM');
  });

  it('reaps a pipe-holding descendant once the command leader exits clean', () => {
    const fixture = backgroundFixture(mkTmp('devkit-review-background-'));
    const started = Date.now();
    // 600s, not 5s: the ceiling must be far enough out that a 124 here can ONLY have come from the
    // post-leader-exit reap. Under the old behaviour this test passed by WAITING for expiry, which
    // is exactly the bug — on a ship the ceiling is an hour (sc-1199).
    const result = supervisor(
      '600',
      '--',
      process.execPath,
      fixture.script,
      fixture.ready,
      fixture.signal,
    );

    expect(result.status, result.stderr).toBe(124);
    expect(readFileSync(fixture.signal, 'utf8')).toBe('SIGTERM');
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
  });

  it('preserves a non-zero leader status while reaping its lingering descendant', () => {
    const fixture = backgroundFixture(mkTmp('devkit-review-rejection-'), 1);
    const started = Date.now();
    const result = supervisor(
      '600',
      '--',
      process.execPath,
      fixture.script,
      fixture.ready,
      fixture.signal,
    );

    // The load-bearing assertion of sc-1199: a gate that REJECTED must still report its rejection.
    // Reporting 124 here would tell a shipping agent "re-run to converge" for a verdict that will
    // never converge on its own, and would mis-tag the ship telemetry as a timeout.
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(fixture.signal, 'utf8')).toBe('SIGTERM');
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
  });

  it.each([
    ['while its leader remains active', 'stay'],
    ['after its descendant reports ready', 'ready'],
    ['when its leader exits immediately after spawning', 'immediate'],
  ])('terminates an escaped session %s', (_scenario, leaderExit) => {
    const root = mkTmp('devkit-review-detached-timeout-');
    const script = join(root, 'detached-fixture.mjs');
    const childPid = join(root, 'detached.pid');
    const childReady = join(root, 'detached.ready');
    const childSignal = join(root, 'detached.signal');
    const childSource = [
      "import { writeFileSync } from 'node:fs';",
      'const [pidFile, readyFile, signalFile] = process.argv.slice(1);',
      "writeFileSync(pidFile, String(process.pid) + '\\n');",
      "process.on('SIGTERM', () => { writeFileSync(signalFile, 'SIGTERM'); process.exit(0); });",
      "writeFileSync(readyFile, 'ready');",
      'setInterval(() => {}, 1_000);',
    ].join('\n');
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { existsSync } from 'node:fs';",
        `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childSource)}, ...process.argv.slice(2, 5)], { detached: true, stdio: 'ignore' }).unref();`,
        "if (process.argv[5] === 'immediate') process.exit(0);",
        "if (process.argv[5] === 'ready') {",
        '  const poll = setInterval(() => {',
        '    if (!existsSync(process.argv[3])) return;',
        '    clearInterval(poll);',
        '    process.exit(0);',
        '  }, 5);',
        '}',
        'setInterval(() => {}, 1_000);',
      ].join('\n'),
    );

    const result = supervisor(
      '3',
      '--',
      process.execPath,
      script,
      childPid,
      childReady,
      childSignal,
      leaderExit,
    );
    const pid = Number(readFileSync(childPid, 'utf8').trim());
    try {
      expect(result.status, result.stderr).toBe(124);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(readFileSync(childSignal, 'utf8')).toBe('SIGTERM');
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });

  // macOS returns EPERM — not ESRCH — from kill(-pgid, sig) while it is still reaping that group's
  // members. The liveness probe already tolerated that window; a REAL signal landing in it threw, and
  // the throw settles the supervisor at 1. Latent while only `devkit review` was supervised; once ship
  // joined (sc-1199) it started failing commits that had already landed with every gate green — 39 of
  // 40 supervised runs took EPERM on the group SIGTERM under parallel load. Injected here rather than
  // raced, so the guarantee is deterministic on every platform.
  it('treats EPERM from a group signal as a group mid-reap, not a supervisor failure', async () => {
    const realKill = process.kill.bind(process);
    let injected = 0;
    process.kill = ((pid: number, signal?: string | number) => {
      // Only group signals (negative pid), and never the `0` liveness probe — that path was already
      // tolerant, so intercepting it would test the wrong half.
      if (pid < 0 && signal !== 0 && injected < 3) {
        injected += 1;
        const error: NodeJS.ErrnoException = new Error('kill EPERM');
        error.code = 'EPERM';
        throw error;
      }
      return realKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;

    try {
      // A 10ms ceiling forces cleanup immediately, so the group SIGTERM — the call that used to throw
      // — happens while the injection is armed. Expiry must still report 124, not a rejection or 1.
      await expect(superviseGateCommand(10, ['/bin/sleep', '1'])).resolves.toBe(124);
    } finally {
      process.kill = realKill;
    }
    expect(injected, 'the EPERM injection never fired — the test proved nothing').toBeGreaterThan(
      0,
    );
  });

  it('refuses to launch target code when its process inspector fails preflight', async () => {
    const root = mkTmp('devkit-review-inspection-preflight-');
    const marker = join(root, 'target-ran');
    const outcome = superviseGateCommand(
      30_000,
      [process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1], 'ran')`, marker],
      () => {
        throw new Error('preflight inspection unavailable');
      },
    );

    await expect(outcome).rejects.toThrow(/preflight inspection unavailable/);
    expect(existsSync(marker)).toBe(false);
  });

  it('kills a recorded detached descendant before rejecting an exit-time inspection failure', async () => {
    const root = mkTmp('devkit-review-detached-inspection-failure-');
    const script = join(root, 'detached-inspection-fixture.mjs');
    const leaderPidFile = join(root, 'leader.pid');
    const childPidFile = join(root, 'child.pid');
    const childReady = join(root, 'child.ready');
    const inspected = join(root, 'inspected');
    const childSignal = join(root, 'child.signal');
    const childSource = [
      "import { writeFileSync } from 'node:fs';",
      'const [pidFile, readyFile, signalFile] = process.argv.slice(1);',
      'writeFileSync(pidFile, String(process.pid));',
      "process.on('SIGTERM', () => { writeFileSync(signalFile, 'SIGTERM'); process.exit(0); });",
      "writeFileSync(readyFile, 'ready');",
      'setInterval(() => {}, 1_000);',
    ].join('\n');
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        'const [leaderPid, childPid, childReady, inspected, childSignal] = process.argv.slice(2);',
        'writeFileSync(leaderPid, String(process.pid));',
        `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childSource)}, childPid, childReady, childSignal], { detached: true, stdio: 'ignore' }).unref();`,
        'const poll = setInterval(() => {',
        '  if (!existsSync(childReady) || !existsSync(inspected)) return;',
        '  clearInterval(poll);',
        '  process.exit(0);',
        '}, 5);',
      ].join('\n'),
    );

    let failedAfterLeaderExit = false;
    const inspect = (ownershipMarker?: string) => {
      const table = new Map<number, InspectedProcess>();
      const leaderPid = fixturePid(leaderPidFile);
      const childPid = fixturePid(childPidFile);
      const leaderAlive = fixtureProcessAlive(leaderPid);
      const childAlive = fixtureProcessAlive(childPid);
      if (orphanedFixtureChild(leaderPid, leaderAlive, childAlive)) {
        failedAfterLeaderExit = true;
        throw new Error('exit-time inspection unavailable');
      }
      addInspectedProcess(table, leaderAlive, {
        pid: leaderPid,
        parentPid: process.pid,
        groupId: leaderPid,
        identity: `leader-${leaderPid}`,
        ownershipToken: Boolean(ownershipMarker),
      });
      addInspectedProcess(table, childAlive, {
        pid: childPid,
        parentPid: leaderAlive ? leaderPid : 1,
        groupId: childPid,
        identity: `child-${childPid}`,
        ownershipToken: Boolean(ownershipMarker),
      });
      markFixtureInspected(leaderAlive, childPid, childReady, inspected);
      return table;
    };
    const outcome = superviseGateCommand(
      30_000,
      [process.execPath, script, leaderPidFile, childPidFile, childReady, inspected, childSignal],
      inspect,
    );

    let childPid = 0;
    try {
      await expect(outcome).rejects.toThrow(/exit-time inspection unavailable/);
      childPid = Number(readFileSync(childPidFile, 'utf8'));
      expect(failedAfterLeaderExit).toBe(true);
      expect(processAlive(childPid)).toBe(false);
      expect(readFileSync(childSignal, 'utf8')).toBe('SIGTERM');
    } finally {
      if (childPid > 1 && processAlive(childPid)) process.kill(childPid, 'SIGKILL');
    }
  });

  it('kills the root group before reporting a forced process-inspection failure', async () => {
    const root = mkTmp('devkit-review-inspection-failure-');
    const script = join(root, 'long-running.mjs');
    const pidFile = join(root, 'child.pid');
    writeFileSync(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1_000);",
    );
    const existingHandlers = new Set(process.listeners('SIGTERM'));
    let failNextInspection = false;
    const outcome = superviseGateCommand(30_000, [process.execPath, script, pidFile], () => {
      if (!failNextInspection) return new Map();
      failNextInspection = false;
      throw new Error('inspection unavailable');
    });
    const settled = outcome.then(
      (status) => ({ status: 'fulfilled' as const, value: status }),
      (cause: unknown) => ({ status: 'rejected' as const, cause }),
    );
    const forceTermination = process
      .listeners('SIGTERM')
      .find((handler) => !existingHandlers.has(handler));

    try {
      expect(forceTermination).toBeTypeOf('function');
      await waitForPath(pidFile);
      failNextInspection = true;
      forceTermination?.();

      const result = await settled;
      if (result.status === 'fulfilled') {
        throw new Error(`expected process inspection to fail, received status ${result.value}`);
      }
      expect(result.cause).toBeInstanceOf(Error);
      expect((result.cause as Error).message).toMatch(/inspection unavailable/);
      expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
    } finally {
      forceTermination?.();
      await settled;
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
        } catch {}
      }
    }
  });

  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGQUIT', 131],
    ['SIGTERM', 143],
  ] as const)('forwards %s to the command group and returns %d', async (signal, status) => {
    const fixture = signalFixture(mkTmp(`devkit-review-${signal.toLowerCase()}-`));
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR,
        '30',
        '--',
        process.execPath,
        fixture.script,
        fixture.leaderReady,
        fixture.descendantReady,
        fixture.leaderSignal,
        fixture.descendantSignal,
      ],
      { stdio: 'ignore' },
    );

    try {
      await waitForPath(fixture.leaderReady);
      child.kill(signal);
      expect(await waitForExit(child)).toBe(status);
      // The supervisor exiting does NOT mean the signalled processes have finished writing: it
      // signals the group and reaps, while each child's handler runs and writes independently.
      // Reading straight after the exit is a race whose loser is a bare ENOENT from readFileSync —
      // a confusing failure that looks nothing like the ordering bug it actually is. Wait for the
      // artefacts, then assert on them.
      await waitForPath(fixture.leaderSignal);
      await waitForPath(fixture.descendantSignal);
      expect(readFileSync(fixture.leaderSignal, 'utf8')).toBe('SIGTERM');
      expect(readFileSync(fixture.descendantSignal, 'utf8')).toBe('SIGTERM');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('hands an outer-wrapper signal to the supervisor and preserves its status', async () => {
    const root = mkTmp('devkit-review-outer-signal-');
    const fixture = signalFixture(root);
    const command = [
      process.execPath,
      fixture.script,
      fixture.leaderReady,
      fixture.descendantReady,
      fixture.leaderSignal,
      fixture.descendantSignal,
    ];
    const wrapped = outerReviewWrapper(root, command);

    try {
      await waitForPath(fixture.leaderReady);
      await waitForPath(wrapped.identityFile);
      const [wrapperPid, supervisorParent, supervisorPid] = readFileSync(
        wrapped.identityFile,
        'utf8',
      )
        .trim()
        .split(' ');
      expect(supervisorParent).toBe(wrapperPid);
      wrapped.child.kill('SIGTERM');
      expect(await waitForExit(wrapped.child)).toBe(143);
      expect(readFileSync(fixture.leaderSignal, 'utf8')).toBe('SIGTERM');
      expect(readFileSync(fixture.descendantSignal, 'utf8')).toBe('SIGTERM');
      expect(() => process.kill(Number(supervisorPid), 0)).toThrow();
    } finally {
      if (wrapped.child.exitCode === null) {
        wrapped.child.kill('SIGTERM');
        try {
          await waitForExit(wrapped.child);
        } catch {
          wrapped.child.kill('SIGKILL');
        }
      }
    }
  });

  it('adopts and kills the detached gate tree when its original supervisor is SIGKILLed', async () => {
    const root = mkTmp('devkit-review-supervisor-crash-');
    const fixture = detachedCrashFixture(root);
    const wrapped = outerReviewWrapper(root, [
      process.execPath,
      fixture.script,
      fixture.leaderReady,
      fixture.childReady,
      fixture.leaderPid,
      fixture.childPid,
      fixture.leaderSignal,
      fixture.childSignal,
    ]);
    let leaderPid = 0;
    let childPid = 0;

    try {
      await waitForPath(fixture.leaderReady);
      await waitForPath(wrapped.identityFile);
      leaderPid = Number(readFileSync(fixture.leaderPid, 'utf8'));
      childPid = Number(readFileSync(fixture.childPid, 'utf8'));
      const supervisorPid = Number(readFileSync(wrapped.identityFile, 'utf8').trim().split(' ')[2]);
      process.kill(supervisorPid, 'SIGKILL');

      expect(await waitForExit(wrapped.child)).toBe(137);
      expect(readFileSync(fixture.leaderSignal, 'utf8')).toBe('SIGTERM');
      expect(readFileSync(fixture.childSignal, 'utf8')).toBe('SIGTERM');
      expect(processAlive(leaderPid)).toBe(false);
      expect(processAlive(childPid)).toBe(false);
    } finally {
      if (wrapped.child.exitCode === null) wrapped.child.kill('SIGKILL');
      for (const pid of [leaderPid, childPid]) {
        if (pid > 1 && processAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('waits for tee to finish after a post-supervisor signal interrupts its drain', async () => {
    const root = mkTmp('devkit-review-tee-drain-');
    const bin = join(root, 'bin');
    const draining = join(root, 'tee-draining');
    const drained = join(root, 'tee-drained');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'tee'),
      '#!/bin/bash\n/usr/bin/tee "$@"\n: > "$TEE_DRAINING"\nsleep 0.5\n: > "$TEE_DRAINED"\n',
    );
    chmodSync(join(bin, 'tee'), 0o755);
    const wrapped = outerReviewWrapper(root, [process.execPath, '-e', 'process.exit(0)'], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TEE_DRAINED: drained,
      TEE_DRAINING: draining,
    });

    await waitForPath(draining);
    wrapped.child.kill('SIGTERM');
    expect(await waitForExit(wrapped.child)).toBe(143);
    expect(existsSync(drained)).toBe(true);
  });

  // teeExit 0 is the sc-1711 defect: the drain wait read 143 off a tee that exited clean, the runner
  // blamed a log that persisted fine, and ship-branch.sh then withheld the receipt for a landed
  // commit. teeExit 1 is the fail-closed half, and the reason the fix reads the status twice instead
  // of discarding any >128 — discarding fails OPEN here.
  (MODERN_BASH ? it : it.skip).each([
    { teeExit: 0, wantRc: 0 },
    { teeExit: 1, wantRc: 1 },
  ])(
    `keeps tee exit $teeExit distinguishable through a pending-trap signal${
      MODERN_BASH ? '' : ' (skipped: no bash >= 4)'
    }`,
    ({ teeExit, wantRc }) => {
      const root = mkTmp('devkit-review-pending-trap-');
      const result = deferredSignalGateHarness(root, { teeExit });

      expect(result.stdout, result.stderr).toContain('SIGNAL_STATUS=143');
      expect(result.stdout, result.stderr).toContain(`RUNNER_RC=${wantRc}`);
      if (teeExit === 0) {
        expect(result.stderr).not.toMatch(/could not persist gate output/);
        expect(readFileSync(result.log, 'utf8')).toContain('pending-trap gate output');
        // Proof the interrupted read actually occurred, rather than the signal landing harmlessly in
        // the drain loop: the same stub against a runner WITHOUT the re-read must lose the receipt.
        // If this passes, the assertions above ran on a green path and covered nothing.
        const prefix = deferredSignalGateHarness(join(root, 'prefix-run'), {
          teeExit,
          runner: runnerWithoutReread(root),
        });
        expect(
          prefix.stdout,
          'pre-fix runner did not fail — the interrupted read never happened',
        ).toContain('RUNNER_RC=1');
        expect(prefix.stderr).toMatch(/could not persist gate output/);
      } else {
        expect(result.stderr).toMatch(/could not persist gate output/);
      }
    },
  );

  // Every signal the handoff traps, not just TERM. Ctrl-C is SIGINT and a harness terminating a task
  // may send any of them; ship-branch.sh's receipt case list admits 129/130/131 alongside 143, so the
  // >128 test in the runner has to be signal-agnostic rather than TERM-shaped.
  (MODERN_BASH ? it : it.skip).each([
    { signal: 'HUP', status: 129 },
    { signal: 'INT', status: 130 },
    { signal: 'QUIT', status: 131 },
  ])(
    `survives a pending-trap $signal signal, not only TERM${
      MODERN_BASH ? '' : ' (skipped: no bash >= 4)'
    }`,
    ({ signal, status }) => {
      const result = deferredSignalGateHarness(mkTmp('devkit-review-pending-trap-sig-'), {
        signal,
      });

      expect(result.stdout, result.stderr).toContain(`SIGNAL_STATUS=${status}`);
      expect(result.stdout, result.stderr).toContain('RUNNER_RC=0');
      expect(result.stderr).not.toMatch(/could not persist gate output/);
    },
  );

  // The accepted residual, pinned so it cannot silently become a fail-OPEN. When the signal reaches
  // tee itself (a process-GROUP kill, which is how a terminal Ctrl-C and some task harnesses deliver
  // it) both reads report tee's own death, the runner cannot prove the log is whole, and it must fail
  // closed — no receipt. Note SIGNAL_STATUS=0: the shell was never signalled, so this is purely the
  // second read refusing to launder a signal-dead tee into a success.
  (MODERN_BASH ? it : it.skip)(
    `fails closed when the signal kills tee itself rather than the shell${
      MODERN_BASH ? '' : ' (skipped: no bash >= 4)'
    }`,
    () => {
      const result = deferredSignalGateHarness(mkTmp('devkit-review-tee-signalled-'), {
        target: 'self',
      });

      expect(result.stdout, result.stderr).toContain('SIGNAL_STATUS=0');
      expect(result.stdout, result.stderr).toContain('RUNNER_RC=1');
      expect(result.stderr).toMatch(/could not persist gate output/);
    },
  );

  it('bounds tee drain when a failed supervisor leaves a pipe writer behind', () => {
    const root = mkTmp('devkit-review-tee-bound-');
    const bin = join(root, 'bin');
    const crashed = join(root, 'supervisor-crashed');
    const holderPidFile = join(root, 'holder.pid');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'node'),
      [
        '#!/bin/bash',
        'if [[ $1 == *gate-supervisor.* && ! -e $CRASHED_FILE ]]; then',
        '  : > "$CRASHED_FILE"',
        '  sleep 30 &',
        '  printf "%s" "$!" > "$HOLDER_PID_FILE"',
        '  exit 1',
        'fi',
        'exec "$REAL_NODE" "$@"',
      ].join('\n'),
    );
    chmodSync(join(bin, 'node'), 0o755);
    const result = gateHarness(root, 'review', '30', ['/usr/bin/true'], {
      ...process.env,
      CRASHED_FILE: crashed,
      HOLDER_PID_FILE: holderPidFile,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REAL_NODE: process.execPath,
    });
    const holderPid = Number(readFileSync(holderPidFile, 'utf8'));

    try {
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/gate output drain exceeded/);
    } finally {
      try {
        process.kill(holderPid, 'SIGKILL');
      } catch {}
    }
  });

  it('does not expose the retired PID handoff environment to target code', () => {
    const root = mkTmp('devkit-review-pid-complete-');
    const pidFile = join(root, 'supervisor.pid');
    const observedEnvironment = join(root, 'pid-environment');
    const result = gateHarness(
      root,
      'review',
      '5',
      [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(process.argv[1], [process.env.DEVKIT_REVIEW_SUPERVISOR_PID_FILE, process.env.DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN].map((value) => value ?? 'missing').join(',')); process.exit(19)`,
        observedEnvironment,
      ],
      { ...process.env, DEVKIT_REVIEW_SUPERVISOR_PID_FILE: pidFile },
    );

    expect(result.status, result.stderr).toBe(19);
    expect(readFileSync(observedEnvironment, 'utf8')).toBe('missing,missing');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('does not treat a caller-controlled legacy PID path as a handoff', () => {
    const root = mkTmp('devkit-review-pid-exclusive-');
    const pidFile = join(root, 'supervisor.pid');
    const commandMarker = join(root, 'command-ran');
    writeFileSync(pidFile, 'occupied\n');
    const result = gateHarness(
      root,
      'review',
      '5',
      [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(process.argv[1], 'ran')`,
        commandMarker,
      ],
      { ...process.env, DEVKIT_REVIEW_SUPERVISOR_PID_FILE: pidFile },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(pidFile, 'utf8')).toBe('occupied\n');
    expect(existsSync(commandMarker)).toBe(true);
  });

  // Was 'uses the private supervisor only for review mode'. Ship/reship used to take a coreutils
  // `timeout` path whose group-kill fired only on expiry, so a fast gate REJECTION left the leaked
  // tree holding the capture pipe and wedged the ship (sc-1199). One mechanism now serves both, and
  // a `timeout` binary on PATH must go untouched in either mode.
  it('uses the private supervisor for ship as well as review', () => {
    const root = mkTmp('devkit-review-runner-');
    const fakeTimeout = join(root, 'timeout');
    const timeoutArgs = join(root, 'timeout-args');
    writeFileSync(
      fakeTimeout,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$TIMEOUT_ARGS"\nshift 3\nexec "$@"\n',
    );
    chmodSync(fakeTimeout, 0o755);
    const envPath = `${root}:${process.env.PATH ?? ''}`;
    const previousPath = process.env.PATH;
    const previousCapture = process.env.TIMEOUT_ARGS;
    process.env.PATH = envPath;
    process.env.TIMEOUT_ARGS = timeoutArgs;
    try {
      const review = gateHarness(root, 'review', '5', [process.execPath, '-e', 'process.exit(19)']);
      expect(review.status, review.stderr).toBe(19);
      expect(existsSync(timeoutArgs)).toBe(false);

      const ship = gateHarness(root, 'ship', '7', [process.execPath, '-e', 'process.exit(0)']);
      expect(ship.status, ship.stderr).toBe(0);
      expect(existsSync(timeoutArgs)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.TIMEOUT_ARGS;
      else process.env.TIMEOUT_ARGS = previousCapture;
    }
  });

  // The capture tees to $log AND the optional telemetry archive, and a tee that cannot open one of
  // its files exits non-zero — which the runner turns into a failed gate. $log deserves that; the
  // archive does not. Ship reached this code path for the first time in sc-1199, so an unwritable
  // telemetry path would have started sinking otherwise-passing commits.
  it('keeps an unwritable gate archive best-effort on the supervised path', () => {
    const root = mkTmp('devkit-gate-archive-');
    const blocker = join(root, 'archive-parent-is-a-file');
    writeFileSync(blocker, 'not a directory\n');
    const result = gateHarness(root, 'ship', '30', [process.execPath, '-e', 'process.exit(0)'], {
      ...process.env,
      DEVKIT_GATE_ARCHIVE_LOG: join(blocker, 'archive.log'),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/could not archive gate output .* continuing/);
    expect(result.stderr).not.toMatch(/could not persist gate output/);
    expect(existsSync(join(root, 'gate.log'))).toBe(true);
  });

  it('rejects malformed invocations', () => {
    const result = supervisor('5', process.execPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage: gate-supervisor/);
  });
});
