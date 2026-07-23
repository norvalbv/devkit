import { LEGACY_AGENT_PROVIDERS } from "../agent-providers.mjs";
const LEGACY_TARGETS = new Set(LEGACY_AGENT_PROVIDERS);
export const AGENT_ASSET_MANIFESTS = [
    { filename: 'skills-manifest.json', kind: 'skills' },
    { filename: 'agents-manifest.json', kind: 'agents' },
    { filename: 'agent-hooks-manifest.json', kind: 'hooks' },
];
/** Compare manifest digest maps without depending on JSON object key order. */
function manifestFilesEqual(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
/** Preserve the timestamp only when the decoded v1 manifest still describes the same output. */
export function nextLegacyManifestGeneratedAt(previous, devkitRef, files) {
    return previous?.devkitRef === devkitRef &&
        typeof previous.generatedAt === 'string' &&
        manifestFilesEqual(previous.files, files)
        ? previous.generatedAt
        : new Date().toISOString();
}
/** Fail closed before a legacy broad-surface writer could overwrite provider-scoped state. */
export function assertLegacyAssetWriterCompatible(decoded, targets, kind) {
    if (decoded?.version === 2)
        throw new Error(`${kind} manifest uses schema v2; the legacy writer cannot update it`);
    const unsupportedIndex = targets.findIndex((target) => typeof target !== 'string' || !LEGACY_TARGETS.has(target));
    if (unsupportedIndex !== -1) {
        const value = targets[unsupportedIndex];
        const label = JSON.stringify(value) ?? String(value);
        throw new Error(`${kind} assets cannot target ${label} through the legacy writer`);
    }
}
