/**
 * Crash-safe file write for the CLI layer: write a same-directory temp, then rename it over the
 * target. rename() is atomic on a single filesystem, so a reader (or a crash) never sees a
 * half-written file — only the old contents or the new, never a torn mix. The temp suffix is
 * UNIQUE (pid + timestamp) so two callers writing the same target never collide on the temp name.
 *
 * Shared by the ship manifest writer (cli/lib/ship/reconcile-manifest-write.mjs) and reconcile's
 * pruneBranch (cli/lib/reconcile.mjs) — both mutate .devkit/reconcile-manifest.json. The lost-update
 * race (two read-modify-write callers) is guarded SEPARATELY by each caller's mkdir-mutex; this
 * function only guarantees a single write is never torn.
 *
 * Distinct from the two gate-engine/<engine>/atomic-write.mjs copies on purpose: a gate-engine ships
 * its own copy to stay independently vendorable (no cross-engine import), whereas cli/ has one home.
 */
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

const LOCK_STALE_MS = 60_000; // a lock dir older than this is a dead writer/reader — reap it
const LOCK_WAIT_MS = 5_000; // total time to retry a contended lock before throwing (never write unlocked)

/**
 * Atomic-mkdir mutex (flock is absent on macOS — verified). The dir IS the lock; mkdir is
 * atomic create-or-fail on every POSIX fs. We only guard a sub-ms read→write→rename, so on
 * contention we retry up to LOCK_WAIT_MS; if still unheld we THROW rather than write unlocked
 * (an unlocked read-modify-write would lose a parallel ship's branch entry). A lock older than
 * 60s is a crashed holder — reap it. Shared by the two reconcile-manifest mutators named above.
 */
export function withLock<T>(lockDir: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockDir);
      held = true;
      break;
    } catch (e: unknown) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
      try {
        if (Date.now() - lstatSync(lockDir).mtimeMs > LOCK_STALE_MS)
          rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* lock vanished under us — loop retries the mkdir */
      }
    }
  }
  if (!held) throw new Error(`timed out acquiring manifest lock: ${lockDir}`);
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
