import { execSync } from 'node:child_process';

// Splits MATCHER_CHANGED_FILES / `git diff` output into individual paths.
const PATH_SEP = /[\n,]/;

const split = (raw: string): string[] =>
  raw
    .split(PATH_SEP)
    .map((s) => s.trim())
    .filter(Boolean);

const gitLines = (cmd: string, cwd: string): string[] => {
  try {
    return split(execSync(cmd, { cwd, encoding: 'utf8' }));
  } catch {
    return [];
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
 * scoped gate honest; the unscoped pre-push net still sees them.
 *
 * A git failure → empty set (nothing scoped in).
 * @param cwd repo root for the git fallback.
 */
export function loadChangedSet(cwd: string): Set<string> {
  const env = process.env.MATCHER_CHANGED_FILES;
  if (env != null) return new Set(split(env));

  const staged = gitLines('git diff --cached --name-only --diff-filter=ACM', cwd);
  const unstaged = new Set(gitLines('git diff --name-only', cwd));
  return new Set(staged.filter((f) => !unstaged.has(f)));
}
