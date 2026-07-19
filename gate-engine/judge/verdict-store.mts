/**
 * Shared keyed pass-cache store for gate verdicts (review PASSes, decisions ROUTINE/ALIGN,
 * the deterministic-prefix all-green key). One JSON file per CONSUMER repo under `.devkit/`
 * (never shipped — per-repo data). Lives in the judge domain because it is a shared service
 * the verdict-producing engines already depend on (run-judge, judge-isolation): one store
 * here instead of a vendored copy per engine.
 *
 * Path anchors to the MAIN checkout's `.devkit/` via `git rev-parse --git-common-dir`: a
 * linked worktree (devkit ship) resolves to the same file as the main tree, so a verdict
 * earned before shipping costs nothing inside the ship worktree. Fallback (not a repo /
 * git absent) is the cwd — degraded but functional. A managed review run instead resolves to
 * its own private data root (fail-closed) so review verdicts never leak into the ship store.
 *
 * Writes are atomic (same-directory temp + rename) and now owner-fenced: an exclusive directory
 * lock closes the old cross-process lost-UPDATE race (two read-merge-write callers, last rename
 * wins) so a concurrent ship in a sibling worktree can no longer silently drop prior entries.
 * Live owners never expire; owner-specific reaping requires proven process death/PID reuse.
 *
 * Failure direction: corrupt/unreadable store reads as EMPTY (re-run the gate, never skip);
 * a failed write (or an unacquirable lock) is swallowed (the verdict stands for this run, it
 * just isn't remembered) — degraded toward re-review, never a false PASS.
 */
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 100;
const MAX_STORE_SIZE = 4 * 1024 * 1024;
const MAX_OWNER_SIZE = 1_024;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 10;
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_REAPER_SUFFIX = '.reaper';
const GENERATION_SUFFIX = '.generation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_START = /^(?:node|ps):.+/;
const lockWaiter = new Int32Array(new SharedArrayBuffer(4));
/** One cached verdict's metadata. `at` (ISO timestamp) is used for newest-first pruning; callers
 * attach further fields (e.g. `model`), so the shape stays open. */
export interface VerdictMeta {
  at?: string;
  [key: string]: unknown;
}
type LegacyStore = { entries: Record<string, VerdictMeta>; version: 1 };
type GeneratedStore = { entries: Record<string, VerdictMeta>; generation: string; version: 2 };
type ParsedStore = LegacyStore | GeneratedStore;
type LockOwner = { fenced: boolean; pid: number; processStart: string; token: string };
type LockHandle = { lockDir: string; owner: LockOwner; owns: () => boolean };
type GenerationState = { kind: 'absent' | 'invalid' } | { kind: 'valid'; value: string };
type ActiveStore = { entries: Record<string, VerdictMeta>; generation: string | null };
/** Deterministic concurrency seams used only by the cross-process regression tests. */
export interface SaveEntriesOptions {
  afterLoad?: () => void;
  afterAbandonedOwnerChecked?: () => void;
  afterFinalStoreOwnershipCheck?: () => void;
  afterLockCandidateReady?: () => void;
  afterStoreFenceCheck?: () => void;
  beforeLockRemoval?: () => void;
}
function reviewDataRoot(): string {
  const configured = process.env.DEVKIT_REVIEW_DATA_ROOT;
  const invalid = (): never => {
    throw new Error(
      'DEVKIT_REVIEW_DATA_ROOT must name an absolute, existing physical directory during devkit review',
    );
  };
  if (!configured || configured.includes('\0') || !path.isAbsolute(configured)) return invalid();
  const requested = path.resolve(configured);
  try {
    const stat = lstatSync(requested);
    const physical = realpathSync(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink() || physical !== requested) return invalid();
    return physical;
  } catch {
    return invalid();
  }
}
/** Absolute path of a `.devkit/<relName>` data file: the managed-review private root when a review
 * run is active, else anchored to the main checkout so linked ship worktrees share one file. */
