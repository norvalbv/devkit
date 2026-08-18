/** Exact Git-index materialization and base-commit baseline evidence for anti-slop gates. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBaseline } from "./baseline.mjs";
import { ANTI_SLOP_BASELINE_REL } from "./constants.mjs";
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
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
    for (const change of changes) {
        if (!change.status.startsWith('R') || change.oldPath === undefined)
            continue;
        const oldPath = packagePath(change.oldPath, repo.prefix);
        const nextPath = packagePath(change.path, repo.prefix);
        if (oldPath !== null && nextPath !== null)
            renames.set(oldPath, nextPath);
    }
    return { layout: repo, baseTree, changes, base: baselineAtTree(repo, baseTree), renames };
}
/** Read the base baseline and exact rename map used by a full-tree CI check. */
export function gitBaselineEnvelope(cwd, baseRef) {
    const repo = layout(cwd);
    const candidateTree = git(repo.root, ['write-tree']);
    const { base, renames } = envelope(cwd, baseRef, candidateTree);
    return { base, renames };
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
            renames: evidence.renames,
        });
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
