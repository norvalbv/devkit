/**
 * Crash-safe file write for the CLI layer: write a same-directory temp, then rename it over the
 * target. rename() is atomic on a single filesystem, so a reader (or a crash) never sees a
 * half-written file — only the old contents or the new, never a torn mix. The temp suffix is
 * UNIQUE (pid + timestamp) so two callers writing the same target never collide on the temp name.
 *
 * Shared by the ship manifest writer (cli/lib/ship/reconcile-manifest-write.mjs) and reconcile's
 * pruneBranch (cli/lib/reconcile.mjs) — both mutate .devkit/reconcile-manifest.json. writeFileAtomic
 * only guarantees a single write is never torn; the lost-update race (two read-modify-write callers)
 * is guarded by `withLock` below, which both callers wrap their read→modify→write in. devkit
 * init/upgrade hold `withLockAsync` across their whole async run (cli/lib/install/init/init-lock.mts).
 *
 * Distinct from the two gate-engine/<engine>/atomic-write.mjs copies on purpose: a gate-engine ships
 * its own copy to stay independently vendorable (no cross-engine import), whereas cli/ has one home.
 */
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { withProcessLock, withProcessLockAsync, } from '../../gate-engine/judge/process/process-lock.mjs';
export { LockHeldError } from '../../gate-engine/judge/process/process-lock.mjs';
/** `mode` is applied to the temp before the rename (chmod ignores umask); a failed write leaves no temp. */
export function writeFileAtomic(path, contents, mode) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
        writeFileSync(tmp, contents, 'utf8');
        if (mode !== undefined)
            chmodSync(tmp, mode);
        renameSync(tmp, path);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
/** Mutex for the CLI's read-modify-write callers (a sub-ms section; throws rather than write unlocked). */
export function withLock(lockDir, fn) {
    return withProcessLock(lockDir, fn, { label: 'manifest' });
}
/** withLock for an awaiting critical section; after `waitMs` the caller gets a LockHeldError. */
export function withLockAsync(lockDir, fn, { waitMs } = {}) {
    return withProcessLockAsync(lockDir, fn, { label: 'init', waitMs });
}
