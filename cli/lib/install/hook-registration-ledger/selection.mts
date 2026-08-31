import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Selection } from '../../components.mts';
import { packageDir } from '../../fs-helpers.mts';

export const DECISION_EDIT_HOOK = 'decision-edit-guard.mjs';
export const DECISION_SCOPE_BRIEF_HOOK = 'decision-scope-brief.mjs';
export const ADHD_SESSION_HOOK = 'adhd-session-start.mjs';
export const ADHD_ANCHOR_HOOK = 'adhd-prompt-anchor.mjs';
export const FALLOW_STAGED_GATE = 'fallow-staged-gate.sh';
export const PRIOR_ART_GATE_HOOK = 'prior-art-gate.mjs';
export const BASE_DRIFT_SESSION_HOOK = 'base-drift-session.mjs';
export const BASE_DRIFT_BRIEF_HOOK = 'base-drift-brief.mjs';
/** Shared plumbing both base-drift hooks import; owned by the same component, never wired alone. */
export const BASE_DRIFT_LIB = 'base-drift-lib.mjs';

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
  adhd,
  priorArtGate,
  // Optional, not required: tsconfig excludes tests, so a required key omitted by a test caller is
  // a type error nothing in CI ever surfaces. Absent means "not selected", which is the same answer
  // an explicit false gives.
  baseDrift = false,
}: {
  agentHooks: boolean;
  decisions: boolean;
  fallow: boolean;
  adhd: boolean;
  priorArtGate: boolean;
  baseDrift?: boolean;
}): string[] {
  const all = bundledHookNames();
  // Scripts owned by a component OTHER than agentHooks — selecting agent hooks must not drag them
  // in, and deselecting agent hooks must not prune them.
  const adhdOwned = new Set([ADHD_SESSION_HOOK, ADHD_ANCHOR_HOOK]);
  // Both scripts the `decisions` component REGISTERS (hook-registrations decisions:pre-edit and
  // decisions:scope-brief). A script the registry wires must be installed by the same component that
  // wires it — leaving the brief to the agentHooks catch-all wrote a registration the default
  // selection (decisions on, agentHooks off) never installed a file for (sc-2278).
  const decisionsOwned = new Set([DECISION_EDIT_HOOK, DECISION_SCOPE_BRIEF_HOOK]);
  // Both scripts the `baseDrift` component registers, PLUS the lib they import. The lib is not
  // registered anywhere, so the agentHooks catch-all would otherwise own it — and deselecting agent
  // hooks would then prune the file two selected hooks import, leaving them installed and broken.
  const baseDriftOwned = new Set([BASE_DRIFT_SESSION_HOOK, BASE_DRIFT_BRIEF_HOOK, BASE_DRIFT_LIB]);
  const independentlyOwned = new Set([
    FALLOW_STAGED_GATE,
    PRIOR_ART_GATE_HOOK,
    ...decisionsOwned,
    ...adhdOwned,
    ...baseDriftOwned,
  ]);
  return all.filter(
    (name) =>
      (agentHooks && !independentlyOwned.has(name)) ||
      (decisions && decisionsOwned.has(name)) ||
      (fallow && name === FALLOW_STAGED_GATE) ||
      (adhd && adhdOwned.has(name)) ||
      (priorArtGate && name === PRIOR_ART_GATE_HOOK) ||
      (baseDrift && baseDriftOwned.has(name)),
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
    selection.adhd && 'adhd',
    selection.priorArtGate && 'priorArtGate',
    selection.baseDrift && 'baseDrift',
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
      adhd: Boolean(selection.adhd),
      priorArtGate: Boolean(selection.priorArtGate),
      baseDrift: Boolean(selection.baseDrift),
    }),
  };
}
