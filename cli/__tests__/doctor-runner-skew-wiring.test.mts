/**
 * sc-2100 wiring. The unit tests in doctor-runner-skew.test.mts prove runnerSkew/assertRunnerMayWrite
 * decide correctly; these prove the decision is actually REACHED from each entry point. That is the
 * failure mode a unit suite cannot see: a guard that is correct but sits below the branch that
 * returns first, or an option that is accepted but never forwarded.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import doctorRun from '../commands/doctor.mts';
import { ALLOW_SKEW_ENV, runnerSkew } from '../lib/doctor/pin/runner-identity.mts';
import { syncAntiSlopCapability } from '../lib/install/anti-slop/lifecycle.mts';
import { syncOxcCapability } from '../lib/install/oxc/lifecycle.mts';
import { packageDir, readJson } from '../lib/fs-helpers.mts';
import { rootRegistry } from './_helpers.mts';

const RUNNING = readJson<{ version: string }>(join(packageDir(), 'package.json'))?.version ?? '';
const NEWER = `${Number(RUNNING.split('.')[0]) + 1}.0.0`;
const MANIFEST_REL = join('.devkit', 'oxc', 'manifest.json');

const { mkTmp, cleanup } = rootRegistry();
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  cleanup();
});
const printed = (): string => log.mock.calls.flat().join('\n');

/** The `.devkit/config.json` fields these fixtures vary. */
interface FixtureConfig {
  overlay?: boolean;
  selfHost?: boolean;
  devkitRef?: string;
}

/** Minimal initialised repo pinned ABOVE the running devkit. */
function skewedRepo(cfg: FixtureConfig = {}, { bin = false } = {}): string {
  const root = mkTmp('skew-wire-');
  mkdirSync(join(root, '.devkit'), { recursive: true });
  writeFileSync(join(root, '.devkit', 'config.json'), JSON.stringify({ stack: 'generic', ...cfg }));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@norvalbv/devkit': `git+https://x/y.git#v${NEWER}` } }),
  );
  const nm = join(root, 'node_modules', '@norvalbv', 'devkit');
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, 'package.json'), JSON.stringify({ version: NEWER }));
  if (bin) {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const p = join(root, 'node_modules', '.bin', 'devkit');
    // A real script, not a mock: proves the hand-off actually execs something on this platform.
    writeFileSync(p, `#!/bin/sh\necho "$@" > "${join(root, 'delegated.txt')}"\nexit 7\n`);
    chmodSync(p, 0o755);
  }
  return root;
}

describe('doctor --fix hands off before it repairs', () => {
  it('execs the pinned binary with the full argv and returns ITS exit code', async () => {
    const root = skewedRepo({}, { bin: true });
    const code = await doctorRun(['--fix'], root);
    expect(code).toBe(7); // the stub's exit code, surfaced verbatim
    expect(readFileSync(join(root, 'delegated.txt'), 'utf8').trim()).toBe('doctor --fix');
  });

  it('writes no managed state of its own when it delegates', async () => {
    const root = skewedRepo({}, { bin: true });
    await doctorRun(['--fix'], root);
    expect(existsSync(join(root, MANIFEST_REL))).toBe(false);
    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(false);
  });

  it('refuses with exit 1 and writes nothing when no pinned binary resolves', async () => {
    const root = skewedRepo();
    expect(await doctorRun(['--fix'], root)).toBe(1);
    expect(existsSync(join(root, MANIFEST_REL))).toBe(false);
    expect(printed()).toContain('nothing written');
  });

  it('a read-only doctor still reports, and never execs anything', async () => {
    const root = skewedRepo({}, { bin: true });
    const code = await doctorRun([], root);
    expect(existsSync(join(root, 'delegated.txt'))).toBe(false);
    expect(code).toBe(1);
    // Named exactly ONCE in package mode: the check row carries it, so the banner would repeat it.
    const out = printed();
    expect(out).toMatch(new RegExp(`running ${RUNNING}, but this repo pins ${NEWER}`));
    expect(out).not.toMatch(/runner skew:/);
  });

  it('overlay and self-host name the skew via the banner, having no check row', async () => {
    await doctorRun([], skewedRepo({ overlay: true, devkitRef: `v${NEWER}` }));
    expect(printed()).toMatch(/runner skew:/);
  });

  // Drift is drift in every mode — a skewed overlay must not report 0 where package mode reports 1.
  it('a skewed overlay doctor exits non-zero like package mode does', async () => {
    expect(await doctorRun([], skewedRepo({ overlay: true, devkitRef: `v${NEWER}` }))).toBe(1);
  });
});

