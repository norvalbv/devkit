import type { Selection } from '../components.mts';
import { hookScriptsFor } from './install-hooks.mts';

export interface SelectedHookAssets {
  components: string[];
  previouslyOwnedComponents: string[];
  scripts: string[];
}

function hookComponents(selection: Partial<Selection>, searchSteering: boolean): string[] {
  const decisions = selection.guards?.includes('decisions') ?? false;
  return [
    searchSteering && selection.searchSteering && 'searchSteering',
    selection.agentHooks && 'agentHooks',
    decisions && 'decisions',
    selection.fallow && 'fallow',
  ].filter((value): value is string => Boolean(value));
}

/** Derive the hook-owning components and exact script set from one recorded selection. */
export function selectedHookAssets(
  selection: Partial<Selection>,
  { searchSteering = true }: { searchSteering?: boolean } = {},
  previousSelection: Partial<Selection> = {},
): SelectedHookAssets {
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
