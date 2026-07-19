import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from './schema.mts';

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 500;
const INCOMPLETE_TAKEOVER_STALE_MS = 1_000;
const TAKEOVER_MAX_AGE_MS = 60_000;

type LockInspection = 'busy' | 'invalid' | 'removed' | 'self';

interface TakeoverOwner {
  pid: number;
  createdAt: number;
  token: string;
}

function createOwnedFileAtomically(lockPath: string, owner: string): boolean {
  const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
  try {
    writeFileSync(candidatePath, owner, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(candidatePath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
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
  let bytes: string;
  let modifiedAt: number;
  try {
    bytes = readFileSync(lockPath, 'utf8');
    modifiedAt = statSync(lockPath).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  let owner: TakeoverOwner | undefined;
  try {
    owner = takeoverOwner(JSON.parse(bytes) as unknown);
  } catch {
    owner = undefined;
  }
  const age = Date.now() - (owner?.createdAt ?? modifiedAt);
  const stale = owner
    ? age > TAKEOVER_MAX_AGE_MS || !processIsRunning(owner.pid)
    : age > INCOMPLETE_TAKEOVER_STALE_MS;
  if (!stale) return false;
  try {
    if (readFileSync(lockPath, 'utf8') !== bytes) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
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
  try {
    if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function inspectFileLock(lockPath: string): LockInspection {
  const takeoverPath = `${lockPath}.takeover`;
  const takeover = acquireTakeover(takeoverPath);
  if (!takeover) return 'busy';
  try {
    let raw: string;
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'removed';
      throw error;
    }
    if (!raw) {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age <= INCOMPLETE_TAKEOVER_STALE_MS) return 'busy';
      try {
        if (readFileSync(lockPath, 'utf8')) return 'busy';
        unlinkSync(lockPath);
        return 'removed';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'removed';
        throw error;
      }
    }
    let owner: unknown;
    try {
      owner = JSON.parse(raw) as unknown;
    } catch {
      return 'invalid';
    }
    const pid = isRecord(owner) ? owner.pid : undefined;
    if (typeof pid !== 'number') return 'invalid';
    if (pid === process.pid) return 'self';
    if (processIsRunning(pid)) return 'busy';
    try {
      unlinkSync(lockPath);
      return 'removed';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'removed';
      throw error;
    }
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

export function withFileLock<T>(lockPath: string, operation: string, action: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
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
