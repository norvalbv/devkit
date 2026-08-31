/** Exact Git-index materialization and base-commit baseline evidence for anti-slop gates. */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { adoptManagedCapability } from './base-capability.mjs';
import { parseBaseline } from './baseline.mjs';
import { ANTI_SLOP_BASELINE_REL } from './constants.mjs';
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
const GIT_LOCK_WAIT_MS = 5_000;
const GIT_LOCK_RETRY_MS = 25;
const GIT_LOCK_SIGNALS = ['SIGINT', 'SIGTERM'];
const LINT_SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const FULL_SCAN_FILES = new Set([
    ANTI_SLOP_BASELINE_REL,
    '.oxlintrc.json',
    '.oxlintrc.jsonc',
    'oxlint.config.ts',
    'oxlint.config.mts',
    'package.json',
    'bun.lock',
]);
function git(cwd, args) {
    const output = execFileSync('git', [...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
    });
    return output.endsWith('\n') ? output.slice(0, -1) : output;
}
function layout(cwd) {
    return {
        root: git(cwd, ['rev-parse', '--show-toplevel']),
        prefix: git(cwd, ['rev-parse', '--show-prefix']),
    };
}
function resolveRef(root, ref) {
    const result = spawnSync('git', ['rev-parse', '--verify', ref], {
        cwd: root,
        encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout.trim() : null;
}
function symbolicHead(root) {
    const result = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout.trim() : null;
}
function symbolicFullName(root, ref) {
    const result = spawnSync('git', ['rev-parse', '--symbolic-full-name', ref], {
        cwd: root,
        encoding: 'utf8',
    });
    const name = result.status === 0 ? result.stdout.trim() : '';
    return name.startsWith('refs/') ? name : null;
}
function treeForRef(root, ref) {
    const result = spawnSync('git', ['rev-parse', '--verify', `${ref}^{tree}`], {
        cwd: root,
        encoding: 'utf8',
    });
    if (result.status === 0)
        return result.stdout.trim();
    if (ref !== 'HEAD') {
        throw new Error(`anti-slop: Git base ${ref} does not resolve to a tree`);
    }
    const unborn = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
    });
    if (unborn.status !== 0)
        throw new Error('anti-slop: HEAD could not be resolved safely');
    const empty = spawnSync('git', ['mktree'], { cwd: root, encoding: 'utf8', input: '' });
    if (empty.status !== 0)
        throw new Error('anti-slop: could not create the initial empty Git tree');
    return empty.stdout.trim();
}
function parseChanges(root, baseTree, candidateTree) {
    const output = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', baseTree, candidateTree], { cwd: root, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT });
    const fields = output.split('\0');
    const changes = [];
    for (let index = 0; index < fields.length;) {
        const status = fields[index++];
        if (!status)
            break;
        if (status.startsWith('R') || status.startsWith('C')) {
            const oldPath = fields[index++];
            const path = fields[index++];
            if (oldPath !== undefined && path !== undefined)
                changes.push({ status, oldPath, path });
            continue;
        }
        const path = fields[index++];
        if (path !== undefined)
            changes.push({ status, path });
    }
    return changes;
}
function packagePath(repoPath, prefix) {
    if (!prefix)
        return repoPath;
    return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}
