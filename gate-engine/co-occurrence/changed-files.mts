import { execFileSync } from 'node:child_process';
import { readGitPaths } from '../ratchets/git-paths.mts';
import { commitIndexEnv } from '../ratchets/commit-index.mts';

// Splits the MATCHER_CHANGED_FILES comma/newline list into individual paths.
const PATH_SEP = /[\n,]/;

const split = (raw: string): string[] =>
  raw
    .split(PATH_SEP)
    .map((s) => s.trim())
    .filter(Boolean);

const gitPaths = (args: string[], cwd: string): string[] | null => {
  try {
    return readGitPaths(execFileSync('git', args, { cwd, env: commitIndexEnv(cwd) }));
  } catch {
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
 * A git failure or a non-UTF-8 name → empty set (nothing scoped in).
 * @param cwd repo root for the git fallback.
 */
export function loadChangedSet(cwd: string): Set<string> {
  const env = process.env.MATCHER_CHANGED_FILES;
  if (env != null) return new Set(split(env));

  const staged = gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'], cwd);
  const unstaged = gitPaths(['diff', '--name-only', '-z'], cwd);
  if (!staged || !unstaged) return new Set();
  const dirty = new Set(unstaged);
  return new Set(staged.filter((f) => !dirty.has(f)));
}
