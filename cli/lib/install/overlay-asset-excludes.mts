import type { SyncManifestV2 } from './agent-asset-manifest/codec.mts';
import { agentAssetDir } from './agent-assets.mts';
import { type AgentAssetKind, SUPPORTED_AGENT_PROVIDERS } from './agent-providers.mts';

type AssetManifest = { schemaVersion?: never; files: Record<string, string> } | SyncManifestV2;

/** Git-exclude paths for exactly the provider outputs represented by an asset manifest. */
export function overlayAssetExcludes(
  manifest: AssetManifest,
  kind: AgentAssetKind,
  targets: string[],
): string[] {
  const excludes = new Set<string>();
  const add = (provider: string, outputRel: string) => {
    const dir = agentAssetDir(provider, kind);
    excludes.add(kind === 'skills' ? `${dir}/${outputRel.split('/')[0]}/` : `${dir}/${outputRel}`);
  };
  if (manifest.schemaVersion === 2) {
    for (const provider of SUPPORTED_AGENT_PROVIDERS)
      for (const outputRel of Object.keys(manifest.providers[provider]?.files ?? {}))
        add(provider, outputRel);
  } else {
    for (const target of targets)
      for (const logicalRel of Object.keys(manifest.files)) add(target, logicalRel);
  }
  return [...excludes];
}
