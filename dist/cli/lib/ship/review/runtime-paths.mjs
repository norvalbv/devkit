/** Shared physical-path invariants for review runtimes and their private manifests. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
/** True for one normalized package/repository-relative POSIX path with no traversal syntax. */
export function isSafeReviewRelativePath(path) {
    const segments = path.split('/');
    return (Boolean(path) &&
        !path.includes('\\') &&
        !isAbsolute(path) &&
        !win32.isAbsolute(path) &&
        segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..'));
}
/** Canonicalize harmless dot/slash syntax while rejecting traversal and absolute paths. */
export function normalizeSafeReviewRelativePath(path) {
    const value = path.trim();
    if (!value || value.includes('\0') || value.includes('\\') || isAbsolute(value))
        return null;
    if (win32.isAbsolute(value))
        return null;
    const segments = value.split('/');
    if (segments.includes('..'))
        return null;
    const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
    return isSafeReviewRelativePath(normalized) ? normalized : null;
}
/** True when candidate is root itself or a descendant, never a lexical sibling. */
export function reviewPathWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
/** Resolve an existing directory physically so later containment checks cannot follow an ancestor. */
export function canonicalReviewDirectory(path, label) {
    let canonical;
    try {
        canonical = realpathSync(resolve(path));
    }
    catch {
        throw new Error(`devkit review: ${label} is not an available directory: ${path}`);
    }
    if (!lstatSync(canonical).isDirectory())
        throw new Error(`devkit review: ${label} is not a directory: ${path}`);
    return canonical;
}
/** Resolve a prospective leaf through its existing physical parent without following the leaf. */
export function canonicalReviewLeaf(path, parentLabel) {
    const requested = resolve(path);
    const parent = canonicalReviewDirectory(dirname(requested), parentLabel);
    return join(parent, basename(requested));
}
/** Reject links and special entries anywhere below an authenticated runtime source. */
export function assertSymlinkFreeReviewTree(path, label, unsupportedEntry = 'unsupported special file') {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
        throw new Error(`devkit review: ${label} contains a nested symlink: ${path}`);
    }
    if (stat.isFile())
        return;
    if (!stat.isDirectory()) {
        throw new Error(`devkit review: ${label} contains an ${unsupportedEntry}: ${path}`);
    }
    for (const name of readdirSync(path).sort()) {
        assertSymlinkFreeReviewTree(join(path, name), label, unsupportedEntry);
    }
}
/** Resolve a private destination without traversing a snapshot-controlled parent link. */
export function safeReviewDestination(root, path, escapeMessage, unsafeParentMessage) {
    const absolute = resolve(root, ...path.split('/'));
    if (!reviewPathWithin(root, absolute)) {
        throw new Error(`devkit review: ${escapeMessage}: ${path}`);
    }
    let parent = root;
    for (const segment of path.split('/').slice(0, -1)) {
        parent = join(parent, segment);
        const stat = lstatSync(parent, { throwIfNoEntry: false });
        if (stat === undefined)
            break;
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`devkit review: ${unsafeParentMessage}: ${path}`);
        }
    }
    return absolute;
}
