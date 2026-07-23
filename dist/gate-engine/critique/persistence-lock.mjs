import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { withFileLock } from "../eval/publish-lock.mjs";
import { managedParentPath, managedPath } from "./immutable-file.mjs";
const DEFAULT_ROOT = ['.devkit', 'evidence', 'plan-critiques', 'v1'];
const DEFAULT_PARENT = DEFAULT_ROOT.slice(0, -1);
const OPERATION = 'plan critique evidence persistence';
function invalidRoot() {
    throw new Error('invalid plan critique record: $.root');
}
function missing(error) {
    return error.code === 'ENOENT';
}
function rootLocation(options, createDefaultParent) {
    if (options.root === undefined) {
        const parent = managedParentPath(homedir(), DEFAULT_PARENT, createDefaultParent);
        return parent ? { basename: 'v1', parent, root: path.join(parent, 'v1') } : null;
    }
    if (typeof options.root !== 'string' || !options.root || !path.isAbsolute(options.root))
        invalidRoot();
    const requested = path.normalize(options.root);
    const basename = path.basename(requested);
    if (!basename)
        invalidRoot();
    const parent = managedParentPath(path.dirname(requested), [], false);
    return { basename, parent, root: path.join(parent, basename) };
}
function promiseLike(value) {
    return (((typeof value === 'object' && value !== null) || typeof value === 'function') &&
        typeof value.then === 'function');
}
function deferredAction(action) {
    const name = Object.getPrototypeOf(action)?.constructor?.name;
    return (name === 'AsyncFunction' || name === 'GeneratorFunction' || name === 'AsyncGeneratorFunction');
}
function assertSynchronousAction(action) {
    if (deferredAction(action))
        throw new TypeError('plan critique evidence persistence action must be synchronous');
}
function runSynchronousAction(action, canonicalRoot) {
    const result = action(canonicalRoot);
    if (promiseLike(result))
        throw new TypeError('plan critique evidence persistence action must be synchronous');
    return result;
}
function persistenceLockPath(location, canonicalRoot) {
    const digest = createHash('sha256').update(canonicalRoot).digest('hex');
    return path.join(location.parent, `.plan-critique-${digest}.lock`);
}
function evidenceRootIdentity(stat) {
    return {
        birthtimeNanoseconds: stat.birthtimeNs,
        device: stat.dev,
        inode: stat.ino,
    };
}
function rootIdentity(root) {
    try {
        const stat = lstatSync(root, { bigint: true });
        return evidenceRootIdentity(stat);
    }
    catch (error) {
        if (missing(error))
            return null;
        throw error;
    }
}
function openRootIdentity(root) {
    if (process.platform !== 'linux') {
        const identity = rootIdentity(root);
        return identity && { identity };
    }
    let descriptor;
    try {
        descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (missing(error))
            return null;
        throw error;
    }
    try {
        const stat = fstatSync(descriptor, { bigint: true });
        return { descriptor, identity: evidenceRootIdentity(stat) };
    }
    catch (error) {
        try {
            closeSync(descriptor);
        }
        catch { }
        throw error;
    }
}
function sameRootIdentity(left, right) {
    return (left.birthtimeNanoseconds === right.birthtimeNanoseconds &&
        left.device === right.device &&
        left.inode === right.inode);
}
function closeRootHandle(rootHandle) {
    if (rootHandle.descriptor !== undefined)
        closeSync(rootHandle.descriptor);
}
function existingRoot(location) {
    try {
        return managedPath(location.parent, [location.basename], false);
    }
    catch (error) {
        if (missing(error))
            return null;
        throw error;
    }
}
/** Resolve the evidence root through the private managed-path boundary. */
export function resolvePlanCritiqueEvidenceRoot(options, create) {
    const location = rootLocation(options, create);
    return location && managedPath(location.parent, [location.basename], create);
}
/** Serialize synchronous evidence writers and cleanup against one canonical root identity. */
export function withPlanCritiquePersistenceLock(options, action) {
    assertSynchronousAction(action);
    const location = rootLocation(options, true);
    const existing = managedPath(location.parent, [location.basename], false);
    const canonicalRoot = existing ?? location.root;
    const lockPath = persistenceLockPath(location, canonicalRoot);
    return withFileLock(lockPath, OPERATION, () => {
        const lockedRoot = managedPath(location.parent, [location.basename], true);
        if (lockedRoot !== canonicalRoot)
            throw new Error('plan critique evidence root changed while acquiring persistence lock');
        return runSynchronousAction(action, lockedRoot);
    });
}
/** Lock an existing evidence root without creating any missing evidence directories. */
export function withExistingPlanCritiquePersistenceLock(options, action) {
    assertSynchronousAction(action);
    let location;
    try {
        location = rootLocation(options, false);
    }
    catch (error) {
        if (missing(error))
            return { status: 'absent' };
        throw error;
    }
    if (!location)
        return { status: 'absent' };
    const canonicalRoot = existingRoot(location);
    if (!canonicalRoot)
        return { status: 'absent' };
    const rootHandle = openRootIdentity(canonicalRoot);
    if (!rootHandle)
        return { status: 'absent' };
    const lockPath = persistenceLockPath(location, canonicalRoot);
    let lockActionEntered = false;
    let result;
    try {
        result = withFileLock(lockPath, OPERATION, () => {
            lockActionEntered = true;
            const lockedRoot = existingRoot(location);
            if (!lockedRoot)
                return { status: 'absent' };
            const lockedIdentity = rootIdentity(lockedRoot);
            if (!lockedIdentity)
                return { status: 'absent' };
            if (lockedRoot !== canonicalRoot || !sameRootIdentity(rootHandle.identity, lockedIdentity))
                throw new Error('plan critique evidence root changed while acquiring persistence lock');
            return { status: 'locked', value: runSynchronousAction(action, lockedRoot) };
        }, { createParent: false });
    }
    catch (error) {
        let rootAbsent = false;
        if (!lockActionEntered) {
            try {
                rootAbsent = !existingRoot(location);
            }
            catch { }
        }
        if (rootAbsent) {
            closeRootHandle(rootHandle);
            return { status: 'absent' };
        }
        try {
            closeRootHandle(rootHandle);
        }
        catch { }
        throw error;
    }
    closeRootHandle(rootHandle);
    return result;
}
