import { LEGACY_AGENT_PROVIDERS } from '../agent-assets/agent-providers.mjs';
const LEGACY_TARGETS = new Set(LEGACY_AGENT_PROVIDERS);
export const AGENT_ASSET_MANIFESTS = [
    { filename: 'skills-manifest.json', kind: 'skills' },
    { filename: 'agents-manifest.json', kind: 'agents' },
    { filename: 'agent-hooks-manifest.json', kind: 'hooks' },
];
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
