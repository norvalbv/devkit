import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { firstDuplicateJsonKey } from "../../../../gate-engine/critique/json-duplicate-keys.mjs";
import { writeFileAtomic } from "../../atomic-write.mjs";
import { isWellFormedUnicode } from "../agent-assets.mjs";
import { isAgentProvider } from "../agent-providers.mjs";
import { readBoundedRegularFile } from "../strict-bounded-file-read.mjs";
export const HOOK_REGISTRATION_LEDGER_REL = '.devkit/agent-hook-registrations-manifest.json';
const MAX_JSON_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_ENTRIES = 4096;
const MAX_ID_BYTES = 128;
const MAX_EVENT_BYTES = 128;
const MAX_MATCHER_BYTES = 512;
const MAX_COMMAND_BYTES = 4096;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REGISTRATION_ID_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONTROL_RANGE = String.raw `\x00-\x1F\x7F-\x9F`;
const CONTROL_RE = new RegExp(`[${CONTROL_RANGE}]`, 'u');
const INSTALL_SCOPES = new Set(['shared', 'overlay']);
const DESTINATION = {
    claude: {
        shared: '.claude/settings.json',
        overlay: '.claude/settings.local.json',
    },
    codex: {
        shared: '.codex/hooks.json',
        overlay: '.codex/hooks.json',
    },
    cursor: {
        shared: '.cursor/hooks.json',
        overlay: '.cursor/hooks.json',
    },
};
/** The only provider-native configuration file one ownership record may describe. */
export function hookRegistrationDestination(provider, installScope) {
    if (!isAgentProvider(provider))
        throw new Error('hook registration provider is invalid');
    if (!INSTALL_SCOPES.has(installScope))
        throw new Error('hook registration scope is invalid');
    return DESTINATION[provider][installScope];
}
function exactObject(value, label, expectedKeys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    const object = value;
    const keys = Object.keys(object);
    if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key)))
        throw new Error(`${label} fields do not match the v1 contract`);
    return object;
}
function boundedText(value, label, maxBytes, pattern, allowEmpty = false) {
    if (typeof value !== 'string' ||
        (!allowEmpty && !value) ||
        !isWellFormedUnicode(value) ||
        CONTROL_RE.test(value) ||
        Buffer.byteLength(value, 'utf8') > maxBytes ||
        (pattern && !pattern.test(value)))
        throw new Error(`${label} is invalid`);
    return value;
}
function decodeEntry(value, index) {
    const label = `hook registration ledger entry ${index}`;
    const entry = exactObject(value, label, [
        'registrationId',
        'ownerId',
        'provider',
        'installScope',
        'destinationRel',
        'native',
    ]);
    const registrationId = boundedText(entry.registrationId, `${label}.registrationId`, MAX_ID_BYTES, REGISTRATION_ID_RE);
    const ownerId = boundedText(entry.ownerId, `${label}.ownerId`, MAX_ID_BYTES, ID_RE);
    if (!isAgentProvider(entry.provider))
        throw new Error(`${label}.provider is invalid`);
    const provider = entry.provider;
    if (!INSTALL_SCOPES.has(entry.installScope))
        throw new Error(`${label}.installScope is invalid`);
    const installScope = entry.installScope;
    const destinationRel = boundedText(entry.destinationRel, `${label}.destinationRel`, MAX_ID_BYTES);
    if (destinationRel !== hookRegistrationDestination(provider, installScope))
        throw new Error(`${label}.destinationRel does not match its provider and scope`);
    const native = exactObject(entry.native, `${label}.native`, ['event', 'matcher', 'command']);
    const event = boundedText(native.event, `${label}.native.event`, MAX_EVENT_BYTES, EVENT_RE);
    const matcher = native.matcher === null
        ? null
        : boundedText(native.matcher, `${label}.native.matcher`, MAX_MATCHER_BYTES, undefined, true);
    const command = boundedText(native.command, `${label}.native.command`, MAX_COMMAND_BYTES);
    return {
        registrationId,
        ownerId,
        provider,
        installScope,
        destinationRel,
        native: { event, matcher, command },
    };
}
function ownershipKey(entry) {
    return JSON.stringify([entry.provider, entry.destinationRel, entry.registrationId]);
}
function nativeKey(entry) {
    return JSON.stringify([
        entry.provider,
        entry.destinationRel,
        entry.native.event,
        entry.native.matcher,
        entry.native.command,
    ]);
}
/**
 * Decode one bounded JSON document into canonical, detached, untrusted ownership candidates.
 * This performs no I/O and grants no removal or command-execution authority.
 */
