import { hookScriptsFor } from "./install-hooks.mjs";
function hookComponents(selection, searchSteering) {
    const decisions = selection.guards?.includes('decisions') ?? false;
    return [
        searchSteering && selection.searchSteering && 'searchSteering',
        selection.agentHooks && 'agentHooks',
        decisions && 'decisions',
        selection.fallow && 'fallow',
    ].filter((value) => Boolean(value));
}
/** Derive the hook-owning components and exact script set from one recorded selection. */
export function selectedHookAssets(selection, { searchSteering = true } = {}, previousSelection = {}) {
    const decisions = selection.guards?.includes('decisions') ?? false;
    return {
        components: hookComponents(selection, searchSteering),
        previouslyOwnedComponents: hookComponents(previousSelection, searchSteering),
        scripts: hookScriptsFor({
            agentHooks: Boolean(selection.agentHooks),
            decisions,
            fallow: Boolean(selection.fallow),
        }),
    };
}
