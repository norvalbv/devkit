import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { superviseGateCommand } from '../lib/ship/review/process/gate-supervisor.mts';
import { rootRegistry } from './_helpers.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(HERE, '../lib/ship/review/process/gate-supervisor.mts');
const GATE_RUNNER = join(HERE, '../lib/ship/run-gates-with-capture.sh');
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

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
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

function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function backgroundFixture(root: string): { script: string; ready: string; signal: string } {
  const script = join(root, 'background-fixture.mjs');
  const ready = join(root, 'background-ready');
  const signal = join(root, 'background-signal');
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

  it('returns 127 when the command cannot be spawned', () => {
    const result = supervisor('5', '--', join(mkTmp('devkit-review-missing-'), 'absent'));

    expect(result.status, result.stderr).toBe(127);
  });

  it.each([
    124, 129, 130, 131, 143,
  ])('normalizes a natural reserved exit %d to an ordinary rejection', (status) => {
    const result = supervisor('5', '--', process.execPath, '-e', `process.exit(${status})`);

    expect(result.status, result.stderr).toBe(1);
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

  it('keeps supervising a pipe-holding descendant after the command leader exits', () => {
    const fixture = backgroundFixture(mkTmp('devkit-review-background-'));
    const result = supervisor(
      '5',
      '--',
      process.execPath,
      fixture.script,
      fixture.ready,
      fixture.signal,
    );

    expect(result.status, result.stderr).toBe(124);
    expect(readFileSync(fixture.signal, 'utf8')).toBe('SIGTERM');
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
      await waitForPath(fixture.leaderReady, 15_000);
      await waitForPath(wrapped.identityFile, 15_000);
      const [wrapperPid, supervisorParent, supervisorPid] = readFileSync(
        wrapped.identityFile,
        'utf8',
      )
        .trim()
        .split(' ');
      expect(supervisorParent).toBe(wrapperPid);
      wrapped.child.kill('SIGTERM');
      expect(await waitForExit(wrapped.child, 15_000)).toBe(143);
      expect(readFileSync(fixture.leaderSignal, 'utf8')).toBe('SIGTERM');
      expect(readFileSync(fixture.descendantSignal, 'utf8')).toBe('SIGTERM');
      expect(() => process.kill(Number(supervisorPid), 0)).toThrow();
    } finally {
      if (wrapped.child.exitCode === null) {
        wrapped.child.kill('SIGTERM');
        try {
          await waitForExit(wrapped.child, 15_000);
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
      await waitForPath(fixture.leaderReady, 15_000);
      await waitForPath(wrapped.identityFile, 15_000);
      leaderPid = Number(readFileSync(fixture.leaderPid, 'utf8'));
      childPid = Number(readFileSync(fixture.childPid, 'utf8'));
      const supervisorPid = Number(readFileSync(wrapped.identityFile, 'utf8').trim().split(' ')[2]);
      process.kill(supervisorPid, 'SIGKILL');

      expect(await waitForExit(wrapped.child, 15_000)).toBe(137);
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
    const started = Date.now();
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
      expect(Date.now() - started).toBeLessThan(10_000);
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

  it('uses the private supervisor only for review mode', () => {
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
      expect(readFileSync(timeoutArgs, 'utf8').split('\n').slice(0, 3)).toEqual(['-k', '10', '7']);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.TIMEOUT_ARGS;
      else process.env.TIMEOUT_ARGS = previousCapture;
    }
  });

  it('rejects malformed invocations', () => {
    const result = supervisor('5', process.execPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage: gate-supervisor/);
  });
});
