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
export function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
/**
 * Staged paths, VERBATIM. `-z` (NUL-delimited) is load-bearing, not a style choice: plain
 * `--name-only` C-quotes any path holding a tab/newline/quote (`tab\tx.ts` → `"tab\tx.ts"`), and
 * line-splitting cannot recover the original bytes. Both copies this replaced also trimmed each
 * record, which silently ate the REAL leading spaces of a `  x.ts` (git emits those unquoted).
 *
 * Either mangling is a live correctness hole downstream, because these names are fed straight back
 * to git: check-alignment passes them to `git diff --cached -- <paths>` (a mangled name matches
 * nothing, so the gate judges a partial diff and under-reports), and detect matches them against
 * decisionFileRe (a trailing `"` breaks the `\.md$` anchor, so a staged decision reads as absent
 * and the gate blocks claiming none was recorded).
 */
export function stagedFiles(cwd) {
    return git(cwd, ['diff', '--cached', '--name-only', '-z'])
        .split('\0')
        .filter((s) => s.length > 0);
}
