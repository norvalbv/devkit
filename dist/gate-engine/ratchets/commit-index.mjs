// The index the pending commit is built from (`commit -a`, `commit -- <path>`, an alternate index).
// Why a carrier instead of GIT_INDEX_FILE: docs/decisions/gates-judge-commit-index.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
function runGit(root, args, env) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status === 0)
        return { ok: true, out: result.stdout.replace(/\n$/, '') };
    const reason = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    return { ok: false, error: `git ${args[0]}: ${reason}` };
}
// Unsplit, so the write lands in the copy alone and never adds a sharedindex.* to the git dir.
// Env, not `-c`: argv stays `write-tree`, the shape wrappers and shims match on.
function scratchIndexEnv(env, copy) {
    const configs = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
    const slot = Number.isSafeInteger(configs) && configs > 0 ? configs : 0;
    return {
        ...env,
        GIT_INDEX_FILE: copy,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_COUNT: String(slot + 1),
        [`GIT_CONFIG_KEY_${slot}`]: 'core.splitIndex',
        [`GIT_CONFIG_VALUE_${slot}`]: 'false',
    };
}
function gitOut(root, args, env) {
    const run = runGit(root, args, env);
    if (!run.ok)
        throw new Error(run.error);
    return run.out;
}
/** Runs `run` with git env aimed at a private copy of the commit index, inside a scratch dir that is
 * removed afterwards, so the real index is never locked or written. Throws git's own error. */
export function withIndexCopy(root, run, { base = process.env, dir = tmpdir() } = {}) {
    const env = commitIndexEnv(root, base);
    const index = resolve(root, gitOut(root, ['rev-parse', '--git-path', 'index'], env));
    const scratch = mkdtempSync(join(dir, 'devkit-tree-index-'));
    try {
        const copy = join(scratch, 'index');
        const copyEnv = scratchIndexEnv(env, copy);
        if (existsSync(index))
            copyFileSync(index, copy);
        else
            gitOut(root, ['read-tree', '--empty'], copyEnv);
        return run(copyEnv, scratch);
    }
    finally {
        try {
            rmSync(scratch, { recursive: true, force: true });
        }
        catch {
            // A leaked scratch dir costs disk, never the verdict: commitIndexTree must never throw.
        }
    }
}
/** The commit index's tree, hashed from a private copy: write-tree takes its index's lock and dies
 * when it is held, so parallel gates hashing the same index raced each other. Never throws. */
export function commitIndexTree(root, base = process.env, dir) {
    try {
        const tree = withIndexCopy(root, (env) => gitOut(root, ['write-tree'], env), { base, dir });
        return tree ? { tree } : { tree: null, error: 'git write-tree: no tree' };
    }
    catch (error) {
        return { tree: null, error: error instanceof Error ? error.message : String(error) };
    }
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
