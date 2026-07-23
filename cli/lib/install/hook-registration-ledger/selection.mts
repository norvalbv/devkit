import type { Selection } from '../../components.mts';
import { hookScriptsFor } from '../install-hooks.mts';

export interface SelectedHookAssets {
  components: string[];
  scripts: string[];
}

/** Derive the hook-owning components and exact script set from one recorded selection. */
export function selectedHookAssets(
  selection: Partial<Selection>,
  { searchSteering = true }: { searchSteering?: boolean } = {},
): SelectedHookAssets {
  const decisions = selection.guards?.includes('decisions') ?? false;
  return {
    components: [
      searchSteering && selection.searchSteering && 'searchSteering',
      selection.agentHooks && 'agentHooks',
      decisions && 'decisions',
    ].filter((value): value is string => Boolean(value)),
    scripts: hookScriptsFor({
      agentHooks: Boolean(selection.agentHooks),
      decisions,
    }),
  };
}
