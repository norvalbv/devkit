/** Resolve one trusted, materialized review input without leaving symlinks in the private runtime. */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalReviewDirectory, isSafeReviewRelativePath } from "./runtime-paths.mjs";
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function safeStat(path) {
    try {
        return lstatSync(path, { throwIfNoEntry: false });
    }
    catch (cause) {
        const code = cause.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return undefined;
        throw cause;
    }
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
function traverseSegment(traversal, segments, index, relativePath, allowProjection) {
    const segment = segments[index];
    const next = {
        ...traversal,
        lexical: join(traversal.lexical, segment),
        physical: join(traversal.physical, segment),
    };
    const stat = safeStat(next.lexical);
    if (stat === undefined)
        return { traversal: next, exists: false };
    if (stat.isSymbolicLink()) {
        return {
            traversal: resolveProjection(next, segments, index, relativePath, allowProjection),
            exists: true,
        };
    }
    requireParentDirectory(stat, index === segments.length - 1, relativePath);
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
