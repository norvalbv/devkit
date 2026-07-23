import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { syncAgents } from "../../commands/sync/sync-agents.mjs";
import { syncSkills } from "../../commands/sync/sync-skills.mjs";
import { AGENT_TARGETS } from "../components.mjs";
import { removeAgents, removeSkills } from "../sync-manifest.mjs";
import { selectedHookAssets } from "./agent-hook-selection.mjs";
import { installHookRegistrations, removeHookRegistrations, removeHookScripts, syncHookScripts, } from "./install-hooks.mjs";
function pruneDeselectedSurfaces(gitRoot, selection, agentTargets, hookScripts, dryRun) {
    const prunedTargets = AGENT_TARGETS.filter((target) => !agentTargets.includes(target));
    const settingsFile = {
        claude: '.claude/settings.json',
        cursor: '.cursor/hooks.json',
    };
    const hasContent = prunedTargets.some((target) => ['skills', 'agents', 'hooks'].some((kind) => existsSync(join(gitRoot, `.${target}`, kind))) ||
        existsSync(join(gitRoot, settingsFile[target])));
    if (!prunedTargets.length || !hasContent)
        return;
    console.log(`7d. prune deselected agent surface(s): ${prunedTargets.join(', ')}`);
    if (selection.skills)
        removeSkills(gitRoot, dryRun, prunedTargets, false);
    if (selection.agents)
        removeAgents(gitRoot, dryRun, prunedTargets, false);
    if (hookScripts.length)
        removeHookScripts(gitRoot, {
            dryRun,
            targets: prunedTargets,
            dropManifest: false,
        });
    removeHookRegistrations(gitRoot, { dryRun, targets: prunedTargets });
}
/** Exact-reconcile all selected agent assets and prune deselected surfaces. */
export function installAgentSurfaces(gitRoot, selection, dryRun, override = () => false) {
    const targets = selection.agentTargets ?? AGENT_TARGETS;
    if (selection.skills) {
        console.log('7. skills');
        syncSkills(dryRun ? ['--dry-run'] : [], gitRoot, targets, {
            override,
            guards: selection.guards ?? [],
        });
    }
    else if (existsSync(join(gitRoot, '.devkit', 'skills-manifest.json'))) {
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
    }
    else if (existsSync(join(gitRoot, '.devkit', 'agent-hooks-manifest.json'))) {
        console.log('7b. remove deselected agent-hook scripts');
        removeHookScripts(gitRoot, { dryRun });
    }
    if (hooks.components.length) {
        console.log('7c. agent hook registrations');
        installHookRegistrations(gitRoot, hooks.components, { dryRun, targets });
    }
    else if (targets.some((target) => existsSync(join(gitRoot, target === 'claude' ? '.claude/settings.json' : '.cursor/hooks.json')))) {
        removeHookRegistrations(gitRoot, { dryRun, targets });
    }
    pruneDeselectedSurfaces(gitRoot, selection, targets, hooks.scripts, dryRun);
    return targets;
}
/** Re-sync selected assets with collision adoption, leaving consumer configs untouched. */
export function adoptAgentAssetCollisions(gitRoot, selection, dryRun) {
    const targets = selection.agentTargets ?? AGENT_TARGETS;
    const override = () => true;
    if (selection.skills)
        syncSkills(dryRun ? ['--dry-run'] : [], gitRoot, targets, {
            override,
            guards: selection.guards ?? [],
        });
    if (selection.agents)
        syncAgents(dryRun ? ['--dry-run'] : [], gitRoot, targets, { override });
    const scripts = selectedHookAssets(selection).scripts;
    if (scripts.length)
        syncHookScripts(gitRoot, {
            dryRun,
            targets,
            desired: scripts,
            override,
        });
}
