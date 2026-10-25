import { execFileSync } from 'node:child_process';
import { splitGitPaths } from '../ratchets/git-paths.mjs';
import { commitIndexEnv } from '../ratchets/commit-index.mjs';
// Splits the MATCHER_CHANGED_FILES comma/newline list into individual paths.
const PATH_SEP = /[\n,]/;
const split = (raw) => raw
    .split(PATH_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
const gitPaths = (args, cwd) => {
    try {
        return splitGitPaths(execFileSync('git', args, { cwd, env: commitIndexEnv(cwd) }));
    }
    catch {
        return null;
    }
};
/**
 * Staged file set for `--changed` gating, shared by matcher.mjs and clone-detector.mjs.
 *
 * Source: explicit `MATCHER_CHANGED_FILES` (comma/newline list — tests, or a caller that has
 * already computed the set) is taken VERBATIM; otherwise it is derived from git as
 * `staged ∖ has-unstaged-edits`. That subtraction is not an optimisation: both detectors read
 * the WORKING TREE (jscpd opens files on disk; the matcher reads index rows built from disk),
 * so for a partially-staged file the content they judge is not the content being committed —
 * gating on it blocks a commit over code that isn't in it. Dropping those files makes the
 * scoped gate honest, but means partially-staged files are explicitly not semantically verified;
 * callers that require that coverage must stage the whole file before committing.
 *
 * A git failure → empty set (nothing scoped in). A name that is not valid UTF-8 is dropped on
 * its own; a dropped staged name is reported on stderr, since neither gate judges it.
 * @param cwd repo root for the git fallback.
 */
export function loadChangedSet(cwd) {
    const env = process.env.MATCHER_CHANGED_FILES;
    if (env != null)
        return new Set(split(env));
    const staged = gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'], cwd);
    const unstaged = gitPaths(['diff', '--name-only', '-z'], cwd);
    if (!staged || !unstaged)
        return new Set();
    if (staged.undecodable > 0) {
        console.error(`changed-files: ${staged.undecodable} staged path(s) not valid UTF-8, not dup/clone-checked`);
    }
    const dirty = new Set(unstaged.paths);
    return new Set(staged.paths.filter((f) => !dirty.has(f)));
}