export function devkitDataFile(cwd: string, relName: string): string {
  const privateReview =
    Boolean(process.env.DEVKIT_REVIEW_ID) || process.env.DEVKIT_REVIEW_DATA_ROOT !== undefined;
  if (process.env.DEVKIT_RUN_MODE === 'review' && privateReview)
    return path.join(reviewDataRoot(), relName);
  let root = cwd;
  try {
    const common = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf8' }).trim();
    root = path.dirname(path.isAbsolute(common) ? common : path.resolve(cwd, common));
  } catch {
    // not a repo / git absent → per-cwd store (degraded but functional)
  }
  return path.join(root, '.devkit', relName);
}
function errorCode(cause: unknown, ...codes: string[]): boolean {
  return cause instanceof Error && 'code' in cause && codes.includes(String(cause.code));
}
function verdictEntries(value: unknown): Record<string, VerdictMeta> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const meta of Object.values(value)) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  }
  return value as Record<string, VerdictMeta>;
}
function parsedStore(file: string): ParsedStore | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_SIZE) return null;
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const entries = verdictEntries(value?.entries);
    if (!entries) return null;
    if (value.version === 1) return { version: 1, entries };
    if (
      value.version === 2 &&
      typeof value.generation === 'string' &&
      UUID.test(value.generation)
    ) {
      return { version: 2, generation: value.generation, entries };
    }
    return null;
  } catch {
    return null;
  }
}
function generationState(file: string): GenerationState {
  const generationFile = `${file}${GENERATION_SUFFIX}`;
  try {
    const stat = lstatSync(generationFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) return { kind: 'invalid' };
    const raw = readFileSync(generationFile, 'utf8');
    const value = raw.endsWith('\n') ? raw.slice(0, -1) : '';
    return UUID.test(value) && raw === `${value}\n`
      ? { kind: 'valid', value }
      : { kind: 'invalid' };
  } catch (cause) {
    return errorCode(cause, 'ENOENT', 'ENOTDIR') ? { kind: 'absent' } : { kind: 'invalid' };
  }
}
function sameGeneration(left: GenerationState, right: GenerationState): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'valid' || (right.kind === 'valid' && left.value === right.value))
  );
}
function activeStore(file: string): ActiveStore {
  const before = generationState(file);
  const store = parsedStore(file);
  const after = generationState(file);
  if (!sameGeneration(before, after)) return { generation: null, entries: {} };
  if (before.kind === 'absent' && store?.version === 1) {
    return { generation: null, entries: store.entries };
  }
  if (before.kind === 'valid' && store?.version === 2 && store.generation === before.value) {
    return { generation: before.value, entries: store.entries };
  }
  return { generation: before.kind === 'valid' ? before.value : null, entries: {} };
}
export function loadEntries(file: string): Record<string, VerdictMeta> {
  return activeStore(file).entries;
}
export function verdictStoreGeneration(file: string): string | null {
  const state = generationState(file);
  return state.kind === 'valid' ? state.value : null;
}
function newestEntries(entries: Record<string, VerdictMeta>): Record<string, VerdictMeta> {
  return Object.fromEntries(
    Object.entries(entries)
      .sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')))
      .slice(0, MAX_ENTRIES),
  );
}
function writeAtomic(
  destination: string,
  contents: string,
  handle: LockHandle,
  afterFenceCheck?: () => void,
  afterFinalOwnershipCheck?: () => void,
): void {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (!handle.owns()) throw new Error('verdict store lock ownership changed before publication');
    afterFenceCheck?.();
    if (!handle.owns()) throw new Error('verdict store lock ownership changed during publication');
    afterFinalOwnershipCheck?.();
    renameSync(temporary, destination);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // never created, or already renamed
    }
  }
}
function writeStore(
  file: string,
  generation: string,
  entries: Record<string, VerdictMeta>,
  handle: LockHandle,
  afterFenceCheck?: () => void,
  afterFinalOwnershipCheck?: () => void,
): void {
  writeAtomic(
    file,
    `${JSON.stringify({ version: 2, generation, entries })}\n`,
    handle,
    afterFenceCheck,
    afterFinalOwnershipCheck,
  );
}
function writeGeneration(file: string, generation: string, handle: LockHandle): void {
  writeAtomic(`${file}${GENERATION_SUFFIX}`, `${generation}\n`, handle);
}
function ensureGeneratedStore(
  file: string,
  handle: LockHandle,
  active = activeStore(file),
): ActiveStore & { generation: string } {
  if (active.generation) return { ...active, generation: active.generation };
  const generation = randomUUID();
  writeStore(file, generation, active.entries, handle);
  writeGeneration(file, generation, handle);
  return { generation, entries: active.entries };
}
function fenceLock(handle: LockHandle): void {
  if (handle.owner.fenced) return;
  if (!handle.owns()) throw new Error('verdict store lock ownership changed before fencing');
  const fenced = { ...handle.owner, fenced: true };
  const ownerPath = path.join(handle.lockDir, LOCK_OWNER_FILE);
  const temporary = `${ownerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(fenced)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (!handle.owns()) throw new Error('verdict store lock ownership changed while fencing');
    renameSync(temporary, ownerPath);
    handle.owner = fenced;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // never created, or already renamed
    }
  }
}
function publishMergedEntries(
  file: string,
  keyToMeta: Record<string, VerdictMeta>,
  active: ActiveStore,
  handle: LockHandle,
  options: SaveEntriesOptions,
): void {
  const generated = ensureGeneratedStore(file, handle, active);
  const merged = newestEntries({ ...generated.entries, ...keyToMeta });
  options.afterLoad?.();
  writeStore(
    file,
    generated.generation,
    merged,
    handle,
    options.afterStoreFenceCheck,
    options.afterFinalStoreOwnershipCheck,
  );
}
export function saveEntries(
  file: string,
  keyToMeta: Record<string, VerdictMeta>,
  options: SaveEntriesOptions = {},
): boolean {
  return withStoreLock(file, options, (handle) => {
    fenceLock(handle);
    publishMergedEntries(file, keyToMeta, activeStore(file), handle, options);
  });
}
export function saveEntriesIfGeneration(
  file: string,
  expectedGeneration: string | null,
  keyToMeta: Record<string, VerdictMeta>,
): 'saved' | 'generation-changed' | 'failed' {
  let result: 'saved' | 'generation-changed' | 'failed' = 'failed';
  const completed = withStoreLock(file, {}, (handle) => {
    const active = activeStore(file);
    if (active.generation !== expectedGeneration) {
      result = 'generation-changed';
      return;
    }
    fenceLock(handle);
    publishMergedEntries(file, keyToMeta, active, handle, {});
    result = 'saved';
  });
  return completed ? result : 'failed';
}
export function replaceEntries(file: string, entries: Record<string, VerdictMeta>): boolean {
  return withStoreLock(file, {}, (handle) => {
    fenceLock(handle);
    const generation = randomUUID();
    writeGeneration(file, generation, handle);
    writeStore(file, generation, newestEntries(entries), handle);
  });
}
export function clearEntries(file: string): boolean {
  return replaceEntries(file, {});
}
function psProcessStart(pid: number): string | null {
  try {
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' },
      maxBuffer: 1_024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    })
      .trim()
      .replace(/\s+/g, ' ');
    return value || null;
  } catch {
    return null;
  }
}
const ownProcessStart =
  psProcessStart(process.pid)?.replace(/^/, 'ps:') ??
  `node:${Math.round(Date.now() - process.uptime() * 1_000)}`;
function lockOwner(lockDir: string): LockOwner | null {
  try {
    const ownerPath = path.join(lockDir, LOCK_OWNER_FILE);
    const stat = lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OWNER_SIZE) return null;
    const value = JSON.parse(readFileSync(ownerPath, 'utf8')) as Partial<LockOwner>;
    if (
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.fenced !== 'boolean' ||
      typeof value.processStart !== 'string' ||
      !PROCESS_START.test(value.processStart) ||
      value.processStart.length > 256 ||
      typeof value.token !== 'string' ||
      !UUID.test(value.token)
    ) {
      return null;
    }
    return {
      fenced: value.fenced,
      pid: value.pid,
      processStart: value.processStart,
      token: value.token,
    };
  } catch {
    return null;
  }
}
function sameOwner(left: LockOwner | null, right: LockOwner): boolean {
  return (
    left?.pid === right.pid &&
    left.processStart === right.processStart &&
    left.token === right.token
  );
}
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !errorCode(cause, 'ESRCH');
  }
}
function ownerIsProvablyGone(owner: LockOwner): boolean {
  if (!processIsAlive(owner.pid)) return true;
  if (!owner.processStart.startsWith('ps:')) return false;
  const observedStart = psProcessStart(owner.pid);
  return observedStart !== null && `ps:${observedStart}` !== owner.processStart;
}
function removeClaimedLock(lockDir: string): void {
  try {
    unlinkSync(path.join(lockDir, LOCK_OWNER_FILE));
    rmdirSync(lockDir);
  } catch {
    // Identity changed, extra contents appeared, or permissions deny cleanup: leave it fail-safe.
  }
}
function restoreClaim(claimed: string, lockDir: string): void {
  try {
    renameSync(claimed, lockDir);
  } catch {
    // A non-protocol actor replaced the path: preserve both owners rather than deleting either.
  }
}
function retireDeadOwner(lockDir: string, owner: LockOwner): boolean {
  const claimed = `${lockDir}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockDir, claimed);
  } catch {
    return false;
  }
  const captured = lockOwner(claimed);
  if (!sameOwner(captured, owner) || !captured || !ownerIsProvablyGone(captured)) {
    restoreClaim(claimed, lockDir);
    return false;
  }
  removeClaimedLock(claimed);
  return true;
}
function reapAbandonedLock(lockDir: string, options: SaveEntriesOptions): boolean {
  const observed = lockOwner(lockDir);
  if (!observed || !ownerIsProvablyGone(observed)) return false;
  const reaper = acquireReaperClaim(lockDir, observed);
  if (!reaper) return false;
  try {
    const current = lockOwner(lockDir);
    if (!sameOwner(current, observed) || !current || !ownerIsProvablyGone(current)) return false;
    options.afterAbandonedOwnerChecked?.();
    if (!reaper.owns() || !sameOwner(lockOwner(lockDir), observed)) return false;
    return retireDeadOwner(lockDir, observed);
  } finally {
    removeOwnedLock(reaper, {});
  }
}
function removeCandidate(candidate: string, owner: LockOwner): void {
  if (sameOwner(lockOwner(candidate), owner)) removeClaimedLock(candidate);
}
function lockContention(cause: unknown): boolean {
  return errorCode(cause, 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR');
}
function candidateOwner(): LockOwner {
  return { fenced: false, pid: process.pid, processStart: ownProcessStart, token: randomUUID() };
}
function publishCandidate(lockDir: string, owner: LockOwner): string {
  const candidate = `${lockDir}.candidate.${process.pid}.${owner.token}`;
  mkdirSync(candidate);
  writeFileSync(path.join(candidate, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return candidate;
}
function acquireReaperClaim(lockDir: string, target: LockOwner): LockHandle | null {
  const claimDir = `${lockDir}${LOCK_REAPER_SUFFIX}.${target.token}`;
  const owner = candidateOwner();
  let candidate = '';
  try {
    candidate = publishCandidate(claimDir, owner);
    try {
      renameSync(candidate, claimDir);
    } catch (cause) {
      if (!lockContention(cause)) return null;
      const stale = lockOwner(claimDir);
      if (!stale || !ownerIsProvablyGone(stale) || !retireDeadOwner(claimDir, stale)) return null;
      renameSync(candidate, claimDir);
    }
    return { lockDir: claimDir, owner, owns: () => sameOwner(lockOwner(claimDir), owner) };
  } catch {
    return null;
  } finally {
    if (candidate) removeCandidate(candidate, owner);
  }
}
function acquireStoreLock(file: string, options: SaveEntriesOptions): LockHandle | null {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const owner = candidateOwner();
  let candidate = '';
  try {
    candidate = publishCandidate(lockDir, owner);
    options.afterLockCandidateReady?.();
    do {
      try {
        renameSync(candidate, lockDir);
        return { lockDir, owner, owns: () => sameOwner(lockOwner(lockDir), owner) };
      } catch (cause) {
        if (!lockContention(cause)) return null;
        reapAbandonedLock(lockDir, options);
      }
      Atomics.wait(lockWaiter, 0, 0, LOCK_POLL_MS);
    } while (Date.now() <= deadline);
  } catch {
    // A failed candidate never owns the published lock path.
  } finally {
    removeCandidate(candidate, owner);
  }
  return null;
}
function removeOwnedLock(handle: LockHandle, options: SaveEntriesOptions): void {
  options.beforeLockRemoval?.();
  const claimed = `${handle.lockDir}.release.${handle.owner.token}.${randomUUID()}`;
  try {
    renameSync(handle.lockDir, claimed);
  } catch {
    return;
  }
  const captured = lockOwner(claimed);
  if (!sameOwner(captured, handle.owner)) restoreClaim(claimed, handle.lockDir);
  else removeClaimedLock(claimed);
}
function withStoreLock(
  file: string,
  options: SaveEntriesOptions,
  mutation: (handle: LockHandle) => void,
): boolean {
  let handle: LockHandle | null = null;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    handle = acquireStoreLock(file, options);
    if (!handle) return false;
    mutation(handle);
    return true;
  } catch {
    return false;
  } finally {
    if (handle) removeOwnedLock(handle, options);
  }
}
