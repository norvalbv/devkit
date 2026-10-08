/**
 * Crash-safe file write for the CLI layer: write a same-directory temp, then rename it over the
 * target. rename() is atomic on a single filesystem, so a reader (or a crash) never sees a
 * half-written file — only the old contents or the new, never a torn mix. The temp suffix is
 * UNIQUE (pid + timestamp) so two callers writing the same target never collide on the temp name.
 *
 * Shared by the ship manifest writer (cli/lib/ship/reconcile-manifest-write.mjs) and reconcile's
 * pruneBranch (cli/lib/reconcile.mjs) — both mutate .devkit/reconcile-manifest.json. writeFileAtomic
 * only guarantees a single write is never torn; the lost-update race (two read-modify-write callers)
 * is guarded by `withLock` below (over gate-engine/judge/process/process-lock.mts). devkit
 * init/upgrade hold `withLockAsync` across their whole async run (cli/lib/install/init/init-lock.mts).
 *
 * Distinct from the two gate-engine/<engine>/atomic-write.mjs copies on purpose: a gate-engine ships
 * its own copy to stay independently vendorable (no cross-engine import), whereas cli/ has one home.
 */
import { renameSync, writeFileSync } from 'node:fs';
import {
  withProcessLock,
  withProcessLockAsync,
} from '../../gate-engine/judge/process/process-lock.mts';

export { LockHeldError } from '../../gate-engine/judge/process/process-lock.mts';

export function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

/** Mutex for the CLI's read-modify-write callers (a sub-ms section; throws rather than write unlocked). */
export function withLock<T>(lockDir: string, fn: () => T): T {
  return withProcessLock(lockDir, fn, { label: 'manifest' });
}

/** withLock for an awaiting critical section; after `waitMs` the caller gets a LockHeldError. */
export function withLockAsync<T>(
  lockDir: string,
  fn: () => Promise<T>,
  { waitMs }: { waitMs?: number } = {},
): Promise<T> {
  return withProcessLockAsync(lockDir, fn, { label: 'init', waitMs });
}
