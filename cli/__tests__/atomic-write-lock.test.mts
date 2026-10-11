// withLock ownership safety: a lock is reaped only when its holder is PROVABLY gone (never by age),
// and a release removes only the caller's own acquisition. Every case drives the real filesystem.
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processStartIdentity } from '../../gate-engine/judge/process/identity.mts';
import { reapIfDead } from '../../gate-engine/judge/process/process-lock.mts';
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

/** 2^22 + 1: above Linux's PID_MAX_LIMIT and macOS's pid ceiling, so no process can ever hold it. */
const deadPid = () => 4_194_305;

/** Plant a held lock: one file named by the holder's nonce, holding its pid and start identity. */
const plantHolder = (lockDir: string, pid: number, nonce = 'planted') => {
  mkdirSync(lockDir, { recursive: true });
  const identity = pid === process.pid ? processStartIdentity() : 'ps:gone';
  writeFileSync(join(lockDir, nonce), `${pid}\n${identity}`);
};

/** Plant a lock as an older devkit wrote it: a `holder` file stamped `<pid>:<uuid>`. */
const plantLegacy = (lockDir: string, pid: number) => {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'holder'), `${pid}:planted-uuid`, 'utf8');
};

describe('withLock', () => {
  it('runs the callback under the lock and releases it afterwards', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    const seen = withLock(lockDir, () =>
      readdirSync(lockDir).map((nonce) => readFileSync(join(lockDir, nonce), 'utf8')),
    );
    expect(seen).toEqual([`${process.pid}\n${processStartIdentity()}`]);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('reaps a lock whose holder is gone', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantHolder(lockDir, deadPid());
    expect(withLock(lockDir, () => 'acquired')).toBe('acquired');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('never reaps a live holder by age, however old its lock looks', () => {
    // A live writer paused (SIGSTOP, a suspended laptop) still owns its lock; reaping would admit a second.
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantHolder(lockDir, process.pid);
    const aged = new Date(Date.now() - 600_000);
    utimesSync(lockDir, aged, aged);
    expect(() => withLock(lockDir, () => 'acquired')).toThrow(/timed out acquiring manifest lock/);
    expect(readdirSync(lockDir)).toEqual(['planted']);
  });

  it('reaps a legacy holder stamp whose pid is gone', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantLegacy(lockDir, deadPid());
    expect(withLock(lockDir, () => 'acquired')).toBe('acquired');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('keeps a legacy holder stamp whose pid is alive', () => {
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    plantLegacy(lockDir, process.pid);
    expect(() => withLock(lockDir, () => 'acquired')).toThrow(/timed out acquiring manifest lock/);
    expect(readFileSync(join(lockDir, 'holder'), 'utf8')).toBe(`${process.pid}:planted-uuid`);
  });

  it('does not release a lock that is no longer ours', () => {
    // Being wrongly reaped mid-section: another holder now owns lockDir and must survive our release.
    const lockDir = join(mkTmp(), 'manifest.json.lock');
    withLock(lockDir, () => {
      for (const nonce of readdirSync(lockDir)) rmSync(join(lockDir, nonce));
      writeFileSync(join(lockDir, 'someone-else'), '999999\nps:x');
    });
    expect(readdirSync(lockDir)).toEqual(['someone-else']);
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
    plantHolder(lockDir, process.pid);
    const run = withLockAsync(lockDir, async () => 'acquired', WAIT);
    await expect(run).rejects.toBeInstanceOf(LockHeldError);
    await expect(run).rejects.toMatchObject({ holderPid: process.pid });
    expect(readdirSync(lockDir)).toEqual(['planted']);
  });

  it('reports an unknown holder (not NaN) for a lock with no readable holder', async () => {
    const lockDir = join(mkTmp(), 'init.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'torn'), 'not a holder');
    const run = withLockAsync(lockDir, async () => 'acquired', WAIT);
    await expect(run).rejects.toMatchObject({ holderPid: null });
  });

  it('reaps a crashed holder and runs the callback', async () => {
    const lockDir = join(mkTmp(), 'init.lock');
    plantHolder(lockDir, deadPid());
    await expect(withLockAsync(lockDir, async () => 'acquired', WAIT)).resolves.toBe('acquired');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('never lets a late reaper delete a fresh holder of the lock it judged dead', async () => {
    // Reapers A and B both read dead nonce N; B reaps it, C takes the lock, then A acts on its stale read.
    const lockDir = join(mkTmp(), 'init.lock');
    plantHolder(lockDir, deadPid(), 'dead');
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let fresh: Promise<string> | undefined;
    reapIfDead(lockDir, () => {
      reapIfDead(lockDir, () => true);
      fresh = withLockAsync(lockDir, async () => {
        await gate;
        return 'fresh finished';
      });
      return true;
    });
    const held = readdirSync(lockDir);
    expect(held).toHaveLength(1);
    expect(held).not.toContain('dead');
    open();
    await expect(fresh).resolves.toBe('fresh finished');
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

  it('retries when the parent vanishes mid-take, staging under an ignored *.lock name', async () => {
    const lockDir = join(mkTmp(), '.devkit', 'init.lock');
    const realRenameSync = fs.renameSync;
    const staged: string[] = [];
    // SAFETY: the wrapper forwards every argument to the real renameSync and returns its value.
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === lockDir) {
        staged.push(String(args[0]));
        // A concurrent run's cleanup removes the parent (and our staged dir) on the first take.
        if (staged.length === 1) rmSync(join(lockDir, '..'), { recursive: true, force: true });
      }
      return realRenameSync(...args);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports(); // process-lock.mts binds renameSync by name
    try {
      await expect(withLockAsync(lockDir, async () => 'acquired', { waitMs: 2_000 })).resolves.toBe(
        'acquired',
      );
    } finally {
      fs.renameSync = realRenameSync;
      syncBuiltinESMExports();
    }
    expect(staged.length).toBeGreaterThan(1);
    // Crash litter must match a consumer's `.devkit/*.lock` ignore rule.
    for (const path of staged) expect(path).toMatch(/\.new-[\w-]+\.lock$/);
  });
});
