import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { dirname } from 'node:path';
// This stays critique-local because gate engines are independently vendorable. Unlike the
// overwrite helpers in decisions/co-occurrence, evidence writes are create-once and enforce
// private directory/file permissions, so sharing either helper would weaken this contract.
function ensurePrivateDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
}
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const heldLocks = new Set();
function lockOwnerIsAlive(lockPath) {
    try {
        const owner = JSON.parse(readFileSync(`${lockPath}/owner.json`, 'utf8'));
        if (!Number.isInteger(owner.pid) || Number(owner.pid) <= 0)
            return true;
        process.kill(Number(owner.pid), 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === 'ESRCH')
            return false;
        if (code === 'EPERM')
            return true;
        try {
            return Date.now() - statSync(lockPath).mtimeMs < 1_000;
        }
        catch {
            return false;
        }
    }
}
/** Serialize a short synchronous filesystem transaction across local processes. */
export function withFileLock(lockPath, operation) {
    if (heldLocks.has(lockPath))
        return operation();
    ensurePrivateDir(dirname(lockPath));
    const deadline = Date.now() + 10_000;
    while (true) {
        try {
            mkdirSync(lockPath, { mode: 0o700 });
            writeFileSync(`${lockPath}/owner.json`, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            if (!lockOwnerIsAlive(lockPath)) {
                rmSync(lockPath, { recursive: true, force: true });
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`timed out waiting for lock: ${lockPath}`);
            Atomics.wait(LOCK_WAIT, 0, 0, 10);
        }
    }
    heldLocks.add(lockPath);
    try {
        return operation();
    }
    finally {
        heldLocks.delete(lockPath);
        rmSync(lockPath, { recursive: true, force: true });
    }
}
/** Atomically create a private immutable file; callers choose its evidence or git-dir location. */
export function atomicWrite(path, content) {
    ensurePrivateDir(dirname(path));
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const descriptor = openSync(temporary, 'wx', 0o600);
        try {
            writeFileSync(descriptor, content);
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
        // link(2) publishes without replacement: exactly one concurrent writer can claim `path`.
        // rename(2) cannot be used here because POSIX permits it to overwrite an existing target.
        linkSync(temporary, path);
        chmodSync(path, 0o600);
    }
    catch (error) {
        if (error.code === 'EEXIST')
            throw new Error(`immutable evidence already exists: ${path}`);
        throw error;
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
