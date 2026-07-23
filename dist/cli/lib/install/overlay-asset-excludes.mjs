import { agentAssetDir } from "./agent-assets.mjs";
import { SUPPORTED_AGENT_PROVIDERS } from "./agent-providers.mjs";
/** Git-exclude paths for exactly the provider outputs represented by an asset manifest. */
export function overlayAssetExcludes(manifest, kind, targets) {
    const excludes = new Set();
    const add = (provider, outputRel) => {
        const dir = agentAssetDir(provider, kind);
        excludes.add(kind === 'skills' ? `${dir}/${outputRel.split('/')[0]}/` : `${dir}/${outputRel}`);
    };
    if (manifest.schemaVersion === 2) {
        for (const provider of SUPPORTED_AGENT_PROVIDERS)
            for (const outputRel of Object.keys(manifest.providers[provider]?.files ?? {}))
                add(provider, outputRel);
    }
    else {
        for (const target of targets)
            for (const logicalRel of Object.keys(manifest.files))
                add(target, logicalRel);
    }
    return [...excludes];
}
