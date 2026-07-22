/** Authenticated on-disk and NUL wire formats for the private review setup runtime. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isSafeReviewRelativePath } from "./runtime-paths.mjs";
import { isReviewSetupHash, REVIEW_SETUP_ABSENT } from "./setup-manifest-format.mjs";
export const REVIEW_SETUP_RUNTIME_VERSION = 1;
export const REVIEW_SETUP_RUNTIME_PROTOCOL = 'devkit-review-setup-v1';
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function verifyExactKeys(value, expected, message) {
    if (Object.keys(value).length !== expected.length)
        fail(message);
    for (const key of expected) {
        if (!Object.hasOwn(value, key))
            fail(message);
    }
}
function runtimeRecord(value, label) {
    if (Array.isArray(value))
        fail(`invalid setup runtime ${label}.`);
    if (value === null)
        fail(`invalid setup runtime ${label}.`);
    if (typeof value === 'object')
        return value;
    return fail(`invalid setup runtime ${label}.`);
}
function verifyStringField(fields, name) {
    const value = fields[name];
    if (typeof value !== 'string')
        fail('invalid setup runtime fields.');
}
function verifyBooleanField(fields, name) {
    const value = fields[name];
    if (typeof value !== 'boolean')
        fail('invalid setup runtime fields.');
}
function verifyGuardFields(value) {
    if (!Array.isArray(value))
        fail('invalid setup runtime fields.');
    for (const guard of value) {
        if (typeof guard !== 'string')
            fail('invalid setup runtime fields.');
    }
}
function verifyRequiredEntryString(entry, name) {
    const value = entry[name];
    if (typeof value !== 'string')
        fail('invalid setup runtime entry.');
    if (!value)
        fail('invalid setup runtime entry.');
}
function verifyRelativeEntryPath(entry) {
    verifyRequiredEntryString(entry, 'destinationRelativePath');
    const value = entry.destinationRelativePath;
    if (!isSafeReviewRelativePath(value))
        fail('invalid setup runtime entry.');
}
function verifyEntryFingerprint(entry, name) {
    const value = entry[name];
    if (value === REVIEW_SETUP_ABSENT)
        return;
    if (isReviewSetupHash(value))
        return;
    fail('invalid setup runtime entry.');
}
export function reviewSetupRuntimeHash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function parseFields(value) {
    const fields = runtimeRecord(value, 'fields');
    const keys = [
        'targetRelativePath',
        'hooksPath',
        'overlay',
        'enabled',
        'decisionsDir',
        'chainHook',
        'guards',
    ];
    verifyExactKeys(fields, keys, 'invalid setup runtime fields.');
    verifyStringField(fields, 'targetRelativePath');
    verifyStringField(fields, 'hooksPath');
    verifyBooleanField(fields, 'overlay');
    verifyBooleanField(fields, 'enabled');
    verifyStringField(fields, 'decisionsDir');
    verifyStringField(fields, 'chainHook');
    verifyGuardFields(fields.guards);
    return fields;
}
function parseEntry(value) {
    const entry = runtimeRecord(value, 'entry');
    const keys = ['id', 'destinationRelativePath', 'sourceFingerprint', 'privateFingerprint'];
    verifyExactKeys(entry, keys, 'invalid setup runtime entry.');
    verifyRequiredEntryString(entry, 'id');
    verifyRelativeEntryPath(entry);
    verifyEntryFingerprint(entry, 'sourceFingerprint');
    verifyEntryFingerprint(entry, 'privateFingerprint');
    return entry;
}
/** Read, self-authenticate, and deeply validate a private setup runtime manifest. */
export function parseReviewSetupRuntimeManifest(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return fail('could not read setup runtime manifest.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        fail('invalid setup runtime manifest.');
    const raw = parsed;
    if (raw.version !== REVIEW_SETUP_RUNTIME_VERSION ||
        !isReviewSetupHash(raw.setupHash) ||
        typeof raw.destinationGitRoot !== 'string' ||
        !isAbsolute(raw.destinationGitRoot) ||
        !Array.isArray(raw.entries) ||
        !isReviewSetupHash(raw.selfHash)) {
        return fail('invalid setup runtime manifest.');
    }
    verifyExactKeys(raw, ['version', 'setupHash', 'destinationGitRoot', 'fields', 'entries', 'selfHash'], 'invalid setup runtime manifest.');
    const unsigned = {
        version: REVIEW_SETUP_RUNTIME_VERSION,
        setupHash: raw.setupHash,
        destinationGitRoot: raw.destinationGitRoot,
        fields: parseFields(raw.fields),
        entries: raw.entries.map(parseEntry),
    };
    if (reviewSetupRuntimeHash(unsigned) !== raw.selfHash)
        fail('setup runtime manifest self-hash is invalid.');
    return { ...unsigned, selfHash: raw.selfHash };
}
/** Fixed, count-delimited NUL protocol safe for shell arrays and arbitrary valid paths. */
export function encodeReviewSetupRuntimeFields(fields) {
    const values = [
        REVIEW_SETUP_RUNTIME_PROTOCOL,
        fields.targetRelativePath,
        fields.hooksPath,
        fields.overlay ? '1' : '0',
        fields.enabled ? '1' : '0',
        fields.decisionsDir,
        fields.chainHook,
        String(fields.guards.length),
        ...fields.guards,
    ];
    return Buffer.from(`${values.join('\0')}\0`);
}
