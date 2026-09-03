import { spawn } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForPath } from '../../../__tests__/_helpers.mts';
import {
  checkOxcCapability,
  OVERLAY_ENTRY_REL,
  OXLINT_CONFIGS,
  removeOxcCapability,
  resolveOxlintEntryConfig,
  syncOxcCapability,
} from './lifecycle.mts';

// Hang detector for the holder process's boot, NOT a cold-start budget. Matches waitForPath's own
// default and review-gate-supervisor.test.mts's WAIT_MS; nothing asserts how long the boot takes.
const LOCK_HOLDER_READY_MS = 30_000;

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-oxc-lifecycle-'));
  roots.push(root);
  return root;
}

/**
 * Owns the Oxc lock until the contender reports contention, then audits what changed while it held
 * it — exiting 3 if the holder stamp moved, 4 if the managed state did.
 */
const LOCK_HOLDER_SCRIPT = [
  "const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  'const [lock, held, release, managed] = process.argv.slice(1);',
  "const stamp = process.pid + ':oxc-lifecycle-test';",
  "const snapshot = () => (existsSync(managed) ? readFileSync(managed, 'utf8') : '<absent>');",
  'const idle = new Int32Array(new SharedArrayBuffer(4));',
  'mkdirSync(lock);',
  "writeFileSync(join(lock, 'holder'), stamp);",
  'const before = snapshot();',
  "writeFileSync(held, 'held');",
  // No timer. `release` exists ONLY because withLock took EEXIST on this exact directory, so the
  // hold lasts exactly as long as the contention does — however long the machine takes to get there.
  'while (!existsSync(release)) Atomics.wait(idle, 0, 0, 2);',
  // The contender is provably parked in withLock's retry loop right now. Anything that moved the
  // holder stamp or the managed bytes got there WITHOUT the lock.
  "if (readFileSync(join(lock, 'holder'), 'utf8') !== stamp) {",
  "  console.error('oxc lock holder stamp was replaced while the lock was held');",
  '  process.exit(3);',
  '}',
  'if (snapshot() !== before) {',
  "  console.error('managed Oxc state was mutated while the lock was held');",
  '  process.exit(4);',
  '}',
  'rmSync(lock, { recursive: true, force: true });',
].join('\n');

let lockGateSeq = 0;

/**
 * Run `action` against an Oxc lock a FOREIGN process holds, and prove the lock was honoured.
 *
 * `action` is synchronous: withLock parks the calling thread in `Atomics.wait` (atomic-write.mts),
 * so while it is contended NOTHING on this thread runs — no setTimeout, no microtask, no fake timer.
 * The release signal therefore cannot come from the test body; it has to come from INSIDE the
 * blocking call. `mkdirSync` is the syscall withLock uses to attempt acquisition, so a one-shot hook
 * on the EEXIST it takes against this lock directory is an exact, CAUSAL "the product is now blocked
 * behind the holder" event — and that is what releases the holder. Same idiom as
 * gate-engine/critique/__tests__/persistence-lock.test.mts (`signalMainLockAttempt`).
 *
 * Nothing here measures elapsed time. The only test-side deadline is waitForPath's hang detector.
 * The previous shape asserted `Date.now() - started >= 100` after a fixed 300ms hold, which failed
 * whenever load delayed `action()` past the hold — and was VACUOUS for syncOxcCapability anyway,
 * whose two probeOxcRuntime spawns inside the critical section already exceed 100ms (sc-2288).
 */
