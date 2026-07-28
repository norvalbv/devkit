import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Selection } from '../../components.mts';
import { packageDir } from '../../fs-helpers.mts';

export const DECISION_EDIT_HOOK = 'decision-edit-guard.mjs';
export const FALLOW_STAGED_GATE = 'fallow-staged-gate.sh';

export function bundledHookNames(): string[] {
  return readdirSync(join(packageDir(), 'agents-hooks'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/** The exact hook-script set implied by Devkit component selection. */
export function hookScriptsFor({
  agentHooks,
  decisions,
  fallow,
}: {
  agentHooks: boolean;
  decisions: boolean;
  fallow: boolean;
}): string[] {
  const all = bundledHookNames();
  const independentlyOwned = new Set([DECISION_EDIT_HOOK, FALLOW_STAGED_GATE]);
  return all.filter(
    (name) =>
      (agentHooks && !independentlyOwned.has(name)) ||
      (decisions && name === DECISION_EDIT_HOOK) ||
      (fallow && name === FALLOW_STAGED_GATE),
  );
}

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
