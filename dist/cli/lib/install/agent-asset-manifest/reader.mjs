import { firstDuplicateJsonKey } from '../../../../gate-engine/critique/json-duplicate-keys.mjs';
import { LEGACY_AGENT_PROVIDERS } from '../agent-assets/agent-providers.mjs';
import { readBoundedRegularFile } from '../strict-bounded-file-read.mjs';
import { decodeSyncManifest } from './codec.mjs';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** Strictly read one optional agent-asset manifest without following its leaf path. */
export function readAgentAssetManifest(path, kind) {
    const bytes = readBoundedRegularFile(path, {
        label: 'agent asset manifest',
        maxBytes: MAX_MANIFEST_BYTES,
        limitLabel: '1 MiB',
    });
    if (bytes === null)
        return null;
    let raw;
    try {
        raw = UTF8.decode(bytes);
    }
    catch {
        throw new Error('agent asset manifest is not valid UTF-8');
    }
    const duplicate = firstDuplicateJsonKey(raw);
    if (duplicate !== null)
        throw new Error(`agent asset manifest has duplicate object field ${JSON.stringify(duplicate)}`);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('agent asset manifest is not valid JSON');
    }
    return decodeSyncManifest(parsed, kind);
}
/**
 * Legacy-provider slice of the requested (or manifest-recorded) target set — the providers a
 * pre-provider-aware devkit could have written to. Shared by the remove paths in
 * sync-manifest.mts and install-hooks.mts (was copy-pasted at three sites; sc-1414).
 */
export function resolveLegacyProviderTargets(decoded, targets) {
    const inferred = decoded?.version === 1 ? decoded.manifest.targets : [...LEGACY_AGENT_PROVIDERS];
    return (targets ?? inferred).filter((target) => LEGACY_AGENT_PROVIDERS.includes(target));
}
