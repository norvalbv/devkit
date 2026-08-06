/**
 * Crash-safe file write for the CLI layer: write a same-directory temp, then rename it over the
 * target. rename() is atomic on a single filesystem, so a reader (or a crash) never sees a
 * half-written file — only the old contents or the new, never a torn mix. The temp suffix is
 * UNIQUE (pid + timestamp) so two callers writing the same target never collide on the temp name.
 *
 * Shared by the ship manifest writer (cli/lib/ship/reconcile-manifest-write.mjs) and reconcile's
 * pruneBranch (cli/lib/reconcile.mjs) — both mutate .devkit/reconcile-manifest.json. writeFileAtomic
 * only guarantees a single write is never torn; the lost-update race (two read-modify-write callers)
 * is guarded by `withLock` below, which both callers wrap their read→modify→write in.
 *
 * Distinct from the two gate-engine/<engine>/atomic-write.mjs copies on purpose: a gate-engine ships
 * its own copy to stay independently vendorable (no cross-engine import), whereas cli/ has one home.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function writeFileAtomic(path, contents) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, path);
}
const LOCK_STALE_MS = 60_000; // age below which a lock is presumed live regardless of its holder
const LOCK_WAIT_MS = 5_000; // total time to retry a contended lock before throwing (never write unlocked)
const LOCK_RETRY_MS = 25; // pause between mkdir attempts, so a contended wait does not spin the CPU
/** The acquisition stamp lives INSIDE the lock dir, so it is created and removed with the lock. */
const holderFile = (lockDir) => join(lockDir, 'holder');
/** Block the calling thread — the critical section is synchronous, so there is no loop to yield to. */
const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
/**
 * Is `pid` still running? EPERM means the process exists but belongs to another uid — still alive.
 * Only ESRCH (no such process) proves death, so every ambiguous answer errs toward "keep waiting".
 */
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e instanceof Error && 'code' in e && e.code === 'EPERM';
    }
}
/** The `<pid>:<uuid>` stamp of the CURRENT acquisition, or null if unreadable (mid-acquire/reaped). */
function readHolder(lockDir) {
    try {
        const stamp = readFileSync(holderFile(lockDir), 'utf8');
        const pid = Number(stamp.split(':')[0]);
        return Number.isInteger(pid) && pid > 0 ? { pid, stamp } : null;
    }
    catch {
        return null;
    }
}
/**
 * Remove `lockDir` only when it is PROVABLY a dead holder's. Age alone is not proof: a live holder
 * that was paused (SIGSTOP, a suspended laptop, a long GC) still owns its lock at 60s, and reaping
 * it would let a second read-modify-write run concurrently with the first.
 *
 * So a reap needs three agreeing facts — stale age, a pid that no longer exists, and a stamp that
 * did not change while we checked. The re-read is what defeats release-and-reacquire: if the holder
 * released and someone else acquired between our two reads, the stamp differs and we leave their
 * (live) lock alone. Residual: a reacquire landing between the re-read and the rmSync below is
 * still possible, but it requires the dead holder's lock to be reaped by a third party inside that
 * window; every wider path is closed. Refusing to reap is always safe — the caller just times out.
 */
function reapIfDead(lockDir) {
    let mtimeMs;
    try {
        mtimeMs = lstatSync(lockDir).mtimeMs;
    }
    catch {
        return; // lock vanished under us — the loop retries the mkdir
    }
    if (Date.now() - mtimeMs <= LOCK_STALE_MS)
        return;
    const before = readHolder(lockDir);
    // An unstamped stale lock is an acquirer that died between its mkdir and its stamp write (a
    // microsecond window); there is no pid to interrogate, so staleness is all the evidence there is.
    if (before && pidAlive(before.pid))
        return;
    if (readHolder(lockDir)?.stamp !== before?.stamp)
        return;
    rmSync(lockDir, { recursive: true, force: true });
}
/**
 * Atomic-mkdir mutex (flock is absent on macOS — verified). The dir IS the lock; mkdir is
 * atomic create-or-fail on every POSIX fs, and the holder stamps its pid inside so ownership can be
 * checked rather than inferred. We only guard a sub-ms read→write→rename, so on contention we retry
 * up to LOCK_WAIT_MS; if still unheld we THROW rather than write unlocked (an unlocked
 * read-modify-write would lose a parallel ship's branch entry). Shared by the two reconcile-manifest
 * mutators named above; both lock a path under the repo's own .devkit/, so the pid check always
 * refers to a process on this machine.
 */
export function withLock(lockDir, fn) {
    const stamp = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (Date.now() <= deadline) {
        try {
            mkdirSync(lockDir);
        }
        catch (e) {
            if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST'))
                throw e;
            reapIfDead(lockDir);
            sleepSync(LOCK_RETRY_MS);
            continue;
        }
        try {
            writeFileSync(holderFile(lockDir), stamp, 'utf8');
        }
        catch (e) {
            rmSync(lockDir, { recursive: true, force: true }); // never leave a lock we cannot prove is ours
            throw e;
        }
        held = true;
        break;
    }
    if (!held)
        throw new Error(`timed out acquiring manifest lock: ${lockDir}`);
    try {
        return fn();
    }
    finally {
        // Release OUR acquisition only. If this lock was wrongly reaped and another process now holds
        // it, an unconditional rmSync here would strip a live holder's lock and admit a third writer.
        if (readHolder(lockDir)?.stamp === stamp)
            rmSync(lockDir, { recursive: true, force: true });
    }
}
