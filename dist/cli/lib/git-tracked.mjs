/**
 * Is a path already TRACKED by git? The overlay install hides its files via `.git/info/exclude`,
 * which only ignores UNtracked files — a modification to a tracked file still shows in `git status`
 * and can't be hidden. So before overlay writes into a shared tree (`.claude/`, `.cursor/`), it
 * must skip anything git already tracks, or it would dirty the repo it promised not to touch.
 *
 * `git ls-files --error-unmatch <path>` exits 0 iff git tracks <path> (for a directory, iff it
 * tracks ≥1 file under it), and non-zero otherwise — the authoritative "does git track this" probe.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
const TRAILING_SLASH_RE = /\/$/;
/**
 * @param gitRoot the dir holding `.git`
 * @param relPath git-root-relative POSIX path (file or dir)
 * @returns true iff git tracks relPath (or, for a dir, any file under it)
 */
export function isTracked(gitRoot, relPath) {
    try {
        execFileSync('git', ['ls-files', '--error-unmatch', relPath], {
            cwd: gitRoot,
            stdio: 'pipe',
        });
        return true;
    }
    catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 1)
            return false;
        throw error;
    }
}
/** Snapshot tracked files, their directory prefixes, and target-conflict semantics. */
export function realIndexEnvironment() {
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    return env;
}
export function moveTrackedWithGit(gitRoot, source, target) {
    execFileSync('git', ['mv', '--', relative(gitRoot, source), relative(gitRoot, target)], {
        cwd: gitRoot,
        env: realIndexEnvironment(),
    });
}
export function trackedPathState(gitRoot, options = {}) {
    const env = options.realIndex ? realIndexEnvironment() : process.env;
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: gitRoot, env, encoding: 'utf8' });
    const exact = new Set(files.split('\0').filter(Boolean));
    const tracked = new Set(exact);
    for (const file of exact) {
        let path = '';
        for (const part of file.split('/')) {
            path = path ? `${path}/${part}` : part;
            tracked.add(path);
        }
    }
    const contains = (relPath) => tracked.has(relPath.replace(TRAILING_SLASH_RE, ''));
    const conflictsTarget = (target) => contains(target) || [...exact].some((file) => target.startsWith(`${file}/`));
    return { contains, conflictsTarget };
}
/** Snapshot tracked files and their parent directories for repeated lifecycle checks. */
export function trackedPathPredicate(gitRoot) {
    return trackedPathState(gitRoot).contains;
}
function hasIdentity(path, expected) {
    try {
        const current = lstatSync(path);
        return (current.dev === expected.dev &&
            current.ino === expected.ino &&
            current.isDirectory() === expected.isDirectory &&
            current.isSymbolicLink() === expected.isSymbolicLink);
    }
    catch {
        return false;
    }
}
export function assertMovedSource(target, source, expected) {
    if (hasIdentity(target, expected))
        return;
    const nested = join(target, basename(source));
    if (hasIdentity(nested, expected))
        throw new Error(`destination changed during move; source is at ${nested}; imports were not rewritten`);
    throw new Error('source changed during move; imports were not rewritten');
}
function assertSourceIdentity(source, expected) {
    const current = lstatSync(source);
    const parentIsLexical = realpathSync(dirname(source)) === dirname(source);
    const sourceIsLexical = current.isSymbolicLink() || realpathSync(source) === source;
    if (!hasIdentity(source, expected) || !parentIsLexical || !sourceIsLexical)
        throw new Error('source changed during move; retry');
}
function hasFilesystemLeaf(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink())
            return true;
        if (hasFilesystemLeaf(join(directory, entry.name)))
            return true;
    }
    return false;
}
/** Move an untracked source through an isolated index while serializing real-index changes. */
export function moveUntrackedWithGit(gitRoot, gitDir, source, target, expectedSource) {
    const temp = mkdtempSync(join(gitDir, 'devkit-move-index-'));
    const lock = join(gitDir, 'index.lock');
    const index = join(temp, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    let ownsLock = false;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned)
            return;
        cleaned = true;
        try {
            rmSync(temp, { recursive: true, force: true });
        }
        finally {
            if (ownsLock)
                rmSync(lock, { force: true });
        }
    };
    const signalHandlers = new Map();
    const cleanupSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
    for (const signal of cleanupSignals) {
        const handler = () => {
            cleanup();
            process.removeListener(signal, handler);
            process.kill(process.pid, signal);
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
    }
    try {
        writeFileSync(lock, '', { flag: 'wx' });
        ownsLock = true;
        const realIndex = join(gitDir, 'index');
        if (existsSync(realIndex))
            copyFileSync(realIndex, index);
        else
            execFileSync('git', ['read-tree', '--empty'], { cwd: gitRoot, env, stdio: 'pipe' });
        const state = trackedPathState(gitRoot, { realIndex: true });
        const sourceRel = relative(gitRoot, source).replaceAll('\\', '/');
        const targetRel = relative(gitRoot, target).replaceAll('\\', '/');
        if (state.contains(sourceRel) || state.conflictsTarget(targetRel))
            throw new Error('Git index changed during move; retry');
        assertSourceIdentity(source, expectedSource);
        const sourceIsDirectory = lstatSync(source).isDirectory();
        if (sourceIsDirectory && !hasFilesystemLeaf(source))
            throw new Error('cannot move an empty untracked directory safely');
        execFileSync('git', ['add', '-N', '-f', '--', source], { cwd: gitRoot, env, stdio: 'pipe' });
        assertSourceIdentity(source, expectedSource);
        mkdirSync(dirname(target), { recursive: true });
        execFileSync('git', ['mv', '--', source, target], { cwd: gitRoot, env, stdio: 'pipe' });
        assertMovedSource(target, source, expectedSource);
    }
    finally {
        for (const [signal, handler] of signalHandlers)
            process.removeListener(signal, handler);
        cleanup();
    }
}
