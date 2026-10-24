// devkit's one cross-process mutex. The holder file is NAMED by its nonce, so renaming
// `<lock>/<nonce>` away is an atomic compare-and-delete: it can only ever remove that holder.
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { processOwnerIsProvablyGone, processStartIdentity } from './identity.mts';

const WAIT_MS = 5_000;
const RETRY_MS = 10;
const REAP_EVERY_MS = 250; // a liveness check can fork `ps`, so a contended wait does not run one per retry

type IsGone = (owner: { pid: number; processStart: string }) => boolean;

/** The process a lock is held for: its pid plus the start identity that defeats pid reuse. */
export interface LockOwner {
  pid: number;
  identity: string;
}

export interface LockOptions {
  label: string;
  waitMs?: number;
  isGone?: IsGone;
  /** Defaults to this process. A bash caller that holds the lock across statements passes its own. */
  owner?: LockOwner;
}

interface Attempt {
  nonce: string;
  owner: LockOwner;
}

/** A contended lock that stayed held past the wait. `holderPid` is null when no holder was readable. */
export class LockHeldError extends Error {
  readonly holderPid: number | null;
  constructor(dir: string, label: string, holderPid: number | null) {
    super(`pid ${holderPid ?? 'unknown'} holds the ${label} lock: ${dir} — retry once it exits`);
    this.name = 'LockHeldError';
    this.holderPid = holderPid;
  }
}

/** Locks this process holds: a nested synchronous acquire could never see its release. */
const held = new Set<string>();

let own: string | undefined;
const ownIdentity = (): string => (own ??= processStartIdentity());

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function errnoCode(cause: unknown): string | undefined {
  return cause instanceof Error && 'code' in cause ? String(cause.code) : undefined;
}

interface Holder {
  nonce: string;
  pid: number;
  identity: string;
}

function readHolder(dir: string): Holder | undefined {
  try {
    const [nonce] = readdirSync(dir);
    if (!nonce) return undefined;
    const [pid, identity] = readFileSync(join(dir, nonce), 'utf8').split('\n');
    return Number.isSafeInteger(Number(pid)) && identity
      ? { nonce, pid: Number(pid), identity }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remove exactly `nonce`'s holder file, then the directory only if that left it empty. */
function removeHolder(dir: string, nonce: string): void {
  const grave = `${dir}.grave-${randomUUID()}.lock`;
  try {
    renameSync(join(dir, nonce), grave);
  } catch {
    return; // already gone: another reaper, or never ours
  }
  rmSync(grave, { force: true });
  removeIfEmpty(dir);
}

/** rmdir refuses a non-empty directory, so this can never remove a lock someone holds. */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // held again (not empty) or already gone
  }
}

/** One attempt: move a directory holding our nonce file onto `dir`. Fails while `dir` is held. */
function tryTake(dir: string, { nonce, owner }: Attempt): boolean {
  // Sibling names end in `.lock` so a consumer's `.devkit/*.lock` ignore also hides crash litter.
  const staged = `${dir}.new-${nonce}.lock`;
  mkdirSync(staged, { recursive: true }); // a parent that can never exist throws here, at once
  try {
    writeFileSync(join(staged, nonce), `${owner.pid}\n${owner.identity}`);
    renameSync(staged, dir);
    return true;
  } catch (cause) {
    rmSync(staged, { recursive: true, force: true });
    const code = errnoCode(cause);
    if (code === 'ENOENT') return false; // the parent was removed mid-take: the next mkdir recreates it
    if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(code ?? '')) throw cause;
    removeIfEmpty(dir); // a leftover empty directory (a crash mid-release) must not block forever
    return false;
  }
}

/** Reap `dir` when its holder is provably gone; a holder that re-took it meanwhile is untouched. */
export function reapIfDead(dir: string, isGone: IsGone = processOwnerIsProvablyGone): void {
  const holder = readHolder(dir);
  if (holder && isGone({ pid: holder.pid, processStart: holder.identity })) {
    removeHolder(dir, holder.nonce);
  }
}

/** Take the lock, or on contention reap a dead holder (first time, then every REAP_EVERY_MS). */
function poll(dir: string, attempt: Attempt, isGone: IsGone, reapedAt: number): number | 'taken' {
  if (tryTake(dir, attempt)) return 'taken';
  if (Date.now() - reapedAt < REAP_EVERY_MS) return reapedAt;
  reapIfDead(dir, isGone);
  return Date.now();
}

const heldError = (dir: string, label: string) =>
  new LockHeldError(dir, label, readHolder(dir)?.pid ?? null);

/** Take the lock for `owner` and return its nonce. Throws LockHeldError rather than ever running unlocked. */
export function acquireProcessLock(
  dir: string,
  { label, waitMs = WAIT_MS, isGone = processOwnerIsProvablyGone, owner }: LockOptions,
): string {
  const attempt = {
    nonce: randomUUID(),
    owner: owner ?? { pid: process.pid, identity: ownIdentity() },
  };
  const deadline = Date.now() + waitMs;
  let reapedAt = Number.NEGATIVE_INFINITY;
  for (let step = poll(dir, attempt, isGone, reapedAt); step !== 'taken';) {
    reapedAt = step;
    if (Date.now() > deadline) throw heldError(dir, label);
    sleepSync(RETRY_MS);
    step = poll(dir, attempt, isGone, reapedAt);
  }
  return attempt.nonce;
}

/** Release only the acquisition `nonce` names; a lock re-taken by anyone else is untouched. */
export const releaseProcessLock = removeHolder;

/** Run `fn` under the lock at `dir`. Throws LockHeldError rather than ever running unlocked. */
export function withProcessLock<T>(dir: string, fn: () => T, options: LockOptions): T {
  if (held.has(dir)) throw heldError(dir, options.label);
  const nonce = acquireProcessLock(dir, options);
  held.add(dir);
  try {
    const result = fn();
    // A promise would escape the lock: the finally below runs before its awaited half.
    if (result instanceof Promise)
      throw new TypeError('withProcessLock takes a synchronous callback');
    return result;
  } finally {
    held.delete(dir);
    releaseProcessLock(dir, nonce);
  }
}
