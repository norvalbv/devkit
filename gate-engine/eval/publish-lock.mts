import { randomUUID } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from './schema.mts';

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 500;
const INCOMPLETE_TAKEOVER_STALE_MS = 1_000;
const TAKEOVER_MAX_AGE_MS = 60_000;
const OWNER_MAX_BYTES = 1_024;

type LockInspection = 'busy' | 'invalid' | 'removed' | 'self';

type VerifiedLockSnapshot =
  | { state: 'readable'; bytes: Buffer; stat: BigIntStats }
  | { state: 'oversized'; stat: BigIntStats };
type LockSnapshot =
  | VerifiedLockSnapshot
  | { state: 'missing' }
  | { state: 'unsafe' }
  | { state: 'unstable' };
type LockSnapshotAttempt = LockSnapshot | { state: 'retry' };

interface TakeoverOwner {
  pid: number;
  createdAt: number;
  token: string;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function privateRegularFile(stat: BigIntStats): boolean {
  return stat.isFile() && (stat.mode & 0o077n) === 0n;
}

function stablePathStat(
  lockPath: string,
  descriptor: number,
  before: BigIntStats,
): BigIntStats | null {
  const after = fstatSync(descriptor, { bigint: true });
  if (!sameFile(before, after)) return null;
  let pathStat: BigIntStats;
  try {
    pathStat = lstatSync(lockPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!sameFile(after, pathStat)) return null;
  return after;
}

function readLockSnapshotOnce(lockPath: string): LockSnapshotAttempt {
  let pathBefore: BigIntStats;
  try {
    pathBefore = lstatSync(lockPath, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') return { state: 'unsafe' };
    throw error;
  }
  if (!privateRegularFile(pathBefore)) return { state: 'unsafe' };

  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'retry' };
    if (code === 'EACCES' || code === 'ELOOP' || code === 'EPERM') return { state: 'unsafe' };
    throw error;
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!sameFile(pathBefore, before)) return { state: 'retry' };
    if (before.size > BigInt(OWNER_MAX_BYTES)) {
      const stable = stablePathStat(lockPath, descriptor, before);
      return stable ? { state: 'oversized', stat: stable } : { state: 'retry' };
    }

    const expected = Number(before.size);
    const buffer = Buffer.allocUnsafe(expected);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total !== expected) return { state: 'retry' };

    const stable = stablePathStat(lockPath, descriptor, before);
    if (!stable) return { state: 'retry' };
    return {
      state: 'readable',
      bytes: buffer,
      stat: stable,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return { state: 'unsafe' };
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function readLockSnapshot(lockPath: string): LockSnapshot {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = readLockSnapshotOnce(lockPath);
    if (snapshot.state !== 'retry') return snapshot;
  }
  return { state: 'unstable' };
}

function sameSnapshot(left: VerifiedLockSnapshot, right: VerifiedLockSnapshot): boolean {
  if (left.state !== right.state || !sameFile(left.stat, right.stat)) return false;
  return (
    left.state === 'oversized' || (right.state === 'readable' && left.bytes.equals(right.bytes))
  );
}

function unlinkUnchanged(lockPath: string, expected: VerifiedLockSnapshot): boolean {
  const current = readLockSnapshot(lockPath);
  if (current.state === 'missing') return true;
  if (
    (current.state === 'readable' || current.state === 'oversized') &&
    sameSnapshot(expected, current)
  ) {
    try {
      unlinkSync(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  return false;
}

function createOwnedFileAtomically(lockPath: string, owner: string): boolean {
  const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      candidatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, owner);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(candidatePath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(candidatePath);
    } catch {
      // A uniquely named candidate cannot block another publisher; cleanup is best effort.
    }
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function takeoverOwner(value: unknown): TakeoverOwner | undefined {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !Number.isFinite(value.createdAt) ||
    typeof value.token !== 'string' ||
    !value.token
  ) {
    return undefined;
  }
  return value as unknown as TakeoverOwner;
}

function staleTakeover(lockPath: string): boolean {
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot.state === 'missing') return true;
  if (snapshot.state === 'unsafe' || snapshot.state === 'unstable') return false;
  let owner: TakeoverOwner | undefined;
  if (snapshot.state === 'readable') {
    try {
      owner = takeoverOwner(JSON.parse(snapshot.bytes.toString('utf8')) as unknown);
    } catch {
      owner = undefined;
    }
  }
  const age = Date.now() - (owner?.createdAt ?? Number(snapshot.stat.mtimeNs) / 1e6);
  const stale = owner
    ? age > TAKEOVER_MAX_AGE_MS || !processIsRunning(owner.pid)
    : age > INCOMPLETE_TAKEOVER_STALE_MS;
  if (!stale) return false;
  return unlinkUnchanged(lockPath, snapshot);
}

function acquireTakeover(lockPath: string): string | undefined {
  const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createOwnedFileAtomically(lockPath, owner)) return owner;
    if (!staleTakeover(lockPath)) return undefined;
  }
  return undefined;
}

function releaseOwnedFile(lockPath: string, owner: string): void {
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot.state === 'readable' && snapshot.bytes.equals(Buffer.from(owner)))
    unlinkUnchanged(lockPath, snapshot);
}

function inspectFileLock(lockPath: string): LockInspection {
  const takeoverPath = `${lockPath}.takeover`;
  const takeover = acquireTakeover(takeoverPath);
  if (!takeover) return 'busy';
  try {
    const snapshot = readLockSnapshot(lockPath);
    if (snapshot.state === 'missing') return 'removed';
    if (snapshot.state === 'unstable') return 'busy';
    if (snapshot.state === 'unsafe' || snapshot.state === 'oversized') return 'invalid';
    if (snapshot.bytes.length === 0) {
      const age = Date.now() - Number(snapshot.stat.mtimeNs) / 1e6;
      if (age <= INCOMPLETE_TAKEOVER_STALE_MS) return 'busy';
      return unlinkUnchanged(lockPath, snapshot) ? 'removed' : 'busy';
    }
    let owner: unknown;
    try {
      owner = JSON.parse(snapshot.bytes.toString('utf8')) as unknown;
    } catch {
      return 'invalid';
    }
    const pid = isRecord(owner) ? owner.pid : undefined;
    if (typeof pid !== 'number') return 'invalid';
    if (pid === process.pid) return 'self';
    if (processIsRunning(pid)) return 'busy';
    return unlinkUnchanged(lockPath, snapshot) ? 'removed' : 'busy';
  } finally {
    releaseOwnedFile(takeoverPath, takeover);
  }
}

function acquireFileLock(lockPath: string, operation: string): string {
  const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (createOwnedFileAtomically(lockPath, owner)) return owner;
    const inspection = inspectFileLock(lockPath);
    if (inspection === 'invalid')
      throw new Error(`Another ${operation} is in progress or left an unreadable lock`);
    if (inspection === 'self') throw new Error(`Another ${operation} is in progress`);
    if (inspection === 'removed') continue;
    Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, LOCK_WAIT_MS);
  }
  throw new Error(`Could not acquire ${operation} lock`);
}

export function withFileLock<T>(
  lockPath: string,
  operation: string,
  action: () => T,
  options: { createParent?: boolean } = {},
): T {
  if (options.createParent !== false) mkdirSync(dirname(lockPath), { recursive: true });
  const lock = acquireFileLock(lockPath, operation);
  try {
    return action();
  } finally {
    releaseOwnedFile(lockPath, lock);
  }
}

export function withPublishFileLock<T>(lockPath: string, action: () => T): T {
  return withFileLock(lockPath, 'benchmark publish', action);
}