async function runWhileOxcLockIsHeld(root: string, action: () => void): Promise<void> {
  const lock = join(root, '.devkit', 'oxc.lock');
  const managed = join(root, '.devkit', 'oxc', 'manifest.json');
  const gate = join(root, '.devkit', `lock-gate-${(lockGateSeq += 1)}`);
  mkdirSync(gate, { recursive: true });
  const held = join(gate, 'held');
  const release = join(gate, 'release');

  const child = spawn(process.execPath, ['-e', LOCK_HOLDER_SCRIPT, lock, held, release, managed], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  try {
    await waitForPath(held, LOCK_HOLDER_READY_MS);
  } catch (cause) {
    // The holder blocks until `release` exists, so a boot failure here would otherwise leave it
    // spinning for the rest of the run rather than surfacing what actually went wrong.
    writeFileSync(release, 'release');
    child.kill('SIGKILL');
    throw cause;
  }
  expect(existsSync(lock)).toBe(true);

  let contended = false;
  const realMkdirSync = fs.mkdirSync;
  // SAFETY: the wrapper forwards every argument to the real mkdirSync and returns its value
  // unchanged, so it is call-compatible with the overloaded signature; only the throw path is
  // observed. The narrowing inside is likewise safe: a caught value is only read for `.code`, and
  // Node's fs errors are ErrnoException — a non-Error cause yields undefined and fails the ===.
  fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
    try {
      return realMkdirSync(...args);
    } catch (cause: unknown) {
      if (String(args[0]) === lock && (cause as NodeJS.ErrnoException).code === 'EEXIST') {
        contended = true;
        if (!existsSync(release)) writeFileSync(release, 'release');
      }
      throw cause;
    }
  }) as typeof fs.mkdirSync;
  // atomic-write.mts imports mkdirSync as a NAMED ESM binding, so assigning fs.mkdirSync alone is
  // invisible to withLock without this re-sync — `contended` would silently stay false.
  syncBuiltinESMExports();
  try {
    action();
  } finally {
    fs.mkdirSync = realMkdirSync;
    syncBuiltinESMExports();
    // In the finally, so a THROW from action() cannot skip it: the holder spins until this file
    // appears, and leaving it unwritten wedges the worker until vitest's close timeout instead of
    // surfacing whatever action() actually threw.
    if (!existsSync(release)) writeFileSync(release, 'release');
  }

  // Replaces `Date.now() - started >= 100`. The operation did not merely take a while: it
  // demonstrably found the lock HELD and waited for the holder to release it.
  expect(contended).toBe(true);
  expect(existsSync(lock)).toBe(false);
  expect(await exited).toBe(0);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Oxc capability lifecycle', () => {
  it('creates pinned managed state and editable root starters idempotently', () => {
    const root = tempRoot();

    syncOxcCapability(root);
    const rootLint = join(root, '.oxlintrc.json');
    const before = readFileSync(rootLint, 'utf8');
    writeFileSync(rootLint, before.replace('"rules": {}', '"rules": { "no-debugger": "off" }'));
    syncOxcCapability(root);

    expect(readFileSync(rootLint, 'utf8')).toContain('"no-debugger": "off"');
    expect(readFileSync(join(root, '.devkit/oxc/oxlint.base.json'), 'utf8')).toBe(
      readFileSync(join(import.meta.dirname, '../../../../oxc/oxlint.base.json'), 'utf8'),
    );
    expect(JSON.parse(readFileSync(join(root, '.devkit/oxc/manifest.json'), 'utf8'))).toMatchObject(
      {
        schemaVersion: 1,
        pins: { oxlint: '1.78.0', oxfmt: '0.63.0' },
        configs: {
          oxlint: { path: '.oxlintrc.json' },
          oxfmt: { path: '.oxfmtrc.json' },
        },
      },
    );
    expect(checkOxcCapability(root).every((result) => result.status === 'OK')).toBe(true);
  });

  it('unwires anti-slop from the managed base from explicit selection, not stale files', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.devkit/anti-slop'), { recursive: true });
    writeFileSync(join(root, '.devkit/anti-slop/manifest.json'), '{}\n');
    writeFileSync(join(root, '.devkit/anti-slop/oxlint.json'), '{}\n');

    syncOxcCapability(root, { antiSlop: true });
    expect(readFileSync(join(root, '.devkit/oxc/oxlint.base.json'), 'utf8')).toContain(
      '../anti-slop/oxlint.json',
    );

    syncOxcCapability(root, { antiSlop: false });
    expect(readFileSync(join(root, '.devkit/oxc/oxlint.base.json'), 'utf8')).not.toContain(
      '../anti-slop/oxlint.json',
    );
    expect(JSON.parse(readFileSync(join(root, '.devkit/oxc/manifest.json'), 'utf8'))).toMatchObject(
      { antiSlop: false },
    );
    expect(checkOxcCapability(root).every((result) => result.status === 'OK')).toBe(true);
  });

  it('serializes lifecycle ownership updates with the Oxc manifest lock', async () => {
    const root = tempRoot();
    syncOxcCapability(root);
    const base = readFileSync(join(root, '.devkit/oxc/oxlint.base.json'), 'utf8');

    await runWhileOxcLockIsHeld(root, () => syncOxcCapability(root));

    // A sync that had to WAIT still produced complete, correct state — not a partial write.
    expect(readFileSync(join(root, '.devkit/oxc/oxlint.base.json'), 'utf8')).toBe(base);
    expect(checkOxcCapability(root).every((result) => result.status === 'OK')).toBe(true);

    await runWhileOxcLockIsHeld(root, () => removeOxcCapability(root));

    expect(existsSync(join(root, '.devkit/oxc.lock'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });

  it('adopts existing supported config names without changing or later deleting them', () => {
    const root = tempRoot();
    const lint = 'export default { rules: { eqeqeq: "error" } };\n';
    const fmt = '{ /* local */ "printWidth": 92 }\n';
    writeFileSync(join(root, 'oxlint.config.ts'), lint);
    writeFileSync(join(root, '.oxfmtrc.jsonc'), fmt);

    syncOxcCapability(root);
    removeOxcCapability(root);

    expect(readFileSync(join(root, 'oxlint.config.ts'), 'utf8')).toBe(lint);
    expect(readFileSync(join(root, '.oxfmtrc.jsonc'), 'utf8')).toBe(fmt);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });

  it('removes unchanged starters but preserves a customized starter', () => {
    const root = tempRoot();
    syncOxcCapability(root);
    writeFileSync(join(root, '.oxlintrc.json'), '{ "rules": { "no-debugger": "off" } }\n');

    removeOxcCapability(root);

    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(true);
    expect(existsSync(join(root, '.oxfmtrc.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });

  it('fails safely when more than one config for a tool exists', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.oxlintrc.json'), '{}\n');
    writeFileSync(join(root, 'oxlint.config.ts'), 'export default {};\n');

    expect(() => syncOxcCapability(root)).toThrow(
      'multiple Oxc configs in one directory: .oxlintrc.json, oxlint.config.ts',
    );
    expect(existsSync(join(root, '.devkit/oxc/manifest.json'))).toBe(false);
  });

  it('preflights both tools before creating either starter', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.oxfmtrc.json'), '{}\n');
    writeFileSync(join(root, 'oxfmt.config.ts'), 'export default {};\n');

    expect(() => syncOxcCapability(root)).toThrow(
      'multiple Oxc configs in one directory: .oxfmtrc.json, oxfmt.config.ts',
    );
    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc/manifest.json'))).toBe(false);
  });

  it('does not orphan root starters when managed state cannot be created', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.devkit/oxc/manifest.json'), { recursive: true });

    expect(() => syncOxcCapability(root)).toThrow();

    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(false);
    expect(existsSync(join(root, '.oxfmtrc.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/oxc.lock'))).toBe(false);
  });

  it('treats an incomplete manifest as missing and cleans managed state conservatively', () => {
    const root = tempRoot();
    syncOxcCapability(root);
    writeFileSync(join(root, '.devkit/oxc/manifest.json'), '{ "schemaVersion": 1 }\n');

    expect(checkOxcCapability(root)[0]).toMatchObject({
      name: 'Oxc manifest',
      status: 'MISSING',
    });
    removeOxcCapability(root);

    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(true);
    expect(existsSync(join(root, '.oxfmtrc.json'))).toBe(true);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });
});

// The overlay contract is "writes nothing git can see". Everything below defends it at the WRITER,
// where it breaks silently: a root config devkit creates on a repair path is a committable stray.
describe('Oxc capability lifecycle — overlay geometry', () => {
  const overlayRoot = (): string => {
    const root = tempRoot();
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(join(root, '.devkit/config.json'), `${JSON.stringify({ overlay: true })}\n`);
    return root;
  };

  it('writes a git-excluded root entry config and no consumer-owned starter', () => {
    const root = overlayRoot();
    syncOxcCapability(root, { overlay: true });

    expect(existsSync(join(root, OVERLAY_ENTRY_REL))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, OVERLAY_ENTRY_REL), 'utf8'))).toEqual({
      extends: ['./.devkit/oxc/oxlint.base.json'],
    });
    for (const name of OXLINT_CONFIGS) expect(existsSync(join(root, name))).toBe(false);
    expect(existsSync(join(root, '.oxfmtrc.json'))).toBe(false);
    expect(resolveOxlintEntryConfig(root)).toBe(OVERLAY_ENTRY_REL);
  });

  // The entry config MUST stay at the package root: oxlint resolves `overrides[].files` globs
  // against the ENTRY config's directory, and the runtime probe cannot catch a shift in that base.
  it('keeps the entry config at the package root (its directory is the override glob base)', () => {
    expect(OVERLAY_ENTRY_REL).not.toContain('/');
    expect(OXLINT_CONFIGS).not.toContain(OVERLAY_ENTRY_REL);
  });

  it('infers overlay from the repository marker when no manifest survives to stamp it', () => {
    const root = overlayRoot();
    syncOxcCapability(root, { overlay: true });
    // Exactly the state `checkOxcCapability` reports as "manifest MISSING" and doctor --fix repairs.
    rmSync(join(root, '.devkit/oxc/manifest.json'));
    rmSync(join(root, OVERLAY_ENTRY_REL));

    syncOxcCapability(root);

    expect(existsSync(join(root, OVERLAY_ENTRY_REL))).toBe(true);
    for (const name of OXLINT_CONFIGS) expect(existsSync(join(root, name))).toBe(false);
  });

  it('refuses a discovery-named root config in an overlay repo whatever the caller claims', () => {
    const root = overlayRoot();
    // No stamp, no marker-derived default, and the caller actively asserts package mode — the
    // belt-and-braces guard is the only thing between this and a visible stray.
    expect(() => syncOxcCapability(root, { overlay: false })).toThrow(/overlay install/u);
    for (const name of OXLINT_CONFIGS) expect(existsSync(join(root, name))).toBe(false);
  });

  // init's package path runs BEFORE step 9 rewrites `.devkit/config.json`, so a stale `overlay:
  // true` is still on disk here and the writer's marker fallback would take the OVERLAY branch.
  it('refuses rather than silently writing overlay geometry when a stale marker disagrees', () => {
    const root = overlayRoot();
    expect(() => syncOxcCapability(root, { antiSlop: false, overlay: false })).toThrow(
      /devkit clean/u,
    );
    expect(existsSync(join(root, '.devkit/oxc/manifest.json'))).toBe(false);
    for (const name of OXLINT_CONFIGS) expect(existsSync(join(root, name))).toBe(false);
  });

  it('keeps the overlay geometry across a flagless re-sync via the manifest stamp', () => {
    const root = tempRoot(); // no marker at all — only the stamp can carry the mode here
    syncOxcCapability(root, { overlay: true });
    rmSync(join(root, OVERLAY_ENTRY_REL));

    syncOxcCapability(root);

    expect(existsSync(join(root, OVERLAY_ENTRY_REL))).toBe(true);
    for (const name of OXLINT_CONFIGS) expect(existsSync(join(root, name))).toBe(false);
  });

  it('removes the entry config it created, and keeps a customized one', () => {
    const root = overlayRoot();
    syncOxcCapability(root, { overlay: true });
    removeOxcCapability(root);
    expect(existsSync(join(root, OVERLAY_ENTRY_REL))).toBe(false);

    syncOxcCapability(root, { overlay: true });
    writeFileSync(
      join(root, OVERLAY_ENTRY_REL),
      `${JSON.stringify({ extends: ['./.devkit/oxc/oxlint.base.json'], rules: { eqeqeq: 'off' } })}\n`,
    );
    removeOxcCapability(root);
    expect(existsSync(join(root, OVERLAY_ENTRY_REL))).toBe(true);
  });

  it('reports no entry config in package mode, so the lint keeps using discovery', () => {
    const root = tempRoot();
    syncOxcCapability(root);
    expect(resolveOxlintEntryConfig(root)).toBeNull();
    expect(existsSync(join(root, OVERLAY_ENTRY_REL))).toBe(false);
  });

  // Guards the dry-run arm, which used to take a shorter positional list and silently dropped
  // everything after `antiSlop`, so the preview described a different install than the real one.
  it('narrates the overlay plan on a dry run instead of the package one', () => {
    const root = overlayRoot();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    syncOxcCapability(root, { overlay: true, dryRun: true });

    expect(lines.join('\n')).toContain(OVERLAY_ENTRY_REL);
    expect(lines.join('\n')).not.toContain('preserve existing root configs');
    expect(existsSync(join(root, OVERLAY_ENTRY_REL))).toBe(false);
  });
});
