import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFullHook } from '../lib/husky/husky-block.mjs';

// Execute the ASSEMBLED hook under a real `sh -e` with a stub `bunx` that dispatches per tool
// (exit codes via env knobs) and logs every invocation — proving the aggregation, prefix-skip,
// and AI-gate ordering contracts end-to-end rather than by string inspection.

const homes = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true });
});

const ALL_GUARDS = ['size', 'fanout', 'dup', 'clone', 'decisions', 'review'];

function runHook(env = {}, guards = ALL_GUARDS) {
  const home = mkdtempSync(join(tmpdir(), 'dk-hook-exec-'));
  homes.push(home);
  const bin = join(home, '.bun', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'bunx'),
    `#!/bin/sh
tool="$1"; shift
echo "$tool $*" >> "$HOME/calls.log"
case "$tool" in
  guard-size) exit \${SIZE_RC:-0};;
  guard-fanout) exit \${FANOUT_RC:-0};;
  guard-dup) exit \${DUP_RC:-0};;
  guard-clone) exit \${CLONE_RC:-0};;
  guard-decisions) exit \${DEC_RC:-0};;
  guard-review) exit \${REVIEW_RC:-0};;
  guard-prefix) case "$1" in check) exit \${PREFIX_CHECK_RC:-1};; *) exit 0;; esac;;
  *) exit 0;;
esac
`,
  );
  chmodSync(join(bin, 'bunx'), 0o755);
  const hookPath = join(home, 'pre-commit');
  writeFileSync(hookPath, buildFullHook({ biome: false, guards }));
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('sh', ['-e', hookPath], {
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
  it('TWO deterministic failures are BOTH reported in one aggregated block (single exit 1)', () => {
    const r = runHook({ SIZE_RC: '1', DUP_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('deterministic gates failed: guard-size guard-dup');
    // fanout/clone still ran (no fail-fast between deterministic gates)…
    expect(r.calls).toContain('guard-fanout');
    expect(r.calls).toContain('guard-clone');
    // …but the AI gates never spend on a doomed commit, and nothing is recorded.
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-prefix record');
  });

  it('exit-2 gates fail open: hook exits 0 and records the prefix key', () => {
    const r = runHook({ SIZE_RC: '2', DUP_RC: '2' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-prefix record');
  });

  it('a prefix-cache hit skips every deterministic gate but the AI gates still run', () => {
    const r = runHook({ PREFIX_CHECK_RC: '0' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('guard-size');
    expect(r.calls).not.toContain('guard-dup');
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review');
    // already cached — never re-recorded
    expect(r.calls).not.toContain('guard-prefix record');
  });

  it('an unexpected deterministic code is aggregated with its code named', () => {
    const r = runHook({ FANOUT_RC: '127' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('guard-fanout(unexpected:127)');
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
