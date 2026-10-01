// Short mutex for the ship queue's critical sections. The holder file is NAMED by its nonce, so
// renaming `<lock>/<nonce>` away is an atomic compare-and-delete: it can only ever remove that holder.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { processOwnerIsProvablyGone, processStartIdentity, } from '../../../../gate-engine/judge/process/identity.mjs';
const WAIT_MS = 5_000;
const RETRY_MS = 10;
export const LOCK_TIMEOUT_PREFIX = 'timed out acquiring queue lock';
const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
function errnoCode(cause) {
    return cause instanceof Error && 'code' in cause ? String(cause.code) : undefined;
}
function readHolder(dir) {
    try {
        const [nonce] = readdirSync(dir);
        if (!nonce)
            return undefined;
        const [pid, identity] = readFileSync(join(dir, nonce), 'utf8').split('\n');
        return Number.isSafeInteger(Number(pid)) && identity
            ? { nonce, pid: Number(pid), identity }
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** Remove exactly `nonce`'s holder file, then the directory only if that left it empty. */
function removeHolder(dir, nonce) {
    const grave = `${dir}.grave-${randomUUID()}`;
    try {
        renameSync(join(dir, nonce), grave);
    }
    catch {
        return; // already gone: another reaper, or never ours
    }
    rmSync(grave, { force: true });
    removeIfEmpty(dir);
}
/** rmdir refuses a non-empty directory, so this can never remove a lock someone holds. */
function removeIfEmpty(dir) {
    try {
        rmdirSync(dir);
    }
    catch {
        // held again (not empty) or already gone
    }
}
/** One attempt: move a directory holding our nonce file onto `dir`. Fails while `dir` is held. */
function tryTake(dir, nonce) {
    const staged = `${dir}.new-${nonce}`;
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, nonce), `${process.pid}\n${processStartIdentity()}`);
    try {
        renameSync(staged, dir);
        return true;
    }
    catch (cause) {
        rmSync(staged, { recursive: true, force: true });
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(errnoCode(cause) ?? ''))
            throw cause;
        removeIfEmpty(dir); // a leftover empty directory (a crash mid-release) must not block forever
        return false;
    }
}
/** Reap `dir` when its holder is provably gone; a holder that re-took it meanwhile is untouched. */
export function reapIfDead(dir, isGone = processOwnerIsProvablyGone) {
    const holder = readHolder(dir);
    if (holder && isGone({ pid: holder.pid, processStart: holder.identity })) {
        removeHolder(dir, holder.nonce);
    }
}
/** Run `fn` under the lock at `dir`. Throws LOCK_TIMEOUT_PREFIX… rather than ever running unlocked. */
export function withQueueLock(dir, fn, isGone = processOwnerIsProvablyGone) {
    const nonce = randomUUID();
    const deadline = Date.now() + WAIT_MS;
    while (!tryTake(dir, nonce)) {
        reapIfDead(dir, isGone);
        if (Date.now() > deadline)
            throw new Error(`${LOCK_TIMEOUT_PREFIX}: ${dir}`);
        sleepSync(RETRY_MS);
    }
    try {
        const result = fn();
        // A promise would escape the lock: the finally below runs before its awaited half.
        if (result instanceof Promise)
            throw new TypeError('withQueueLock takes a synchronous callback');
        return result;
    }
    finally {
        removeHolder(dir, nonce);
    }
}
