import { type AgentAssetKind, LEGACY_AGENT_PROVIDERS } from '../agent-assets/agent-providers.mts';
import type { DecodedSyncManifest } from './codec.mts';

type LegacyDecodedSyncManifest = Extract<DecodedSyncManifest, { version: 1 }> | null;
const LEGACY_TARGETS = new Set<string>(LEGACY_AGENT_PROVIDERS);

export const AGENT_ASSET_MANIFESTS: ReadonlyArray<{
  filename: string;
  kind: AgentAssetKind;
}> = [
  { filename: 'skills-manifest.json', kind: 'skills' },
  { filename: 'agents-manifest.json', kind: 'agents' },
  { filename: 'agent-hooks-manifest.json', kind: 'hooks' },
];

/** Fail closed before a legacy broad-surface writer could overwrite provider-scoped state. */
export function assertLegacyAssetWriterCompatible(
  decoded: DecodedSyncManifest | null,
  targets: readonly unknown[],
  kind: AgentAssetKind,
): asserts decoded is LegacyDecodedSyncManifest {
  if (decoded?.version === 2)
    throw new Error(`${kind} manifest uses schema v2; the legacy writer cannot update it`);
  const unsupportedIndex = targets.findIndex(
    (target) => typeof target !== 'string' || !LEGACY_TARGETS.has(target),
  );
  if (unsupportedIndex !== -1) {
    const value = targets[unsupportedIndex];
    const label = JSON.stringify(value) ?? String(value);
    throw new Error(`${kind} assets cannot target ${label} through the legacy writer`);
  }
}
