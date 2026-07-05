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
import { renameSync, writeFileSync } from 'node:fs';

export function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}
