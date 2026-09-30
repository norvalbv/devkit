import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from './_helpers.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_RUNNER = join(HERE, '../lib/ship/run-gates-with-capture.sh');
const HANDOFF = join(HERE, '../lib/ship/review/process/gate-signal-handoff.sh');
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs the real runner with one shell function shadowing a builtin, and a gate that prints `marker`.
function runWithShim(shim: string, gateSource: string) {
  const root = mkdtempSync(join(tmpdir(), 'devkit-capture-shim-'));
  created.push(root);
  const log = join(root, 'gate.log');
  const script = [
    'set -euo pipefail',
    'source "$1"; source "$2"; root=$3; log=$4',
    'shift 4',
    'gate_signal_handoff_init',
    shim,
    'export DEVKIT_RUN_MODE=ship SHIP_COMMIT_TIMEOUT=30',
    'if run_gates_with_capture "$root" "$root" gate "$log" "$root/progress.json" -- "$@"; then rc=0; else rc=$?; fi',
    'printf "RUNNER_RC=%s\\n" "$rc"',
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
    { encoding: 'utf8' },
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
