/** Resolve one trusted, materialized review input without leaving symlinks in the private runtime. */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalReviewDirectory, isSafeReviewRelativePath } from "./runtime-paths.mjs";
import { reviewSetupStat } from "./setup/setup-runtime-copy.mjs";
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function requireParentDirectory(stat, leaf, path) {
    if (leaf)
        return;
    if (!stat.isDirectory()) {
        fail(`projected review source parent is not a directory: ${path}`);
    }
}
function resolveProjection(traversal, segments, index, relativePath, allowProjection) {
    if (!allowProjection) {
        fail(`projected review source contains a nested symlink: ${relativePath}`);
    }
    if (traversal.projection) {
        fail(`projected review source contains a nested symlink: ${relativePath}`);
    }
    let physical;
    try {
        physical = realpathSync(traversal.lexical);
    }
    catch {
        return fail(`projected review source contains a broken symlink: ${relativePath}`);
    }
    requireParentDirectory(lstatSync(physical), index === segments.length - 1, relativePath);
    return {
        ...traversal,
        physical,
        projection: {
            linkPath: segments.slice(0, index + 1).join('/'),
            linkTarget: readlinkSync(traversal.lexical),
        },
    };
}
/**
 * The traversal for a path that cannot exist, with the remaining segments resolved LEXICALLY.
 *
 * Stopping at the segment that ended the walk would leave `physicalPath` pointing at that ancestor,
 * and the caller fingerprints/stats whatever it names. For a linked worktree's `.git` — a real
 * regular file — that reports the gitfile itself as the requested hook.
 */
function unresolved(next, segments, index) {
    const rest = segments.slice(index + 1);
    return { ...next, lexical: join(next.lexical, ...rest), physical: join(next.physical, ...rest) };
}
function traverseSegment(traversal, segments, index, relativePath, allowProjection) {
    const segment = segments[index];
    const next = {
        ...traversal,
        lexical: join(traversal.lexical, segment),
        physical: join(traversal.physical, segment),
    };
    const stat = reviewSetupStat(next.lexical);
    if (stat === undefined)
        return { traversal: unresolved(next, segments, index), exists: false };
    if (stat.isSymbolicLink()) {
        return {
            traversal: resolveProjection(next, segments, index, relativePath, allowProjection),
            exists: true,
        };
    }
    // A non-directory ANCESTOR means the leaf cannot exist — the same verdict a single lstat gives,
    // since `reviewSetupStat` maps ENOTDIR to absent. Walking segment-by-segment used to disagree with
    // that convention and hard-fail instead, which is what made a linked worktree's `.git` gitfile
    // unreviewable. A non-directory LEAF is still the caller's to judge (`pathState` rejects a
    // non-executable hook; `validateTree` rejects an unsupported type).
    if (index !== segments.length - 1 && !stat.isDirectory()) {
        return { traversal: unresolved(next, segments, index), exists: false };
    }
    return { traversal: next, exists: true };
}
/**
 * Resolve a repository-relative source path while authenticating at most one materializer link.
 * The link may be the leaf (`guard.config.json`) or a parent projection (`.devkit`). Anything below
 * that boundary must be an ordinary symlink-free tree; the caller fingerprints/copies its physical
 * leaf and records the returned link identity.
 */
export function resolveReviewSource(requestedRoot, relativePath, { allowProjection = true } = {}) {
    if (!isSafeReviewRelativePath(relativePath)) {
        return fail(`unsafe projected review source path: ${JSON.stringify(relativePath)}`);
    }
    const root = canonicalReviewDirectory(requestedRoot, 'projected review source root');
    const segments = relativePath.split('/');
    const lexicalPath = resolve(root, ...segments);
    let traversal = { lexical: root, physical: root, projection: null };
    for (let index = 0; index < segments.length; index += 1) {
        const result = traverseSegment(traversal, segments, index, relativePath, allowProjection);
        traversal = result.traversal;
        if (!result.exists)
            break;
    }
    return {
        lexicalPath,
        physicalPath: traversal.physical,
        projection: traversal.projection
            ? { ...traversal.projection, physicalPath: traversal.physical }
            : null,
    };
}
