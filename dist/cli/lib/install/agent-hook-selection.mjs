import { hookScriptsFor } from "./install-hooks.mjs";
/** Derive the hook-owning components and exact script set from one recorded selection. */
export function selectedHookAssets(selection, { searchSteering = true } = {}) {
    const decisions = selection.guards?.includes('decisions') ?? false;
    return {
        components: [
            searchSteering && selection.searchSteering && 'searchSteering',
            selection.agentHooks && 'agentHooks',
            decisions && 'decisions',
        ].filter((value) => Boolean(value)),
        scripts: hookScriptsFor({
            agentHooks: Boolean(selection.agentHooks),
            decisions,
        }),
    };
}
