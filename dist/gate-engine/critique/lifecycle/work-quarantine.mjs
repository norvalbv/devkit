import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPlanCritiqueRecordJson, PLAN_CRITIQUE_PROVIDERS, plainRecord, sha256Bytes, validText, } from '../evidence-record.mjs';
import { managedPath, publishImmutable, readPrivateFileBounded } from '../immutable-file.mjs';
import { resolvePlanCritiqueEvidenceRoot, withExistingPlanCritiquePersistenceLock, withPlanCritiquePersistenceLock, } from '../persistence-lock.mjs';
const SHA256 = /^[0-9a-f]{64}$/;
const QUARANTINE_PATH = ['work-quarantines'];
function exactObject(value, fields) {
    const record = plainRecord(value);
    if (record === null)
        return null;
    try {
        const keys = Reflect.ownKeys(record);
        if (keys.length !== fields.length ||
            keys.some((key) => typeof key !== 'string' || !fields.includes(key)))
            return null;
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(record, key);
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
                return null;
        }
        return record;
    }
    catch {
        return null;
    }
}
function parseIdentity(value) {
    const identity = exactObject(value, ['provider', 'repositoryFingerprint', 'workId']);
    if (!identity ||
        typeof identity.provider !== 'string' ||
        !PLAN_CRITIQUE_PROVIDERS.includes(identity.provider) ||
        typeof identity.repositoryFingerprint !== 'string' ||
        !SHA256.test(identity.repositoryFingerprint) ||
        !validText(identity.workId))
        return null;
    return identity;
}
function quarantineFor(identity) {
    return {
        schemaVersion: 1,
        kind: 'plan_critique_work_quarantine',
        provider: identity.provider,
        repositoryFingerprint: identity.repositoryFingerprint,
        workId: identity.workId,
        reason: 'hook_continuation',
    };
}
function canonicalQuarantine(quarantine) {
    return Buffer.from(canonicalPlanCritiqueRecordJson(quarantine));
}
function quarantineFilename(identity) {
    const key = JSON.stringify([
        'plan_critique_work_quarantine',
        1,
        identity.provider,
        identity.repositoryFingerprint,
        identity.workId,
    ]);
    return `${sha256Bytes(Buffer.from(key, 'utf8'))}.json`;
}
export function persistPlanCritiqueWorkQuarantine(value, options = {}) {
    const identity = parseIdentity(value);
    if (!identity)
        throw new Error('invalid plan critique work quarantine identity');
    const quarantine = quarantineFor(identity);
    const persist = (root) => {
        const directory = managedPath(root, QUARANTINE_PATH, true);
        const state = publishImmutable(directory, quarantineFilename(identity), canonicalQuarantine(quarantine));
        return { state, quarantine };
    };
    return withPlanCritiquePersistenceLock(options, persist);
}
export function clearPlanCritiqueWorkQuarantine(value, options = {}) {
    const identity = parseIdentity(value);
    if (!identity)
        throw new Error('invalid plan critique work quarantine identity');
    const clear = (root) => {
        const directory = managedPath(root, QUARANTINE_PATH, false);
        if (!directory)
            return { state: 'absent' };
        const quarantine = quarantineFor(identity);
        const expected = canonicalQuarantine(quarantine);
        const filename = quarantineFilename(identity);
        const raw = readPrivateFileBounded(directory, filename, expected.byteLength);
        if (raw === null)
            return { state: 'absent' };
        if (!raw.equals(expected))
            throw new Error('malformed plan critique work quarantine');
        rmSync(join(directory, filename), { force: true });
        return { state: 'removed' };
    };
    const result = withExistingPlanCritiquePersistenceLock(options, clear);
    return result.status === 'absent' ? { state: 'absent' } : result.value;
}
export function getPlanCritiqueWorkQuarantine(value, options = {}) {
    const identity = parseIdentity(value);
    if (!identity)
        return { status: 'unavailable', reason: 'malformed_quarantine' };
    try {
        const root = resolvePlanCritiqueEvidenceRoot(options, false);
        if (!root)
            return { status: 'clear' };
        const directory = managedPath(root, QUARANTINE_PATH, false);
        if (!directory)
            return { status: 'clear' };
        const quarantine = quarantineFor(identity);
        const expected = canonicalQuarantine(quarantine);
        const raw = readPrivateFileBounded(directory, quarantineFilename(identity), expected.byteLength);
        if (raw === null)
            return { status: 'clear' };
        return raw.equals(expected)
            ? { status: 'quarantined', quarantine }
            : { status: 'unavailable', reason: 'malformed_quarantine' };
    }
    catch {
        return { status: 'unavailable', reason: 'malformed_quarantine' };
    }
}
