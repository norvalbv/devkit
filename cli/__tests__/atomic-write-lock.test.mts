/**
 * withLock ownership safety. The mutex must never hand two read-modify-write callers the manifest
 * at once, which means a stale lock may only be reaped when its holder is PROVABLY gone — age alone
 * would evict a live-but-paused writer — and a release may only remove the caller's OWN acquisition.
 * Every case below drives the real filesystem: the lock dir, its holder stamp, and its mtime.
 */
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LockHeldError, withLock, withLockAsync } from '../lib/atomic-write.mts';

const roots: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'devkit-lock-'));
  roots.push(d);
  return d;
};

afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Plant a held lock: dir + `<pid>:<uuid>` stamp, aged `ageMs` into the past (mtime set LAST). */
const plantLock = (
  lockDir: string,
  { pid, ageMs, stamped = true }: { pid: number; ageMs: number; stamped?: boolean },
) => {
  mkdirSync(lockDir);
  if (stamped) writeFileSync(join(lockDir, 'holder'), `${pid}:planted-uuid`, 'utf8');
  const when = new Date(Date.now() - ageMs);
  utimesSync(lockDir, when, when);
};

/** 2^22 + 1: above Linux's PID_MAX_LIMIT and macOS's pid ceiling, so no process can ever hold it. */
const deadPid = () => 4_194_305;

const STALE_MS = 90_000; // > the 60s LOCK_STALE_MS
const FRESH_MS = 1_000;

describe('withLock', () => {
  it('runs the callback under the lock and releases it afterwards', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    const seen = withLock(lockDir, () => {
      expect(existsSync(lockDir)).toBe(true);
      return readFileSync(join(lockDir, 'holder'), 'utf8');
    });
    expect(seen.startsWith(`${process.pid}:`)).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('reaps a stale lock whose holder is gone', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantLock(lockDir, { pid: deadPid(), ageMs: STALE_MS });
    expect(withLock(lockDir, () => 'acquired')).toBe('acquired');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('does NOT reap a stale lock whose holder is still alive', () => {
    // The reviewer's case: a live writer paused past the stale window still owns its lock. Our own
    // pid stands in for it — reaping here would run a second read-modify-write concurrently.
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantLock(lockDir, { pid: process.pid, ageMs: STALE_MS });
    expect(() => withLock(lockDir, () => 'acquired')).toThrow(/timed out acquiring manifest lock/);
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, 'holder'), 'utf8')).toBe(`${process.pid}:planted-uuid`);
  });

  it('does NOT reap a fresh lock even when its holder is gone', () => {
    // A young lock is presumed live: the holder may be mid-acquire, and the caller can afford to wait.
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantLock(lockDir, { pid: deadPid(), ageMs: FRESH_MS });
    expect(() => withLock(lockDir, () => 'acquired')).toThrow(/timed out acquiring manifest lock/);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('reaps a stale UNSTAMPED lock (acquirer died between its mkdir and its stamp write)', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantLock(lockDir, { pid: 0, ageMs: STALE_MS, stamped: false });
    expect(withLock(lockDir, () => 'acquired')).toBe('acquired');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('does not release a lock that is no longer ours', () => {
    // Simulates being wrongly reaped mid-section: another holder now owns lockDir. An unconditional
    // rmSync in the finally would strip THEIR lock and admit a third writer.
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    withLock(lockDir, () => {
      writeFileSync(join(lockDir, 'holder'), '999999:someone-elses-uuid', 'utf8');
    });
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, 'holder'), 'utf8')).toBe('999999:someone-elses-uuid');
  });

  it('releases the lock when the callback throws', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    expect(() =>
      withLock(lockDir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe('withLockAsync', () => {
  const WAIT = { waitMs: 50 };

  it('rejects with LockHeldError naming a live holder, leaving its lock intact', async () => {
    const lockDir = join(mkTmp(), 'init.lock');
    plantLock(lockDir, { pid: process.pid, ageMs: STALE_MS });
    const run = withLockAsync(lockDir, async () => 'acquired', WAIT);
    await expect(run).rejects.toBeInstanceOf(LockHeldError);
    await expect(run).rejects.toMatchObject({ holderPid: process.pid });
    expect(readFileSync(join(lockDir, 'holder'), 'utf8')).toBe(`${process.pid}:planted-uuid`);
  });

  it('reports an unknown holder (not NaN) for a fresh unstamped lock', async () => {
    // The acquirer died between mkdir and its stamp write, inside the fresh window.
    const lockDir = join(mkTmp(), 'init.lock');
    plantLock(lockDir, { pid: 0, ageMs: FRESH_MS, stamped: false });
    const run = withLockAsync(lockDir, async () => 'acquired', WAIT);
    await expect(run).rejects.toMatchObject({ holderPid: null });
  });

  it('reaps a crashed holder (stale lock, dead pid) and runs the callback', async () => {
    const lockDir = join(mkTmp(), 'init.lock');
    plantLock(lockDir, { pid: deadPid(), ageMs: STALE_MS });
    await expect(withLockAsync(lockDir, async () => 'acquired', WAIT)).resolves.toBe('acquired');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('releases the lock when the async callback rejects', async () => {
    const lockDir = join(mkTmp(), 'init.lock');
    const run = withLockAsync(
      lockDir,
      async () => {
        throw new Error('boom');
      },
      WAIT,
    );
    await expect(run).rejects.toThrow('boom');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('serializes two in-process contenders without blocking the event loop', async () => {
    // A sync wait (Atomics.wait) here would park the thread and the holder could never resolve.
    const lockDir = join(mkTmp(), 'init.lock');
    const order: string[] = [];
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = withLockAsync(
      lockDir,
      async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
      },
      { waitMs: 5_000 },
    );
    const second = withLockAsync(
      lockDir,
      async () => {
        order.push('second');
      },
      { waitMs: 5_000 },
    );
    setImmediate(open);
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe('withLockAsync — lock parent directory', () => {
  it('creates a missing parent directory', async () => {
    const lockDir = join(mkTmp(), 'fresh', '.devkit', 'init.lock');
    await expect(withLockAsync(lockDir, async () => 'acquired', { waitMs: 50 })).resolves.toBe(
      'acquired',
    );
    expect(existsSync(lockDir)).toBe(false);
  });

  it('retries when the parent vanishes between its creation and the lock mkdir', async () => {
    const lockDir = join(mkTmp(), '.devkit', 'init.lock');
    const realMkdirSync = fs.mkdirSync;
    let vanished = false;
    // SAFETY: the wrapper forwards every argument to the real mkdirSync and returns its value.
    fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      if (!vanished && String(args[0]) === lockDir) {
        vanished = true; // a concurrent run's cleanup removed the empty parent just now
        rmSync(join(lockDir, '..'), { recursive: true, force: true });
      }
      return realMkdirSync(...args);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports(); // atomic-write.mts binds mkdirSync by name
    try {
      await expect(withLockAsync(lockDir, async () => 'acquired', { waitMs: 2_000 })).resolves.toBe(
        'acquired',
      );
    } finally {
      fs.mkdirSync = realMkdirSync;
      syncBuiltinESMExports();
    }
    expect(vanished).toBe(true);
  });
});