function baselineAtTree(layout, tree) {
    const path = `${layout.prefix}${ANTI_SLOP_BASELINE_REL}`;
    const listed = spawnSync('git', ['ls-tree', '-z', tree, '--', path], {
        cwd: layout.root,
        encoding: 'utf8',
    });
    if (listed.status !== 0) {
        throw new Error(`anti-slop: could not inspect the base baseline at ${tree.slice(0, 12)}`);
    }
    if (!listed.stdout)
        return null;
    const json = execFileSync('git', ['show', `${tree}:${path}`], {
        cwd: layout.root,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
    });
    return parseBaseline(json, `${tree.slice(0, 12)}:${path}`);
}
function envelope(cwd, baseRef, candidateTree) {
    const repo = layout(cwd);
    const baseTree = treeForRef(repo.root, baseRef);
    const changes = parseChanges(repo.root, baseTree, candidateTree);
    const renames = new Map();
    const introducedPaths = new Set();
    for (const change of changes) {
        if (change.status.startsWith('A') || change.status.startsWith('C')) {
            const path = packagePath(change.path, repo.prefix);
            if (path !== null)
                introducedPaths.add(path);
        }
        if (!change.status.startsWith('R') || change.oldPath === undefined)
            continue;
        const oldPath = packagePath(change.oldPath, repo.prefix);
        const nextPath = packagePath(change.path, repo.prefix);
        if (oldPath !== null && nextPath !== null)
            renames.set(oldPath, nextPath);
    }
    return {
        layout: repo,
        baseTree,
        candidateTree,
        changes,
        base: baselineAtTree(repo, baseTree),
        introducedPaths,
        renames,
    };
}
/** Read the base baseline and exact rename map used by a full-tree CI check. */
export function gitBaselineEnvelope(cwd, baseRef) {
    const repo = layout(cwd);
    const headRef = symbolicHead(repo.root);
    const headOid = resolveRef(repo.root, 'HEAD');
    const baseOid = resolveRef(repo.root, baseRef);
    const baseRefName = symbolicFullName(repo.root, baseRef);
    const candidateTree = git(repo.root, ['write-tree']);
    const { base, baseTree, introducedPaths, renames } = envelope(cwd, baseOid ?? baseRef, candidateTree);
    return {
        base,
        baseTree,
        candidateTree,
        baseOid,
        baseRefName,
        headOid,
        headRef,
        introducedPaths,
        renames,
    };
}
const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
function acquireGitLock(path) {
    mkdirSync(dirname(path), { recursive: true });
    const stamp = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + GIT_LOCK_WAIT_MS;
    let descriptor = -1;
    while (Date.now() <= deadline) {
        try {
            descriptor = openSync(path, 'wx', 0o600);
            break;
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
            sleepSync(GIT_LOCK_RETRY_MS);
        }
    }
    if (descriptor < 0) {
        throw new Error(`anti-slop: Git lock is busy at ${path}; baseline unchanged; retry after the Git operation finishes or remove a proven-stale lock`);
    }
    try {
        writeFileSync(descriptor, stamp, 'utf8');
    }
    catch (error) {
        rmSync(path, { force: true });
        throw error;
    }
    finally {
        closeSync(descriptor);
    }
    return { path, stamp };
}
function releaseGitLock(lock) {
    try {
        if (readFileSync(lock.path, 'utf8') === lock.stamp)
            rmSync(lock.path, { force: true });
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error;
    }
}
/** Stabilize Git's HEAD, active ref, and index while applying a write derived from their trees. */
export function withStableGitIndex(cwd, expectedHead, expectedBase, expectedCandidateTree, action) {
    const repo = layout(cwd);
    const gitPath = (path) => git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', path]);
    const lockPaths = [
        ...new Set([
            `${gitPath('HEAD')}.lock`,
            ...(expectedHead.symbolicRef ? [`${gitPath(expectedHead.symbolicRef)}.lock`] : []),
            ...(expectedBase?.symbolicRef ? [`${gitPath(expectedBase.symbolicRef)}.lock`] : []),
            `${gitPath('index')}.lock`,
        ]),
    ];
    const held = [];
    const releaseHeld = (suppressErrors = false) => {
        let firstError;
        while (held.length > 0) {
            const lock = held.pop();
            if (!lock)
                continue;
            try {
                releaseGitLock(lock);
            }
            catch (error) {
                firstError ??= error;
            }
        }
        if (firstError && !suppressErrors)
            throw firstError;
    };
    const exitHandler = () => releaseHeld(true);
    const signalHandlers = new Map();
    process.once('exit', exitHandler);
    for (const signal of GIT_LOCK_SIGNALS) {
        const handler = () => {
            releaseHeld(true);
            process.removeListener(signal, handler);
            process.kill(process.pid, signal);
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
    }
    let temp = null;
    try {
        for (const path of lockPaths)
            held.push(acquireGitLock(path));
        const currentHead = {
            oid: resolveRef(repo.root, 'HEAD'),
            symbolicRef: symbolicHead(repo.root),
        };
        if (currentHead.oid !== expectedHead.oid ||
            currentHead.symbolicRef !== expectedHead.symbolicRef) {
            throw new Error('anti-slop: Git HEAD changed while staged renames were being read; baseline unchanged; retry');
        }
        if (expectedBase && resolveRef(repo.root, expectedBase.expression) !== expectedBase.oid) {
            throw new Error('anti-slop: Git base changed while rename evidence was being read; baseline unchanged; retry');
        }
        temp = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-index-lock-'));
        const snapshotIndex = join(temp, 'index');
        copyFileSync(gitPath('index'), snapshotIndex);
        const currentTree = execFileSync('git', ['write-tree'], {
            cwd: repo.root,
            encoding: 'utf8',
            env: { ...process.env, GIT_INDEX_FILE: snapshotIndex },
            maxBuffer: MAX_GIT_OUTPUT,
        }).trim();
        if (currentTree !== expectedCandidateTree) {
            throw new Error('anti-slop: Git index changed while staged renames were being read; baseline unchanged; retry');
        }
        return action();
    }
    finally {
        process.removeListener('exit', exitHandler);
        for (const [signal, handler] of signalHandlers)
            process.removeListener(signal, handler);
        try {
            if (temp)
                rmSync(temp, { recursive: true, force: true });
        }
        finally {
            releaseHeld();
        }
    }
}
function requiresFullScan(path) {
    return (FULL_SCAN_FILES.has(path) ||
        path.startsWith('.devkit/oxc/') ||
        path.startsWith('.devkit/anti-slop/'));
}
function extractTree(root, tree, destination) {
    mkdirSync(destination, { recursive: true });
    const archive = execFileSync('git', ['archive', '--format=tar', tree], {
        cwd: root,
        maxBuffer: MAX_GIT_OUTPUT,
    });
    const extracted = spawnSync('tar', ['-x', '-C', destination], { input: archive });
    if (extracted.status !== 0) {
        throw new Error(`anti-slop: could not materialize staged Git tree: ${extracted.stderr?.toString().trim() || `tar exit ${extracted.status}`}`);
    }
}
/**
 * Run an action against selected files from the exact base tree used by a CI comparison.
 * `cwd` locates the REPOSITORY; `capabilityCwd` holds the capability to judge it with (sc-2084).
 */
export function withBaseAntiSlopSnapshot(cwd, capabilityCwd, baseTree, paths, action) {
    const repo = layout(cwd);
    const temp = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-base-'));
    try {
        extractTree(repo.root, baseTree, temp);
        const snapshotCwd = join(temp, repo.prefix);
        adoptManagedCapability(capabilityCwd, snapshotCwd);
        const existingPaths = paths.filter((path) => existsSync(join(snapshotCwd, path)));
        return action({ cwd: snapshotCwd, paths: existingPaths });
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
/**
 * Run an action against the exact candidate index, never the mutable working tree. Unrelated
 * package/repository changes are ignored; config or baseline changes force a complete package scan.
 */
export function withStagedAntiSlopSnapshot(cwd, action) {
    const repo = layout(cwd);
    const candidateTree = git(repo.root, ['write-tree']);
    const evidence = envelope(cwd, 'HEAD', candidateTree);
    const packageChanges = evidence.changes.flatMap((change) => {
        const path = packagePath(change.path, repo.prefix);
        return path === null ? [] : [{ ...change, path }];
    });
    const changedFiles = packageChanges.map((change) => change.path);
    const fullScan = changedFiles.some(requiresFullScan);
    const paths = fullScan
        ? []
        : packageChanges
            .filter((change) => !change.status.startsWith('D') && LINT_SOURCE.test(change.path))
            .map((change) => change.path);
    const skipped = !fullScan && paths.length === 0;
    if (skipped) {
        return action({
            cwd,
            paths,
            changedFiles,
            fullScan,
            skipped,
            base: evidence.base,
            baseTree: evidence.baseTree,
            baseCheckoutCwd: cwd,
            introducedPaths: evidence.introducedPaths,
            renames: evidence.renames,
        });
    }
    const temp = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-index-'));
    try {
        extractTree(repo.root, candidateTree, temp);
        return action({
            cwd: join(temp, repo.prefix),
            paths,
            changedFiles,
            fullScan,
            skipped,
            base: evidence.base,
            baseTree: evidence.baseTree,
            baseCheckoutCwd: cwd,
            introducedPaths: evidence.introducedPaths,
            renames: evidence.renames,
        });
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
