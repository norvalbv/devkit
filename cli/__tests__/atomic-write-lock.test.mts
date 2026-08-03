/**
 * withLock ownership safety. The mutex must never hand two read-modify-write callers the manifest
 * at once, which means a stale lock may only be reaped when its holder is PROVABLY gone — age alone
 * would evict a live-but-paused writer — and a release may only remove the caller's OWN acquisition.
 * Every case below drives the real filesystem: the lock dir, its holder stamp, and its mtime.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withLock } from '../lib/atomic-write.mts';

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

/** A pid that is definitely not running: spawn a trivial process and reuse its pid after it exits. */
const deadPid = () => {
  const p = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (typeof p.pid !== 'number') throw new Error('could not obtain a pid');
  return p.pid;
};

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
