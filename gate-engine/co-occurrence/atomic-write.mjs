// Reason: each gate-engine ships its OWN copy of this primitive so engines stay independently vendorable with no cross-engine import (documented in the files)
// fallow-ignore-next-line code-duplication
import { renameSync, writeFileSync } from 'node:fs';

/**
 * Crash-safe file write: write a same-directory temp, then rename it over the target.
 * rename() is atomic on a single filesystem, so a reader (or a crash) never sees a
 * half-written file — it sees either the old contents or the new, never a torn mix.
 * Same dir (not os.tmpdir) keeps temp + target on one fs so the rename stays atomic.
 *
 * No lock: this guards torn/corrupt writes, not the cross-process lost-update race (two
 * read-modify-write callers racing — last rename wins). That's low-severity + self-correcting
 * for the co-occurrence allowlist. On a mid-write throw the `.tmp` may leak — acceptable
 * (rare, harmless, distinctly named).
 */
export function writeFileAtomic(path, contents) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}
