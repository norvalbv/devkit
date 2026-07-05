import { execFileSync } from 'node:child_process';
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
import { afterEach, describe, expect, it } from 'vitest';
import { buildFullHook } from '../lib/husky/husky-block.mts';

// Execute the ASSEMBLED hook under a real `sh -e` with a stub `bunx` that dispatches per tool
// (exit codes via env knobs) and logs every invocation. The hook now delegates the whole
// deterministic set (prefix cache → guards → structure → aggregation) to the single
// `guard-deterministic` orchestrator, so its internal trichotomy/aggregation is proven in
// gate-engine/deterministic/__tests__/run.test.mjs. THIS harness proves the SHELL contract the
// hook still owns: the orchestrator gates the AI fragments (`|| exit 1`), the AI gates stay
// fail-fast with their outage remedies, and it all survives dash + a hook path with spaces.

const homes = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true });
});

const ALL_GUARDS = ['size', 'fanout', 'dup', 'clone', 'decisions', 'review'];

// Hooks run under whatever /bin/sh the OS ships — dash on Debian/Ubuntu, bash on macOS. The
// fragments are POSIX sh; prove it where dash is installed instead of assuming.
const hasDash = existsSync('/bin/dash');

function runHook(
  env = {},
  selection = { biome: false, guards: ALL_GUARDS },
  { shell = 'sh', dirPrefix = 'dk-hook-exec-' } = {},
) {
  const home = mkdtempSync(join(tmpdir(), dirPrefix));
  homes.push(home);
  const bin = join(home, '.bun', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'bunx'),
    `#!/bin/sh
tool="$1"; shift
echo "$tool $*" >> "$HOME/calls.log"
case "$tool" in
  guard-deterministic) exit \${DET_RC:-0};;
  guard-decisions) exit \${DEC_RC:-0};;
  guard-review) exit \${REVIEW_RC:-0};;
  *) exit 0;;
esac
`,
  );
  chmodSync(join(bin, 'bunx'), 0o755);
  const hookPath = join(home, 'pre-commit');
  writeFileSync(hookPath, buildFullHook(selection));
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(shell, ['-e', hookPath], {
      env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status;
    stdout = `${e.stdout ?? ''}`;
  }
  let calls = '';
  try {
    calls = readFileSync(join(home, 'calls.log'), 'utf8');
  } catch {
    // hook never reached the stub
  }
  return { status, stdout, calls };
}

describe('assembled hook execution (stubbed bunx, sh -e)', () => {
  it('a deterministic failure blocks the hook (exit 1) and the AI gates never run', () => {
    const r = runHook({ DET_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    // `guard-deterministic … || exit 1` — a doomed commit never pays for a judge.
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
  });

  it('a clean deterministic run lets the AI gates run', () => {
    const r = runHook({ DET_RC: '0' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review');
  });

  it('passes the resolved structure command through to the orchestrator', () => {
    const r = runHook(
      { DET_RC: '0' },
      {
        biome: false,
        guards: ALL_GUARDS,
        structureCmd: 'guard-structure gate',
      },
    );
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic --hook');
    expect(r.calls).toContain('--structure guard-structure gate');
  });

  it('guard-review exit 3 (strict fail-closed) blocks with the outage remedy, not a violation banner', () => {
    const r = runHook({ REVIEW_RC: '3' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).not.toContain('opus-confirmed');
  });

  it('guard-review exit 2 (non-strict inconclusive) fails open', () => {
    expect(runHook({ REVIEW_RC: '2' }).status).toBe(0);
  });

  it('guard-decisions exit 3 (strict fail-closed) blocks with the outage remedy', () => {
    const r = runHook({ DEC_RC: '3' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).not.toContain('Record the decision target');
  });
});

describe('assembled hook — shell/OS variants', () => {
  it.runIf(hasDash)('dash (Debian/Ubuntu /bin/sh): det-gate blocking + AI ordering hold', () => {
    const opts = { shell: '/bin/dash' };
    const fail = runHook({ DET_RC: '1' }, { biome: false, guards: ALL_GUARDS }, opts);
    expect(fail.status).toBe(1);
    expect(fail.calls).not.toContain('guard-decisions');
    const clean = runHook({ DET_RC: '0' }, { biome: false, guards: ALL_GUARDS }, opts);
    expect(clean.status).toBe(0);
    expect(clean.calls).toContain('guard-review');
  });

  it('a hook path containing SPACES survives every "$0"-derived quoting seam', () => {
    // devkit itself lives under "Personal and learning/" — the harness dir gets a space too.
    const r = runHook(
      { DET_RC: '0' },
      { biome: false, guards: ALL_GUARDS },
      {
        dirPrefix: 'dk hook exec-',
      },
    );
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic --hook');
  });
});
