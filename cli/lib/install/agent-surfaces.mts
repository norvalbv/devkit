import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { syncAgents } from '../../commands/sync/sync-agents.mts';
import { syncSkills } from '../../commands/sync/sync-skills.mts';
import { AGENT_TARGETS, type Selection } from '../components.mts';
import { removeAgents, removeSkills } from '../sync-manifest.mts';
import { agentAssetDir } from './agent-assets.mts';
import { SUPPORTED_AGENT_PROVIDERS } from './agent-providers.mts';
import { selectedHookAssets } from './hook-registration-ledger/selection.mts';
import {
  installHookRegistrations,
  removeHookRegistrations,
  removeHookScripts,
  syncHookScripts,
} from './install-hooks.mts';

type OverrideAsset = (kind: string, name: string) => boolean;

function pruneDeselectedSurfaces(
  gitRoot: string,
  selection: Selection,
  agentTargets: string[],
  hookScripts: string[],
  dryRun: boolean,
  legacyOwnedComponentIds: string[],
) {
  const prunedTargets = SUPPORTED_AGENT_PROVIDERS.filter(
    (target) => !agentTargets.includes(target),
  );
  const settingsFile: Record<string, string> = {
    claude: '.claude/settings.json',
    codex: '.codex/hooks.json',
    cursor: '.cursor/hooks.json',
  };
  const hasContent = prunedTargets.some(
    (target) =>
      (['skills', 'agents', 'hooks'] as const).some((kind) =>
        existsSync(join(gitRoot, agentAssetDir(target, kind))),
      ) || existsSync(join(gitRoot, settingsFile[target])),
  );
  if (!prunedTargets.length || !hasContent) return;
  console.log(`7d. prune deselected agent surface(s): ${prunedTargets.join(', ')}`);
  if (selection.skills) removeSkills(gitRoot, dryRun, prunedTargets, false);
  if (selection.agents) removeAgents(gitRoot, dryRun, prunedTargets, false);
  if (hookScripts.length)
    removeHookScripts(gitRoot, {
      dryRun,
      targets: prunedTargets,
      dropManifest: false,
    });
  removeHookRegistrations(gitRoot, {
    dryRun,
    targets: prunedTargets,
    legacyOwnedComponentIds,
  });
}

/** Exact-reconcile all selected agent assets and prune deselected surfaces. */
export function installAgentSurfaces(
  gitRoot: string,
  selection: Selection,
  dryRun: boolean,
  override: OverrideAsset = () => false,
  legacyOwnedComponentIds: string[] = [],
) {
  const targets = selection.agentTargets ?? AGENT_TARGETS;
  if (selection.skills) {
    console.log('7. skills');
    syncSkills(dryRun ? ['--dry-run'] : [], gitRoot, targets, {
      override,
      guards: selection.guards ?? [],
    });
  } else if (existsSync(join(gitRoot, '.devkit', 'skills-manifest.json'))) {
    console.log('7. remove deselected skills');
    removeSkills(gitRoot, dryRun);
  }
  if (selection.agents) {
    console.log('7a. agents');
    syncAgents(dryRun ? ['--dry-run'] : [], gitRoot, targets, { override });
  }

  const hooks = selectedHookAssets(selection);
  if (hooks.scripts.length) {
    console.log('7b. agent-hook scripts');
    syncHookScripts(gitRoot, {
      dryRun,
      targets,
      desired: hooks.scripts,
      override,
    });
  } else if (existsSync(join(gitRoot, '.devkit', 'agent-hooks-manifest.json'))) {
    console.log('7b. remove deselected agent-hook scripts');
    removeHookScripts(gitRoot, { dryRun });
  }

  if (hooks.components.length) {
    console.log('7c. agent hook registrations');
    installHookRegistrations(gitRoot, hooks.components, {
      dryRun,
      targets,
      legacyOwnedComponentIds,
    });
  } else if (
    targets.some((target) =>
      existsSync(
        join(gitRoot, target === 'claude' ? '.claude/settings.json' : `.${target}/hooks.json`),
      ),
    )
  ) {
    removeHookRegistrations(gitRoot, { dryRun, targets, legacyOwnedComponentIds });
  }
  pruneDeselectedSurfaces(
    gitRoot,
    selection,
    targets,
    hooks.scripts,
    dryRun,
    legacyOwnedComponentIds,
  );
  return targets;
}

/** Re-sync selected assets with collision adoption, leaving consumer configs untouched. */
export function adoptAgentAssetCollisions(gitRoot: string, selection: Selection, dryRun: boolean) {
  const targets = selection.agentTargets ?? AGENT_TARGETS;
  const override = () => true;
  if (selection.skills)
    syncSkills(dryRun ? ['--dry-run'] : [], gitRoot, targets, {
      override,
      guards: selection.guards ?? [],
    });
  if (selection.agents) syncAgents(dryRun ? ['--dry-run'] : [], gitRoot, targets, { override });
  const scripts = selectedHookAssets(selection).scripts;
  if (scripts.length)
    syncHookScripts(gitRoot, {
      dryRun,
      targets,
      desired: scripts,
      override,
    });
}