describe('the guard sits above every mode branch', () => {
  // overlay short-circuits at the top of run(); a guard placed after it would let runOverlayDoctor
  // regenerate .devkit/hooks/pre-commit from an OLDER devkit's generator.
  it('overlay --fix under skew refuses and leaves the overlay hook untouched', async () => {
    const root = skewedRepo({ overlay: true, devkitRef: `v${NEWER}` });
    expect(await doctorRun(['--fix'], root)).toBe(1);
    expect(existsSync(join(root, '.devkit', 'hooks', 'pre-commit'))).toBe(false);
    expect(printed()).toMatch(/runner skew/);
  });

  it('self-host is exempt: it reaches its own doctor rather than refusing', async () => {
    const root = skewedRepo({ selfHost: true, devkitRef: `v${NEWER}` });
    await doctorRun([], root);
    expect(printed()).not.toMatch(/runner skew/);
  });

  // An uninitialised repo has no pin to read, so the not-initialised exit must win outright.
  it('an uninitialised repo still exits 2, with no skew noise', async () => {
    const root = mkTmp('skew-uninit-');
    expect(await doctorRun(['--fix'], root)).toBe(2);
    expect(printed()).not.toMatch(/runner skew/);
  });
});

describe('pinRoot decides WHOSE pin is judged', () => {
  // ship refreshes an ephemeral worktree FROM the running package on purpose (sc-2099), so the
  // worktree's own tree must not be what decides whether this runner may write.
  it('a skewed caller root blocks the write even when the target dir is clean', () => {
    const caller = skewedRepo();
    const target = mkTmp('skew-wt-');
    expect(() => syncOxcCapability(target, { antiSlop: false, pinRoot: caller })).toThrow(
      /refusing to write/,
    );
  });

  it('a clean caller root permits the write even when the target dir looks skewed', () => {
    const caller = mkTmp('skew-clean-');
    const target = skewedRepo();
    expect(() => syncOxcCapability(target, { antiSlop: false, pinRoot: caller })).not.toThrow();
  });
});

describe('provenance survives round-trips', () => {
  it('stamps the writer, and clears writtenUnderSkew once a clean devkit rewrites', () => {
    const root = mkTmp('skew-stamp-');
    // 1. write under the visible opt-out from a "skewed" runner
    const skewed = skewedRepo();
    syncOxcCapability(skewed, { antiSlop: false, allowSkew: true });
    const underSkew = readJson<{ devkitRef?: string; writtenUnderSkew?: boolean }>(
      join(skewed, MANIFEST_REL),
    );
    expect(underSkew?.devkitRef).toBe(`v${RUNNING}`);
    expect(underSkew?.writtenUnderSkew).toBe(true);

    // 2. a clean write must not leave the flag behind
    syncOxcCapability(root, { antiSlop: false });
    const clean = readJson<{ devkitRef?: string; writtenUnderSkew?: boolean }>(
      join(root, MANIFEST_REL),
    );
    expect(clean?.devkitRef).toBe(`v${RUNNING}`);
    expect(clean?.writtenUnderSkew).toBeUndefined();
  });
});

describe('delegation marker does not leak past the hand-off', () => {
  it('is set for the child only, never mutating this process env', async () => {
    const before = process.env.DEVKIT_SKEW_DELEGATED;
    await doctorRun(['--fix'], skewedRepo({}, { bin: true }));
    expect(process.env.DEVKIT_SKEW_DELEGATED).toBe(before);
  });
});

// Guard against the unit suite's fakeExec drifting from the real signature.
describe('execFileSync contract', () => {
  it('accepts the (bin, args, opts) shape delegation relies on', () => {
    expect(execFileSync('/bin/echo', ['ok'], { encoding: 'utf8' }).trim()).toBe('ok');
  });
});

