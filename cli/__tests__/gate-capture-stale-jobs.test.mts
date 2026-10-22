import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from './_helpers.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_RUNNER = join(HERE, '../lib/ship/run-gates-with-capture.sh');
const HANDOFF = join(HERE, '../lib/ship/review/process/gate-signal-handoff.sh');
const DETERMINISTIC = join(HERE, '../../gate-engine/deterministic/run.mts');
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs the real runner with one shell function shadowing a builtin, and a node gate running `gateSource`.
function runWithShim(shim: string, gateSource: string, timeoutSeconds = 30, label = 'gate') {
  const root = mkdtempSync(join(tmpdir(), 'devkit-capture-shim-'));
  created.push(root);
  const log = join(root, 'gate.log');
  const script = [
    'set -euo pipefail',
    'source "$1"; source "$2"; root=$3; log=$4',
    'shift 4',
    'gate_signal_handoff_init',
    shim,
    `export DEVKIT_RUN_MODE=ship SHIP_COMMIT_TIMEOUT=${timeoutSeconds}`,
    `if run_gates_with_capture "$root" "$root" '${label}' "$log" "$root/progress.json" -- "$@"; then rc=0; else rc=$?; fi`,
    'printf "RUNNER_RC=%s REAPED=%s\\n" "$rc" "${RUN_GATES_REAPED-unset}"',
  ].join('\n');
  const result = testSpawnSync(
    'bash',
    [
      '-c',
      script,
      'capture-shim-test',
      GATE_RUNNER,
      HANDOFF,
      root,
      log,
      process.execPath,
      '-e',
      gateSource,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return { ...result, log };
}

describe('run_gates_with_capture — child liveness', () => {
  // bash 5 can leave an already-reaped tee listed "Running" (seen on Linux CI under load). Shadowing
  // `jobs` pins that stale table so the drain must consult the kernel.
  it('ends the drain when tee is gone even though the job table still lists it', () => {
    const result = runWithShim(
      'jobs() { [ -z "${tee_pid:-}" ] || echo "$tee_pid"; }',
      'console.log("stale-jobs gate output")',
    );

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=0');
    expect(result.stderr).not.toMatch(/gate output drain exceeded/);
    expect(result.stderr).not.toMatch(/could not persist gate output/);
    expect(readFileSync(result.log, 'utf8')).toContain('stale-jobs gate output');
  });

  // The root-cause invariant: a trapped signal that interrupts `wait` on a LIVE child can make bash
  // reap it and drop its status. Recording every such call makes the race-free shape deterministic.
  it('never enters `wait` for a child that is still running', () => {
    const result = runWithShim(
      'wait() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && echo "WAITED_ON_LIVE $p" >&2; done; builtin wait "$@"; }',
      'setTimeout(() => { console.log("slow gate output"); }, 400)',
    );

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=0');
    expect(result.stderr).not.toMatch(/WAITED_ON_LIVE/);
    expect(readFileSync(result.log, 'utf8')).toContain('slow gate output');
  });
});

// Prints a stage header, leaves a child holding the capture pipe, and exits 0.
const LEAK_AND_EXIT_0 = [
  'console.log("🛰️ Sentry gate (commit-msg judge)...");',
  "const { spawn } = require('node:child_process');",
  "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }).unref();",
].join('\n');

describe('run_gates_with_capture — timeout attribution', () => {
  it('reports a ship as passed when the gate exits 0 and leaves a process to reap', () => {
    const result = runWithShim(':', LEAK_AND_EXIT_0, 30, 'ship');

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=0 REAPED=1');
    expect(result.stderr).toMatch(
      /✓ ship: the gate chain passed; a process it started outlived it and was reaped after \d+s\./,
    );
    expect(result.stderr).not.toMatch(/exit 124|ceiling|--resume/);
  });

  // The pass is rewritten before the log check, so an unpersisted log still fails the ship closed.
  it('fails a reaped ship closed when its gate output could not be persisted', () => {
    const failingTee = [
      'real_tee=$(command -v tee); stub=$(mktemp -d "$root/tee-stub.XXXXXX")',
      `printf '#!/bin/sh\\n"%s" "$@"\\nexit 1\\n' "$real_tee" > "$stub/tee"; chmod +x "$stub/tee"`,
      'PATH="$stub:$PATH"',
    ].join('\n');
    const result = runWithShim(failingTee, LEAK_AND_EXIT_0, 30, 'ship');

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=1 REAPED=1');
    expect(result.stderr).toContain('could not persist gate output');
    expect(result.stderr).not.toContain('gate chain passed');
  });

  // A hook's own exit 124 is a failure, not the supervisor's reap status; it must never publish.
  it('fails a ship whose gate itself exits 124 while leaving a process behind', () => {
    const result = runWithShim(':', `${LEAK_AND_EXIT_0}\nprocess.exitCode = 124;`, 30, 'ship');

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=1 REAPED=0');
    expect(result.stderr).not.toContain('gate chain passed');
  });

  it('keeps the ceiling banner when gate output imitates the reap notice', () => {
    const result = runWithShim(
      ':',
      'console.log("gate-supervisor: the command exited 0 and was reaped"); setInterval(() => {}, 1000);',
      1,
    );

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=124');
    expect(result.stderr).toContain('hit the 1s ceiling (exit 124)');
    expect(result.stderr).not.toContain('NOT the 1s ceiling');
  });

  // The notice path must not reach the gate: a gate holding it could forge "not the ceiling".
  it('keeps the ceiling banner when the gate looks for the reap notice path in its env', () => {
    const result = runWithShim(
      ':',
      [
        'const notice = process.env.DEVKIT_GATE_REAP_NOTICE_FILE;',
        "if (notice) require('node:fs').writeFileSync(notice, '');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      1,
      'ship',
    );

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=124 REAPED=0');
    expect(result.stderr).toContain('hit the 1s ceiling (exit 124)');
  });

  it('keeps exit 124 for a reap outside ship, naming it as not the ceiling', () => {
    const result = runWithShim(':', LEAK_AND_EXIT_0);

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=124 REAPED=0');
    expect(result.stderr).toMatch(
      /exited cleanly, .*reaped after \d+s \(exit 124\) — NOT the 30s ceiling/,
    );
    expect(result.stderr).toContain('Last stage started: 🛰️ Sentry gate (commit-msg judge)...');
  });

  it('names the running stage header, not an earlier finding line, when the ceiling fires', () => {
    const result = runWithShim(
      ':',
      [
        'console.log("✗ 2 unused dependencies (4.98s)");',
        'console.log("🛰️ Sentry gate (commit-msg judge)...");',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      1,
    );

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=124');
    expect(result.stderr).toContain(
      'hit the 1s ceiling (exit 124) DURING: 🛰️ Sentry gate (commit-msg judge)...',
    );
    expect(result.stderr).toContain('More room per attempt: export SHIP_COMMIT_TIMEOUT.');
  });

  // Drives the real guard-deterministic, so its per-gate line and the banner's grep stay in step. The
  // label uses every character class an extraGates label allows: case, digit, `_` and `.`.
  it('names the extraGates gate that was running when the ceiling fires', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devkit-capture-det-'));
    created.push(repo);
    mkdirSync(join(repo, '.devkit'));
    writeFileSync(join(repo, '.devkit', 'config.json'), '{"components":{"guards":[]}}');
    const slow = { 'Slow_lint.2': `${process.execPath} -e setInterval(()=>{},1e3)` };
    writeFileSync(join(repo, 'guard.config.json'), JSON.stringify({ extraGates: slow }));
    const result = runWithShim(
      ':',
      `require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(DETERMINISTIC)}], { cwd: ${JSON.stringify(repo)}, stdio: 'inherit' });`,
      3,
    );

    expect(result.stdout, result.stderr).toContain('RUNNER_RC=124');
    expect(result.stderr).toContain(
      'hit the 3s ceiling (exit 124) DURING: ▶ deterministic: Slow_lint.2',
    );
  });
});