export function decodeHookRegistrationLedger(json) {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES)
        throw new Error('hook registration ledger JSON exceeds the accepted limit');
    const duplicate = firstDuplicateJsonKey(json);
    if (duplicate !== null)
        throw new Error(`hook registration ledger has duplicate object field ${JSON.stringify(duplicate)}`);
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        throw new Error('hook registration ledger is not valid JSON');
    }
    const root = exactObject(parsed, 'hook registration ledger', [
        'schemaVersion',
        'kind',
        'entries',
    ]);
    if (root.schemaVersion !== 1)
        throw new Error('unsupported hook registration ledger version');
    if (root.kind !== 'agent_hook_registration_ownership')
        throw new Error('unsupported hook registration ledger kind');
    if (!Array.isArray(root.entries) || root.entries.length > MAX_ENTRIES)
        throw new Error('hook registration ledger entries are invalid');
    const ownershipKeys = new Set();
    const nativeKeys = new Set();
    const registrationOwners = new Map();
    const entries = root.entries.map((value, index) => {
        const entry = decodeEntry(value, index);
        const owned = ownershipKey(entry);
        if (ownershipKeys.has(owned))
            throw new Error('duplicate hook registration ownership key');
        ownershipKeys.add(owned);
        const native = nativeKey(entry);
        if (nativeKeys.has(native))
            throw new Error('duplicate native hook registration');
        nativeKeys.add(native);
        const owner = registrationOwners.get(entry.registrationId);
        if (owner !== undefined && owner !== entry.ownerId)
            throw new Error('hook registration identity has conflicting owners');
        registrationOwners.set(entry.registrationId, entry.ownerId);
        return { key: owned, entry };
    });
    entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    return {
        schemaVersion: 1,
        kind: 'agent_hook_registration_ownership',
        entries: entries.map(({ entry }) => entry),
    };
}
/** Validate, canonicalize, and serialize one ownership ledger without granting it authority. */
export function encodeHookRegistrationLedger(ledger) {
    let json;
    try {
        json = JSON.stringify(ledger);
    }
    catch {
        throw new Error('hook registration ledger cannot be serialized');
    }
    const canonical = decodeHookRegistrationLedger(json);
    return `${JSON.stringify(canonical, null, 2)}\n`;
}
function codeOf(error) {
    return error.code;
}
/** Strictly read the optional ownership ledger without following its leaf path. */
export function readHookRegistrationLedger(root) {
    const path = join(root, HOOK_REGISTRATION_LEDGER_REL);
    const bytes = readBoundedRegularFile(path, {
        label: 'hook registration ledger',
        maxBytes: MAX_JSON_BYTES,
        limitLabel: '1 MiB',
    });
    if (bytes === null)
        return null;
    let raw;
    try {
        raw = UTF8.decode(bytes);
    }
    catch {
        throw new Error('hook registration ledger is not valid UTF-8');
    }
    return decodeHookRegistrationLedger(raw);
}
/**
 * Atomically replace the canonical ledger. The caller serializes the surrounding read/config
 * writes/publish transaction with `withAgentAssetLifecycleLock`; this function executes no command.
 */
export function writeHookRegistrationLedger(root, ledger) {
    const encoded = encodeHookRegistrationLedger(ledger);
    const destination = join(root, HOOK_REGISTRATION_LEDGER_REL);
    const directory = dirname(destination);
    mkdirSync(directory, { recursive: true });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        throw new Error('hook registration ledger directory must not be a symlink');
    try {
        const destinationStat = lstatSync(destination);
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink())
            throw new Error('hook registration ledger destination must be a regular file');
    }
    catch (error) {
        if (codeOf(error) !== 'ENOENT')
            throw error;
    }
    writeFileAtomic(destination, encoded);
}
