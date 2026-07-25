/**
 * The decisions gates' shared git I/O. `detect` (capture B) and `check-alignment` (capture C) are
 * siblings that each read the SAME staged tree, and each had grown its own byte-identical copy of
 * this wrapper plus its own staged-name listing — the co-occurrence matcher flagged the pair at
 * 0.98/0.96. One home, both callers import it.
 *
 * argv-based on purpose: staged FILENAMES ride these calls, and a shell string (even
 * JSON.stringify-quoted) lets a crafted path like `$(cmd).ts` expand before git runs.
 *
 * Thin by design — no error handling here. A git failure is a real gate failure and belongs to the
 * caller's own try/catch, which decides fail-open vs block for ITS gate. W-3: every call runs in the
 * CONSUMER cwd the caller passes, never the package dir.
 */

import { execFileSync } from 'node:child_process';

/** One `git` invocation in `cwd`, argv-form. Throws on non-zero exit (the caller decides). */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Staged paths (`git diff --cached --name-only`), trimmed, with blank lines dropped. */
export function stagedFiles(cwd: string): string[] {
  return git(cwd, ['diff', '--cached', '--name-only'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
