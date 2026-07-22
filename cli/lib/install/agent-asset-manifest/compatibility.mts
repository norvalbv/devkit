import { join } from 'node:path';
import { type AgentAssetKind, LEGACY_AGENT_PROVIDERS } from '../agent-providers.mts';
import type { DecodedSyncManifest } from './codec.mts';
import { readAgentAssetManifest } from './reader.mts';

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compare manifest digest maps without depending on JSON object key order. */
export function manifestFilesEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** Return the first reason the legacy asset lifecycle must remain read-only. */
export function legacyAgentAssetLifecycleIssue(gitRoot: string): string | null {
  for (const { filename, kind } of AGENT_ASSET_MANIFESTS) {
    let decoded: DecodedSyncManifest | null;
    try {
      decoded = readAgentAssetManifest(join(gitRoot, '.devkit', filename), kind);
    } catch (error) {
      return `${filename}: invalid: ${messageOf(error)}`;
    }
    if (decoded?.version === 2) return `${filename}: uses schema v2`;
  }
  return null;
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
