import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from "./schema.mjs";
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 500;
const INCOMPLETE_TAKEOVER_STALE_MS = 1_000;
const TAKEOVER_MAX_AGE_MS = 60_000;
const OWNER_MAX_BYTES = 1_024;
function sameFile(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs);
}
function privateRegularFile(stat) {
    return stat.isFile() && (stat.mode & 63n) === 0n;
}
function stablePathStat(lockPath, descriptor, before) {
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, after))
        return null;
    let pathStat;
    try {
        pathStat = lstatSync(lockPath, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (!sameFile(after, pathStat))
        return null;
    return after;
}
function readLockSnapshotOnce(lockPath) {
    let pathBefore;
    try {
        pathBefore = lstatSync(lockPath, { bigint: true });
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return { state: 'missing' };
        if (code === 'EACCES' || code === 'EPERM')
            return { state: 'unsafe' };
        throw error;
    }
    if (!privateRegularFile(pathBefore))
        return { state: 'unsafe' };
    let descriptor;
    try {
        descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return { state: 'retry' };
        if (code === 'EACCES' || code === 'ELOOP' || code === 'EPERM')
            return { state: 'unsafe' };
        throw error;
    }
    try {
        const before = fstatSync(descriptor, { bigint: true });
        if (!sameFile(pathBefore, before))
            return { state: 'retry' };
        if (before.size > BigInt(OWNER_MAX_BYTES)) {
            const stable = stablePathStat(lockPath, descriptor, before);
            return stable ? { state: 'oversized', stat: stable } : { state: 'retry' };
        }
        const expected = Number(before.size);
        const buffer = Buffer.allocUnsafe(expected);
        let total = 0;
        while (total < buffer.length) {
            const bytesRead = readSync(descriptor, buffer, total, buffer.length - total, null);
            if (bytesRead === 0)
                break;
            total += bytesRead;
        }
        if (total !== expected)
            return { state: 'retry' };
        const stable = stablePathStat(lockPath, descriptor, before);
        if (!stable)
            return { state: 'retry' };
        return {
            state: 'readable',
            bytes: buffer,
            stat: stable,
        };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ELOOP')
            return { state: 'unsafe' };
        throw error;
    }
    finally {
        closeSync(descriptor);
    }
}
function readLockSnapshot(lockPath) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const snapshot = readLockSnapshotOnce(lockPath);
        if (snapshot.state !== 'retry')
            return snapshot;
    }
    return { state: 'unstable' };
}
function sameSnapshot(left, right) {
    if (left.state !== right.state || !sameFile(left.stat, right.stat))
        return false;
    return (left.state === 'oversized' || (right.state === 'readable' && left.bytes.equals(right.bytes)));
}
function unlinkUnchanged(lockPath, expected) {
    const current = readLockSnapshot(lockPath);
    if (current.state === 'missing')
        return true;
    if ((current.state === 'readable' || current.state === 'oversized') &&
        sameSnapshot(expected, current)) {
        try {
            unlinkSync(lockPath);
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return true;
            throw error;
        }
    }
    return false;
}
function createOwnedFileAtomically(lockPath, owner) {
    const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
    let descriptor;
    try {
        descriptor = openSync(candidatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        fchmodSync(descriptor, 0o600);
        writeFileSync(descriptor, owner);
        closeSync(descriptor);
        descriptor = undefined;
        try {
            linkSync(candidatePath, lockPath);
            return true;
        }
        catch (error) {
            if (error.code === 'EEXIST')
                return false;
            throw error;
        }
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
        try {
            unlinkSync(candidatePath);
        }
        catch {
            // A uniquely named candidate cannot block another publisher; cleanup is best effort.
        }
    }
}
function processIsRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (error.code === 'ESRCH')
            return false;
        if (error.code === 'EPERM')
            return true;
        throw error;
    }
}
function takeoverOwner(value) {
    if (!isRecord(value) ||
        !Number.isInteger(value.pid) ||
        value.pid <= 0 ||
        !Number.isFinite(value.createdAt) ||
        typeof value.token !== 'string' ||
        !value.token) {
        return undefined;
    }
    return value;
}
function staleTakeover(lockPath) {
    const snapshot = readLockSnapshot(lockPath);
    if (snapshot.state === 'missing')
        return true;
    if (snapshot.state === 'unsafe' || snapshot.state === 'unstable')
        return false;
    let owner;
    if (snapshot.state === 'readable') {
        try {
            owner = takeoverOwner(JSON.parse(snapshot.bytes.toString('utf8')));
        }
        catch {
            owner = undefined;
        }
    }
    const age = Date.now() - (owner?.createdAt ?? Number(snapshot.stat.mtimeNs) / 1e6);
    const stale = owner
        ? age > TAKEOVER_MAX_AGE_MS || !processIsRunning(owner.pid)
        : age > INCOMPLETE_TAKEOVER_STALE_MS;
    if (!stale)
        return false;
    return unlinkUnchanged(lockPath, snapshot);
}
function acquireTakeover(lockPath) {
    const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (createOwnedFileAtomically(lockPath, owner))
            return owner;
        if (!staleTakeover(lockPath))
            return undefined;
    }
    return undefined;
}
function releaseOwnedFile(lockPath, owner) {
    const snapshot = readLockSnapshot(lockPath);
    if (snapshot.state === 'readable' && snapshot.bytes.equals(Buffer.from(owner)))
        unlinkUnchanged(lockPath, snapshot);
}
function inspectFileLock(lockPath) {
    const takeoverPath = `${lockPath}.takeover`;
    const takeover = acquireTakeover(takeoverPath);
    if (!takeover)
        return 'busy';
    try {
        const snapshot = readLockSnapshot(lockPath);
        if (snapshot.state === 'missing')
            return 'removed';
        if (snapshot.state === 'unstable')
            return 'busy';
        if (snapshot.state === 'unsafe' || snapshot.state === 'oversized')
            return 'invalid';
        if (snapshot.bytes.length === 0) {
            const age = Date.now() - Number(snapshot.stat.mtimeNs) / 1e6;
            if (age <= INCOMPLETE_TAKEOVER_STALE_MS)
                return 'busy';
            return unlinkUnchanged(lockPath, snapshot) ? 'removed' : 'busy';
        }
        let owner;
        try {
            owner = JSON.parse(snapshot.bytes.toString('utf8'));
        }
        catch {
            return 'invalid';
        }
        const pid = isRecord(owner) ? owner.pid : undefined;
        if (typeof pid !== 'number')
            return 'invalid';
        if (pid === process.pid)
            return 'self';
        if (processIsRunning(pid))
            return 'busy';
        return unlinkUnchanged(lockPath, snapshot) ? 'removed' : 'busy';
    }
    finally {
        releaseOwnedFile(takeoverPath, takeover);
    }
}
function acquireFileLock(lockPath, operation) {
    const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        if (createOwnedFileAtomically(lockPath, owner))
            return owner;
        const inspection = inspectFileLock(lockPath);
        if (inspection === 'invalid')
            throw new Error(`Another ${operation} is in progress or left an unreadable lock`);
        if (inspection === 'self')
            throw new Error(`Another ${operation} is in progress`);
        if (inspection === 'removed')
            continue;
        Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, LOCK_WAIT_MS);
    }
    throw new Error(`Could not acquire ${operation} lock`);
}
export function withFileLock(lockPath, operation, action, options = {}) {
    if (options.createParent !== false)
        mkdirSync(dirname(lockPath), { recursive: true });
    const lock = acquireFileLock(lockPath, operation);
    try {
        return action();
    }
    finally {
        releaseOwnedFile(lockPath, lock);
    }
}
export function withPublishFileLock(lockPath, action) {
    return withFileLock(lockPath, 'benchmark publish', action);
}
