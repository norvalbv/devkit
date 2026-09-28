// The index the pending commit is built from (`commit -a`, `commit -- <path>`, an alternate index).
// Why a carrier instead of GIT_INDEX_FILE: docs/decisions/gates-judge-commit-index.md.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { withoutGitEnv } from '../judge/judge-isolation.mjs';
export const COMMIT_INDEX_FILE_VAR = 'DEVKIT_COMMIT_INDEX_FILE';
export const COMMIT_GIT_DIR_VAR = 'DEVKIT_COMMIT_GIT_DIR';
const PARTIAL_INDEX_RE = /^next-index-\d+\.lock$/;
const gitDirs = new Map();
function canonical(path) {
    try {
        return realpathSync.native(path);
    }
    catch {
        return null;
    }
}
function gitDirOf(root) {
    const key = resolve(root);
    const cached = gitDirs.get(key);
    if (cached !== undefined)
        return cached;
    let gitDir = null;
    try {
        gitDir = canonical(execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
            cwd: key,
            encoding: 'utf8',
            env: withoutGitEnv(),
            stdio: ['ignore', 'pipe', 'ignore'],
        }).replace(/\n$/, ''));
    }
    catch {
        gitDir = null;
    }
    gitDirs.set(key, gitDir);
    return gitDir;
}
/** The commit's index path when the carrier was exported by `root`'s own repository, else null. */
export function commitIndexFile(root, base = process.env) {
    const carrier = base[COMMIT_INDEX_FILE_VAR];
    const carrierGitDir = base[COMMIT_GIT_DIR_VAR];
    if (!carrier || !carrierGitDir)
        return null;
    const own = gitDirOf(root);
    if (!own || own !== canonical(carrierGitDir))
        return null;
    return carrier;
}
/** `base` with GIT_INDEX_FILE aimed at the commit's index; an explicit GIT_INDEX_FILE always wins. */
export function commitIndexEnv(root, base = process.env) {
    if (base.GIT_INDEX_FILE)
        return base;
    const index = commitIndexFile(root, base);
    return index ? { ...base, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' } : base;
}
// Classifies the index commitIndexEnv resolves to: a caller-chosen GIT_INDEX_FILE is theirs, not git's.
export function commitIndexKind(root, base = process.env) {
    if (base.GIT_INDEX_FILE)
        return 'default';
    const index = commitIndexFile(root, base);
    if (!index)
        return 'default';
    if (canonical(dirname(index)) !== gitDirOf(root))
        return 'alternate';
    const name = basename(index);
    if (name === 'index.lock')
        return 'lock';
    if (PARTIAL_INDEX_RE.test(name))
        return 'partial';
    return 'alternate';
}
/** Test seam: forget memoized git dirs (a test re-initialises a repository at the same path). */
export function resetCommitIndexCache() {
    gitDirs.clear();
}
