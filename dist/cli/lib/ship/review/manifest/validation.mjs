/** Shared structural invariants for authenticated review manifests. */
import { isAbsolute } from 'node:path';
import { reviewPathWithin } from "../runtime-paths.mjs";
export function hasExactManifestKeys(value, expected) {
    return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}
export function isSafeManifestAbsolutePath(value) {
    if (typeof value !== 'string')
        return false;
    if (!isAbsolute(value))
        return false;
    return !value.includes('\0');
}
export function hasValidManifestRoots(value, expectedKeys, version) {
    if (!hasExactManifestKeys(value, expectedKeys))
        return false;
    if (value.version !== version)
        return false;
    if (!isSafeManifestAbsolutePath(value.targetRoot))
        return false;
    if (!isSafeManifestAbsolutePath(value.gitRoot))
        return false;
    return reviewPathWithin(value.gitRoot, value.targetRoot);
}
