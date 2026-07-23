import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundedRegularFile } from '../strict-bounded-file-read.mts';

const LOCK_WAIT_MS = 2_000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const HELD_LOCKS = new Set<string>();

function ensureDevkitDir(root: string): void {
  const path = join(root, '.devkit');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('.devkit must be a real directory for agent asset lifecycle state');
}

function ownsLock(lock: string, token: string): boolean {
  const owner = readBoundedRegularFile(join(lock, 'owner'), {
    label: 'agent asset lock owner',
    maxBytes: 256,
    limitLabel: '256-byte',
  });
  return owner?.toString('utf8') === token;
}

/**
 * Serialize provider-native asset and hook ownership changes.
 *
 * A pre-existing lock is never removed automatically: elapsed time cannot prove
 * that its owner has stopped, so recovery is explicit and fail-closed.
 */
export function withAgentAssetLifecycleLock<T>(
  root: string,
  dryRun: boolean,
  operation: () => T,
): T {
  if (dryRun) return operation();
  ensureDevkitDir(root);
  const lock = join(root, '.devkit', 'agent-assets.lock');
  if (HELD_LOCKS.has(lock)) return operation();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out acquiring agent asset lock: ${lock}`);
      Atomics.wait(SLEEP_CELL, 0, 0, 20);
    }
  }

  const token = randomUUID();
  writeFileSync(join(lock, 'owner'), token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  HELD_LOCKS.add(lock);
  try {
    return operation();
  } finally {
    HELD_LOCKS.delete(lock);
    if (ownsLock(lock, token)) rmSync(lock, { recursive: true });
  }
}
