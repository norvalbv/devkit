import { execSync } from 'node:child_process';
// Splits MATCHER_CHANGED_FILES / `git diff` output into individual paths.
const PATH_SEP = /[\n,]/;
/**
 * Staged file set for `--changed` gating, shared by matcher.mjs and
 * clone-detector.mjs. Source: explicit `MATCHER_CHANGED_FILES` (comma/newline
 * list — tests + the pre-commit hook, which has already computed the staged
 * set), else `git diff --cached`. A git failure → empty set (nothing scoped in).
 * @param cwd repo root for the git fallback.
 */
export function loadChangedSet(cwd) {
    const env = process.env.MATCHER_CHANGED_FILES;
    let raw = env;
    if (raw == null) {
        try {
            raw = execSync('git diff --cached --name-only --diff-filter=ACM', { cwd, encoding: 'utf8' });
        }
        catch {
            raw = '';
        }
    }
    return new Set(raw
        .split(PATH_SEP)
        .map((s) => s.trim())
        .filter(Boolean));
}
