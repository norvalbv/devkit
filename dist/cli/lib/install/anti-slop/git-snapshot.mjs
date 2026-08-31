/** Exact Git-index materialization and base-commit baseline evidence for anti-slop gates. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptManagedCapability } from './base-capability.mjs';
import { parseBaseline } from './baseline.mjs';
import { ANTI_SLOP_BASELINE_REL, ANTI_SLOP_CONFIG_REL, ANTI_SLOP_MANIFEST_REL, parseAntiSlopManagedActivationEvidence, } from './constants.mjs';
import { git, layout, MAX_GIT_OUTPUT, resolveRef, symbolicHead, } from './git-index-lock.mjs';
export { withStableGitIndex } from './git-index-lock.mjs';
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
function fileAtTree(layout, tree, relativePath, description) {
    const path = `${layout.prefix}${relativePath}`;
    const listed = spawnSync('git', ['ls-tree', '-z', tree, '--', path], {
        cwd: layout.root,
        encoding: 'utf8',
    });
    if (listed.status !== 0) {
        throw new Error(`anti-slop: could not inspect ${description} at ${tree.slice(0, 12)}`);
    }
    if (!listed.stdout)
        return null;
    return execFileSync('git', ['show', `${tree}:${path}`], {
        cwd: layout.root,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
    });
}
function baselineAtTree(layout, tree) {
    const json = fileAtTree(layout, tree, ANTI_SLOP_BASELINE_REL, 'the base baseline');
    return json === null
        ? null
        : parseBaseline(json, `${tree.slice(0, 12)}:${layout.prefix}${ANTI_SLOP_BASELINE_REL}`);
}
function activationEvidenceAtTree(layout, tree) {
    const manifest = fileAtTree(layout, tree, ANTI_SLOP_MANIFEST_REL, 'the managed manifest');
    const config = fileAtTree(layout, tree, ANTI_SLOP_CONFIG_REL, 'the managed config');
    if (manifest === null || config === null)
        return null;
    return parseAntiSlopManagedActivationEvidence(manifest, config);
}
function envelope(cwd, baseRef, candidateTree) {
    const repo = layout(cwd);
    const baseTree = treeForRef(repo.root, baseRef);
    const changes = parseChanges(repo.root, baseTree, candidateTree);
    const renames = new Map();
    const introducedPaths = new Set();
    const baseActivation = activationEvidenceAtTree(repo, baseTree);
    const candidateActivation = activationEvidenceAtTree(repo, candidateTree);
    const activatedRuleIds = new Set(baseActivation === null || candidateActivation === null
        ? []
        : [...candidateActivation.activeRuleIds].filter((ruleId) => !baseActivation.activeRuleIds.has(ruleId)));
    const candidateMigrationReceipt = candidateActivation?.baselineMigrationId ?? null;
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
        activatedRuleIds,
        candidateMigrationReceipt,
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
    const { base, baseTree, introducedPaths, activatedRuleIds, candidateMigrationReceipt, renames } = envelope(cwd, baseOid ?? baseRef, candidateTree);
    return {
        base,
        baseTree,
        candidateTree,
        baseOid,
        baseRefName,
        headOid,
        headRef,
        introducedPaths,
        activatedRuleIds,
        candidateMigrationReceipt,
        renames,
    };
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
            activatedRuleIds: evidence.activatedRuleIds,
            candidateMigrationReceipt: evidence.candidateMigrationReceipt,
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
            activatedRuleIds: evidence.activatedRuleIds,
            candidateMigrationReceipt: evidence.candidateMigrationReceipt,
            renames: evidence.renames,
        });
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
