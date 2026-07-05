/**
 * Crash-safe file write: write a same-directory temp, then rename it over the target.
 * rename() is atomic on a single filesystem, so a reader (or a crash) never sees a
 * half-written file — it sees either the old contents or the new, never a torn mix.
 * Same dir (not os.tmpdir) keeps temp + target on one fs so the rename stays atomic.
 *
 * No lock: this guards torn/corrupt writes, not the cross-process lost-update race (two
 * read-modify-write callers racing — last rename wins). That's low-severity and self-
 * correcting for the decision log (an append-only store written by a single committer at
 * a time). On a mid-write throw the `.tmp` may leak — acceptable (rare, harmless,
 * distinctly named).
 *
 * Lives in the decisions engine so the engine has no cross-engine dependency: the
 * co-occurrence engines ship their own copy of this same primitive.
 */

// Reason: each gate-engine ships its OWN copy of this primitive so engines stay independently vendorable with no cross-engine import (documented in the files)
// fallow-ignore-next-line code-duplication
import { renameSync, writeFileSync } from 'node:fs';

export function writeFileAtomic(path: string, contents: string) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}
