import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProcessLock,
  LockHeldError,
  reapIfDead,
  releaseProcessLock,
  withProcessLock,
} from '../process/process-lock.mts';

const temps: string[] = [];
const LABEL = { label: 'test' };

function tempLock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'process-lock-'));
  temps.push(dir);
  return join(dir, 'l.lock');
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A held lock: one file named by the holder's nonce, holding its pid and start identity. */
function seatLock(lock: string, pid: number, identity: string, nonce: string): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, nonce), `${pid}\n${identity}`);
}

/** The LockHeldError `fn` throws, or undefined when it returns; any other error propagates. */
function heldErrorOf(fn: () => void): LockHeldError | undefined {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof LockHeldError) return cause;
    throw cause;
  }
  return undefined;
}

describe('process lock', () => {
  it('reaps a lock whose holder is provably gone, and keeps a live one', () => {
    const lock = tempLock();
    seatLock(lock, 111, 'ps:x', 'n1');
    reapIfDead(lock, () => false);
    expect(existsSync(join(lock, 'n1'))).toBe(true);
    reapIfDead(lock, () => true);
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over an empty lock directory left by a crash mid-release', () => {
    const lock = tempLock();
    mkdirSync(lock);
    const held = withProcessLock(lock, () => readdirSync(lock).length, LABEL);
    expect(held).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('never removes a holder that re-took the lock after the old one was judged dead', () => {
    const lock = tempLock();
    seatLock(lock, 111, 'ps:x', 'dead');
    reapIfDead(lock, () => {
      rmSync(join(lock, 'dead'));
      writeFileSync(join(lock, 'live'), '222\nps:y');
      return true;
    });
    expect(readdirSync(lock)).toEqual(['live']);
  });

  it('lets two reapers of one dead holder remove it exactly once', () => {
    const lock = tempLock();
    seatLock(lock, 111, 'ps:x', 'dead');
    reapIfDead(lock, () => {
      reapIfDead(lock, () => true); // a second reaper wins the race inside the first one's check
      seatLock(lock, 333, 'ps:z', 'fresh'); // and a fresh holder takes the lock
      return true;
    });
    expect(readdirSync(lock)).toEqual(['fresh']);
  });

  it('refuses an async callback, which would run its awaited half outside the lock', () => {
    const lock = tempLock();
    expect(() => withProcessLock(lock, () => Promise.resolve(1), LABEL)).toThrow(
      'synchronous callback',
    );
    expect(existsSync(lock)).toBe(false);
  });

  it('times out rather than run unlocked while a live foreign holder keeps the lock', () => {
    const lock = tempLock();
    // The parent is alive and a non-`ps:` identity can never prove it reused, so it is never gone.
    seatLock(lock, process.ppid, 'node:x', 'held');
    let ran = false;
    const held = heldErrorOf(() =>
      withProcessLock(
        lock,
        () => {
          ran = true;
        },
        { label: 'test', waitMs: 300 },
      ),
    );
    expect(held?.holderPid).toBe(process.ppid);
    expect(held?.message).toContain('holds the test lock');
    expect(ran).toBe(false);
    expect(readdirSync(lock)).toEqual(['held']);
  });

  it('never removes a holder that replaced ours while the callback ran', () => {
    // An unconditional release (the old overrides unlink) would delete the newcomer's lock here.
    const lock = tempLock();
    withProcessLock(
      lock,
      () => {
        const [mine] = readdirSync(lock);
        rmSync(join(lock, mine));
        writeFileSync(join(lock, 'foreign'), `${process.ppid}\nnode:x`);
      },
      LABEL,
    );
    expect(readdirSync(lock)).toEqual(['foreign']);
  });

  it('releases the lock when the callback throws, so the next acquire runs at once', () => {
    // A held-set entry or holder file left behind would fail or stall every later acquire.
    const lock = tempLock();
    expect(() =>
      withProcessLock(
        lock,
        () => {
          throw new Error('boom');
        },
        LABEL,
      ),
    ).toThrow('boom');
    expect(existsSync(lock)).toBe(false);
    const started = Date.now();
    expect(withProcessLock(lock, () => 'again', { ...LABEL, waitMs: 0 })).toBe('again');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('surfaces a parent path that cannot exist at once, rather than as a held lock', () => {
    // A dangling `.devkit` symlink fails every mkdir with ENOENT; waiting reports a phantom holder.
    const root = join(tempLock(), '..');
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    const started = Date.now();
    expect(() => withProcessLock(join(root, 'dangling', 'l.lock'), () => 1, LABEL)).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('takes over a dead holder lock and releases only its own acquisition', () => {
    const lock = tempLock();
    seatLock(lock, 999_991, 'ps:gone', 'dead');
    expect(withProcessLock(lock, () => readdirSync(lock).includes('dead'), LABEL)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it('fails a nested acquire of a lock this process holds at once, instead of waiting it out', () => {
    const lock = tempLock();
    const started = Date.now();
    withProcessLock(
      lock,
      () => {
        expect(() => withProcessLock(lock, () => undefined, LABEL)).toThrow(LockHeldError);
      },
      LABEL,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(withProcessLock(lock, () => 'free again', LABEL)).toBe('free again');
  });

  it('checks a live holder once per reap interval, not on every retry', () => {
    const lock = tempLock();
    seatLock(lock, process.ppid, 'node:x', 'held');
    let checks = 0;
    const isGone = () => {
      checks += 1;
      return false;
    };
    expect(() =>
      withProcessLock(lock, () => undefined, { label: 'test', waitMs: 600, isGone }),
    ).toThrow(LockHeldError);
    // ~60 retries in 600 ms; a 250 ms cadence allows 3 checks (plus one for scheduling slack).
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(checks).toBeLessThanOrEqual(4);
  });

  it('stamps the owner it is given, and its release spares a holder that re-took the lock', () => {
    const lock = tempLock();
    const nonce = acquireProcessLock(lock, {
      ...LABEL,
      owner: { pid: 4242, identity: 'ps:given' },
    });
    expect(readFileSync(join(lock, nonce), 'utf8')).toBe('4242\nps:given');

    rmSync(join(lock, nonce)); // reaped as dead, then taken by a fresh holder
    writeFileSync(join(lock, 'fresh'), '333\nps:z');
    releaseProcessLock(lock, nonce);
    expect(readdirSync(lock)).toEqual(['fresh']);
  });

  it('gives up after the wait it is given while a live foreign holder keeps the lock', () => {
    const lock = tempLock();
    seatLock(lock, process.pid, 'ps:held', 'held');
    expect(
      heldErrorOf(() => acquireProcessLock(lock, { ...LABEL, waitMs: 50, isGone: () => false })),
    ).toBeInstanceOf(LockHeldError);
    expect(readdirSync(lock)).toEqual(['held']);
  });
});
