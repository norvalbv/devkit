// Scope miss: one staged decision record beside source files its Scope matches none of.
// Advisory only, never an exit code; two or more staged records are cross-cutting and stay silent.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveFromCwd, resolveGuardConfig, TEST_INFIX } from '../../config.mjs';
import { git, stagedFiles } from '../git-io.mjs';
// Anything else could split the glob list, act as a glob, or break the pasted shell command.
const SAFE_PATH_RE = /^[\w./@+-]+$/;
const SAFE_GLOB_RE = /^[\w./*@+-]+$/;
/** The rescope that adds `added` to a Scope. It keeps `globs`, because a rescope REPLACES the Scope. */
export function rescopeCommand(slug, globs, added, reason) {
    return `guard-decisions rescope ${slug} --scope "${[...globs, ...added].join(',')}" --reason "${reason}"`;
}
function isTestPath(file) {
    return TEST_INFIX.test(file) || file.split('/').includes('__tests__');
}
/** The one record a commit stages, with its non-test source files; null for any other shape. */
export function soleRecordChange(staged, decisionsRel) {
    const prefix = decisionsRel ? `${decisionsRel}/` : '';
    const isLogFile = (f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/') && f.endsWith('.md');
    const records = staged.filter((f) => isLogFile(f) && f !== `${prefix}INDEX.md`);
    if (records.length !== 1)
        return null;
    const changed = staged.filter((f) => !isLogFile(f));
    const files = changed.filter((f) => !isTestPath(f));
    if (!files.length || ![records[0], ...files].every((f) => SAFE_PATH_RE.test(f)))
        return null;
    return { record: records[0], slug: path.posix.basename(records[0], '.md'), changed, files };
}
/** The miss, given the record's effective Scope globs; null when the Scope is empty or matches. */
export function scopeMiss(change, globs, matches) {
    if (!globs.length || !globs.every((g) => SAFE_GLOB_RE.test(g)))
        return null;
    if (matches(change.changed, globs))
        return null;
    return { slug: change.slug, globs, files: change.files };
}
export function renderScopeMiss({ slug, globs, files }) {
    const command = rescopeCommand(slug, globs, files, 'this commit records a ruling on these files');
    return (`ℹ decision-gate: ${slug}'s Scope (${globs.join(',')}) matches none of the files this commit ` +
        `changes with it. If it governs them: ${command}; if not, ignore this.`);
}
/** The advisory line for the staged change in `cwd`, or '' — fail-open on any error. */
export async function scopeMissAdvisory(cwd = process.cwd()) {
    try {
        const dir = resolveFromCwd(resolveGuardConfig(cwd), 'decisionsDir');
        if (!dir)
            return '';
        // Staged paths are toplevel-relative, and the hook may run from a package subdirectory.
        const top = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim());
        const rel = path.relative(top, realpathSync(dir)).split(path.sep).join('/');
        // Deletions are left out: prefilling a deleted file would add a glob that matches nothing.
        const change = soleRecordChange(stagedFiles(cwd, 'd'), rel);
        if (!change)
            return '';
        const [{ parseDecision }, { effectiveScope }, { matchScope }] = await Promise.all([
            import('../decision-format.mjs'),
            import('../recall/retrieval.mjs'),
            import('../check-alignment.mjs'),
        ]);
        const blob = git(top, ['show', `:${change.record}`]);
        const globs = effectiveScope(parseDecision(blob).body)
            .split(',')
            .map((g) => g.trim())
            .filter(Boolean);
        const miss = scopeMiss(change, globs, matchScope);
        return miss ? renderScopeMiss(miss) : '';
    }
    catch {
        return '';
    }
}
