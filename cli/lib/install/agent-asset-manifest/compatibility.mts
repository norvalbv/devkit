import { type AgentAssetKind, LEGACY_AGENT_PROVIDERS } from '../agent-providers.mts';
import type { DecodedSyncManifest } from './codec.mts';

type LegacyDecodedSyncManifest = Extract<DecodedSyncManifest, { version: 1 }> | null;
type LegacyManifest = Exclude<LegacyDecodedSyncManifest, null>['manifest'];
const LEGACY_TARGETS = new Set<string>(LEGACY_AGENT_PROVIDERS);

export const AGENT_ASSET_MANIFESTS: ReadonlyArray<{
  filename: string;
  kind: AgentAssetKind;
}> = [
  { filename: 'skills-manifest.json', kind: 'skills' },
  { filename: 'agents-manifest.json', kind: 'agents' },
  { filename: 'agent-hooks-manifest.json', kind: 'hooks' },
];

/** Compare manifest digest maps without depending on JSON object key order. */
function manifestFilesEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** Preserve the timestamp only when the decoded v1 manifest still describes the same output. */
export function nextLegacyManifestGeneratedAt(
  previous: LegacyManifest | null,
  devkitRef: string | null,
  files: Readonly<Record<string, string>>,
): string {
  return previous?.devkitRef === devkitRef &&
    typeof previous.generatedAt === 'string' &&
    manifestFilesEqual(previous.files, files)
    ? previous.generatedAt
    : new Date().toISOString();
}

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
