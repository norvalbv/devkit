import { types as utilTypes } from 'node:util';
import { isWellFormedUnicode, projectedAssetRel } from "../agent-assets.mjs";
import { isAgentProvider, LEGACY_AGENT_PROVIDERS, SUPPORTED_AGENT_PROVIDERS, } from "../agent-providers.mjs";
const SHA256_RE = /^[0-9a-f]{64}$/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:\//;
const ASSET_KINDS = new Set(['skills', 'agents', 'hooks']);
const MAX_RECORD_FIELDS = 4096;
const MAX_FIELD_NAME_BYTES = 4096;
const MAX_METADATA_BYTES = 1024;
const MAX_ACCEPTED_TEXT_BYTES = 1024 * 1024;
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function hasPathControl(value) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
            return true;
    }
    return false;
}
function accountText(budget, value, label, maxBytes) {
    if (!isWellFormedUnicode(value))
        throw new Error(`${label} must be well-formed Unicode`);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maxBytes)
        throw new Error(`${label} is too large`);
    budget.acceptedTextBytes += bytes;
    if (budget.acceptedTextBytes > MAX_ACCEPTED_TEXT_BYTES)
        throw new Error('sync manifest text exceeds the accepted limit');
}
function dataFields(value, label, budget) {
    let descriptors;
    try {
        if (value === null ||
            typeof value !== 'object' ||
            utilTypes.isProxy(value) ||
            Array.isArray(value))
            throw new Error();
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new Error();
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        throw new Error(`${label} must be a plain data object`);
    }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_RECORD_FIELDS)
        throw new Error(`${label} has too many fields`);
    const fields = new Map();
    for (const key of keys) {
        if (typeof key !== 'string')
            throw new Error(`${label} cannot have symbol fields`);
        accountText(budget, key, `${label} field name`, MAX_FIELD_NAME_BYTES);
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
            throw new Error(`${label} must contain enumerable data fields`);
        fields.set(key, descriptor.value);
    }
    return fields;
}
function dataArray(value, label, budget) {
    try {
        if (!Array.isArray(value) || utilTypes.isProxy(value))
            throw new Error();
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > LEGACY_AGENT_PROVIDERS.length)
            throw new Error();
        if (Reflect.ownKeys(descriptors).length !== length + 1)
            throw new Error();
        const out = [];
        for (let index = 0; index < length; index++) {
            const descriptor = descriptors[String(index)];
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
                throw new Error();
            if (typeof descriptor.value === 'string')
                accountText(budget, descriptor.value, `${label} item`, MAX_METADATA_BYTES);
            out.push(descriptor.value);
        }
        return out;
    }
    catch {
        throw new Error(`${label} must be a dense data array`);
    }
}
function exactFields(fields, allowed, required, label) {
    const allowedSet = new Set(allowed);
    for (const key of fields.keys())
        if (!allowedSet.has(key))
            throw new Error(`${label} has an unsupported field: ${key}`);
    for (const key of required)
        if (!fields.has(key))
            throw new Error(`${label} is missing field: ${key}`);
}
function safeLogicalRel(kind, rel) {
    if (hasPathControl(rel) || WINDOWS_ABSOLUTE_RE.test(rel))
        throw new Error(`Invalid ${kind} asset path: ${rel}`);
    projectedAssetRel('claude', kind, rel);
    return rel;
}
function shaRecord(value, label, budget, validateRel) {
    const fields = dataFields(value, label, budget);
    const entries = [...fields.entries()]
        .map(([rel, digest]) => {
        const validatedRel = validateRel ? validateRel(rel) : rel;
        if (typeof digest !== 'string' || !SHA256_RE.test(digest))
            throw new Error(`${label}.${rel} must be a lowercase SHA-256`);
        accountText(budget, digest, `${label}.${rel}`, 64);
        return [validatedRel, digest];
    })
        .sort(([left], [right]) => compareText(left, right));
    return Object.fromEntries(entries);
}
function optionalString(fields, key, label, budget) {
    if (!fields.has(key))
        return undefined;
    const value = fields.get(key);
    if (value !== null && typeof value !== 'string')
        throw new Error(`${label}.${key} must be a string or null`);
    if (typeof value === 'string')
        accountText(budget, value, `${label}.${key}`, MAX_METADATA_BYTES);
    return value;
}
function decodeV1(fields, kind, budget) {
    exactFields(fields, ['files', 'targets', 'devkitRef', 'generatedAt'], ['files'], 'sync manifest v1');
    const files = shaRecord(fields.get('files'), 'sync manifest v1 files', budget, (rel) => safeLogicalRel(kind, rel));
    const targets = fields.has('targets')
        ? dataArray(fields.get('targets'), 'sync manifest v1 targets', budget).map((target) => {
            if (!isAgentProvider(target) ||
                !LEGACY_AGENT_PROVIDERS.includes(target))
                throw new Error('sync manifest v1 target is not a historical provider');
            return target;
        })
        : [...LEGACY_AGENT_PROVIDERS];
    if (new Set(targets).size !== targets.length)
        throw new Error('sync manifest v1 targets contain duplicates');
    const devkitRef = optionalString(fields, 'devkitRef', 'sync manifest v1', budget);
    const generatedAt = fields.get('generatedAt');
    if (fields.has('generatedAt') && typeof generatedAt !== 'string')
        throw new Error('sync manifest v1.generatedAt must be a string');
    if (typeof generatedAt === 'string')
        accountText(budget, generatedAt, 'sync manifest v1.generatedAt', MAX_METADATA_BYTES);
    return {
        version: 1,
        manifest: {
            files,
            targets: [...targets],
            ...(devkitRef !== undefined ? { devkitRef } : {}),
            ...(typeof generatedAt === 'string' ? { generatedAt } : {}),
        },
    };
}
function decodeV2(fields, kind, budget) {
    exactFields(fields, ['schemaVersion', 'kind', 'devkitRef', 'generatedAt', 'files', 'providers'], ['schemaVersion', 'kind', 'devkitRef', 'generatedAt', 'files', 'providers'], 'sync manifest v2');
    if (fields.get('schemaVersion') !== 2)
        throw new Error('unsupported sync manifest schemaVersion');
    if (fields.get('kind') !== kind)
        throw new Error(`sync manifest v2 kind is not ${kind}`);
    const devkitRef = optionalString(fields, 'devkitRef', 'sync manifest v2', budget);
    const generatedAt = fields.get('generatedAt');
    if (typeof generatedAt !== 'string')
        throw new Error('sync manifest v2.generatedAt must be a string');
    accountText(budget, generatedAt, 'sync manifest v2.generatedAt', MAX_METADATA_BYTES);
    const files = shaRecord(fields.get('files'), 'sync manifest v2 files', budget, (rel) => safeLogicalRel(kind, rel));
    const providerFields = dataFields(fields.get('providers'), 'sync manifest v2 providers', budget);
    const providers = {};
    const representedSources = new Set();
    for (const provider of SUPPORTED_AGENT_PROVIDERS) {
        if (!providerFields.has(provider))
            continue;
        const block = dataFields(providerFields.get(provider), `sync manifest v2 provider ${provider}`, budget);
        exactFields(block, ['files'], ['files'], `sync manifest v2 provider ${provider}`);
        const outputs = shaRecord(block.get('files'), `sync manifest v2 provider ${provider} files`, budget);
        const expectedSources = new Map();
        for (const logicalRel of Object.keys(files)) {
            const outputRel = projectedAssetRel(provider, kind, logicalRel);
            if (expectedSources.has(outputRel))
                throw new Error(`sync manifest v2 has duplicate ${provider} projection: ${outputRel}`);
            expectedSources.set(outputRel, logicalRel);
        }
        for (const [outputRel, outputSha] of Object.entries(outputs)) {
            const logicalRel = expectedSources.get(outputRel);
            if (!logicalRel)
                throw new Error(`sync manifest v2 has orphan ${provider} output: ${outputRel}`);
            if (!(provider === 'codex' && kind === 'agents') && outputSha !== files[logicalRel])
                throw new Error(`sync manifest v2 identity projection hash differs: ${provider}/${outputRel}`);
            representedSources.add(logicalRel);
        }
        providers[provider] = { files: outputs };
    }
    for (const provider of providerFields.keys())
        if (!isAgentProvider(provider))
            throw new Error(`sync manifest v2 has an unsupported provider: ${provider}`);
    for (const logicalRel of Object.keys(files))
        if (!representedSources.has(logicalRel))
            throw new Error(`sync manifest v2 has an orphan source: ${logicalRel}`);
    return {
        version: 2,
        manifest: {
            schemaVersion: 2,
            kind,
            devkitRef: devkitRef ?? null,
            generatedAt,
            files,
            providers,
        },
    };
}
/** Strictly decode legacy ownership or the dormant provider-scoped v2 shape. No filesystem I/O. */
export function decodeSyncManifest(value, kind) {
    if (!ASSET_KINDS.has(kind))
        throw new Error(`Unsupported agent asset kind: ${kind}`);
    const budget = { acceptedTextBytes: 0 };
    const fields = dataFields(value, 'sync manifest', budget);
    if (!fields.has('schemaVersion'))
        return decodeV1(fields, kind, budget);
    return decodeV2(fields, kind, budget);
}
/** Validate, canonicalize, and serialize v2 without publishing it. */
export function encodeSyncManifestV2(manifest, kind) {
    const decoded = decodeSyncManifest(manifest, kind);
    if (decoded.version !== 2)
        throw new Error('Expected sync manifest v2');
    return `${JSON.stringify(decoded.manifest, null, 2)}\n`;
}