describe('a hand-off that cannot spawn falls back to the refusal', () => {
  // A non-executable bin is a real shape: a partially-restored node_modules, a bad umask, or
  // Windows (where bun writes devkit.cmd and the extensionless `devkit` is a POSIX shell script).
  // "We could not hand off" is NOT "the child ran and failed" — the user must still get the remedy.
  it('a non-executable pinned bin refuses with the remediation, not a bare exit code', async () => {
    const root = skewedRepo({}, { bin: true });
    chmodSync(join(root, 'node_modules', '.bin', 'devkit'), 0o644);
    expect(await doctorRun(['--fix'], root)).toBe(1);
    expect(printed()).toContain('nothing written');
    expect(existsSync(join(root, MANIFEST_REL))).toBe(false);
  });

  it('a pinned bin that is a directory does not masquerade as a successful hand-off', async () => {
    const root = skewedRepo();
    mkdirSync(join(root, 'node_modules', '.bin', 'devkit'), { recursive: true });
    expect(await doctorRun(['--fix'], root)).toBe(1);
    expect(printed()).toContain('nothing written');
  });
});

describe('dry runs stay usable on a skewed machine', () => {
  // A dry run writes nothing, so refusing one would block `devkit init --dry-run` for no safety gain.
  it('a dry-run sync under skew neither throws nor writes', () => {
    const root = skewedRepo();
    expect(() => syncOxcCapability(root, { antiSlop: false, dryRun: true })).not.toThrow();
    expect(existsSync(join(root, MANIFEST_REL))).toBe(false);
  });
});

describe('the refusal precedes every mutation', () => {
  // Found by the correctness reviewer: anti-slop replaces its managed tree BEFORE the Oxc writer
  // runs, so a guard that only sat downstream left a crash-recovery hole — a kill between the
  // replacement and its rollback would strand older-shaped state that no rollback ever runs for.
  it('anti-slop refuses under skew without having touched its managed tree', () => {
    const root = skewedRepo();
    expect(() => syncAntiSlopCapability(root, {})).toThrow(/refusing to write/);
    expect(existsSync(join(root, '.devkit', 'anti-slop'))).toBe(false);
    expect(existsSync(join(root, MANIFEST_REL))).toBe(false);
  });

  it('anti-slop judges pinRoot, so a clean caller may publish into a skewed worktree', () => {
    const caller = mkTmp('skew-caller-');
    const target = skewedRepo();
    // Reaches the Oxc writer rather than refusing; any later failure is not a runner refusal.
    let error: unknown;
    try {
      syncAntiSlopCapability(target, { pinRoot: caller });
    } catch (e) {
      error = e;
    }
    expect(String(error ?? '')).not.toMatch(/refusing to write/);
  });
});

describe('the opt-out reaches the writer, not the hand-off', () => {
  // The help text promises DEVKIT_ALLOW_SKEWED_FIX forces the write. Delegating instead would hand
  // off to the PINNED binary — which needs no forcing — so the documented repair never happened.
  it('a forced --fix repairs in-process rather than delegating', async () => {
    const root = skewedRepo({}, { bin: true });
    process.env[ALLOW_SKEW_ENV] = '1';
    try {
      await doctorRun(['--fix'], root);
    } finally {
      delete process.env[ALLOW_SKEW_ENV];
    }
    expect(existsSync(join(root, 'delegated.txt'))).toBe(false);
  });
});

describe('pin and binary come from the same root', () => {
  // Resolved independently, a monorepo package dir could validate against the git root's install
  // and then hand off to a stale package-local binary — code that is not the version approved.
  it('never offers a bin from a different root than the version it validated', () => {
    const root = mkTmp('skew-split-');
    const pkg = join(root, 'packages', 'app');
    mkdirSync(join(pkg, '.devkit'), { recursive: true });
    writeFileSync(join(pkg, '.devkit', 'config.json'), JSON.stringify({ stack: 'generic' }));
    mkdirSync(join(root, '.git'), { recursive: true });
    // Root declares + installs the newer devkit...
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@norvalbv/devkit': `git+https://x/y.git#v${NEWER}` } }),
    );
    const nm = join(root, 'node_modules', '@norvalbv', 'devkit');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'package.json'), JSON.stringify({ version: NEWER }));
    // ...while the package dir carries only a stray executable, with no manifest beside it.
    mkdirSync(join(pkg, 'node_modules', '.bin'), { recursive: true });
    const stray = join(pkg, 'node_modules', '.bin', 'devkit');
    writeFileSync(stray, '#!/bin/sh\nexit 0\n');
    chmodSync(stray, 0o755);

    const skew = runnerSkew(pkg);
    expect(skew.kind).toBe('older');
    expect(skew.pinnedBin).not.toBe(stray);
  });
});
