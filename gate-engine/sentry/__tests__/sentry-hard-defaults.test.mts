// Hard-by-default + the samples confidence contract (2026-07-12 Target: all judge gates hard by
// default; block = 3-sample majority). Pure resolveSamples is table-tested; the hard default is
// proven end-to-end by spawning the gate with a stubbed `claude` — on the `message` tier, which
// keeps its hard block without staged-diff evidence (effectiveHard's diff-tier downgrade is
// covered in check-sentry.test.mts).

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSamples } from '../check-sentry.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-sentry.mts');

describe('resolveSamples (confidence contract: block = 3-sample majority, warn = 1)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [true, undefined, 3],
    [false, undefined, 1],
    [true, '5', 5], // env override wins in hard mode
    [false, '2', 2], // and in warn mode
    [true, '0', 3], // invalid override falls back to the default
    [false, 'nope', 1],
  ])('resolveSamples(hard=%j, GUARD_SENTRY_SAMPLES=%j) → %j', (hard, env, expected) => {
    if (env !== undefined) vi.stubEnv('GUARD_SENTRY_SAMPLES', env);
    expect(resolveSamples(hard)).toBe(expected);
  });

  it('honours the FRINK_* back-compat alias', () => {
    vi.stubEnv('FRINK_SENTRY_SAMPLES', '7');
    expect(resolveSamples(true)).toBe(7);
  });
});

describe('gate mode is hard by default (spawned; stubbed claude, message tier, tmp watchlist)', () => {
  const stubs: string[] = [];
  const stubPath = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-hard-stub-'));
    stubs.push(dir);
    const fake = join(dir, 'claude');
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\n${script}`);
    chmodSync(fake, 0o755);
    return `${dir}:${process.env.PATH}`;
  };
  // MONITOR on the warn path appends to the watchlist — point it at a tmp file, never the repo's.
  // The tmp dir joins `stubs` so afterEach reclaims it with the claude stubs.
  const gate = (env: Record<string, string>, msg: string) => {
    const wlDir = mkdtempSync(join(tmpdir(), 'sentry-hard-wl-'));
    stubs.push(wlDir);
    return spawnSync('node', [SCRIPT, '--gate', msg], {
      env: {
        ...process.env,
        GUARD_SENTRY_CONTEXT: 'message',
        GUARD_SENTRY_WATCHLIST: join(wlDir, 'wl.md'),
        ...env,
      },
      encoding: 'utf8',
    });
  };
  afterEach(() => {
    while (stubs.length) rmSync(stubs.pop() as string, { recursive: true, force: true });
  });

  it('confident MONITOR blocks (exit 1) with NO SENTRY_HARD set — hard is the default', () => {
    const r = gate({ PATH: stubPath('echo MONITOR\n') }, 'fix(x): silent swallow');
    expect(r.status).toBe(1);
  });

  it('GUARD_SENTRY_HARD=0 softens the same verdict back to warn (exit 0)', () => {
    const r = gate(
      { PATH: stubPath('echo MONITOR\n'), GUARD_SENTRY_HARD: '0' },
      'fix(x): silent swallow',
    );
    expect(r.status).toBe(0);
  });

  it('a SKIP verdict passes (exit 0) under the hard default', () => {
    expect(gate({ PATH: stubPath('echo SKIP\n') }, 'fix(x): y').status).toBe(0);
  });
});
