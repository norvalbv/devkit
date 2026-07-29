/**
 * Resolving what to do about a NON-DEVKIT asset collision — a same-named skill/agent/hook the
 * consumer authored themselves (on disk, unmanifested, and diverging from devkit's bundled copy).
 *
 * Lives beside the detectors it composes (detectSkillConflicts / detectAgentConflicts /
 * detectHookConflicts) rather than in init.mts, which only needs the resolved predicate. The
 * default is always PRESERVE: an install must never silently clobber something a consumer wrote.
 */
import { isCancel, multiselect } from '@clack/prompts';
import { detectAgentConflicts } from "../../../commands/sync/sync-agents.mjs";
import { detectSkillConflicts } from "../../../commands/sync/sync-skills.mjs";
import { AGENT_TARGETS } from "../../components.mjs";
import { selectedHookAssets } from "../hook-registration-ledger/selection.mjs";
import { detectHookConflicts } from "../install-hooks.mjs";
// Resolve the non-devkit-collision policy → an `override(kind, name)` predicate the sync step
// consults. A collision is a same-named asset the consumer authored (on disk, unmanifested, content
// DIVERGES from the bundle). DEFAULT is to PRESERVE it (never silently clobber a user asset): force
// → adopt all; non-interactive → preserve all (loud, with a --force hint); interactive → a per-asset
// multiselect (none ticked = preserve all). Keyed by `${kind}:${name}` so kinds never alias.
// Reason: flat policy resolver: the branches ARE the four resolution modes (none / force / non-interactive / interactive-pick), each a single guarded return; no nesting
// fallow-ignore-next-line complexity
export async function resolveAssetConflicts(gitRoot, selection, { interactive, force }) {
    const targets = selection.agentTargets ?? AGENT_TARGETS;
    const found = [];
    if (selection.skills)
        for (const name of detectSkillConflicts(gitRoot, targets, selection))
            found.push({ kind: 'skill', name });
    if (selection.agents)
        for (const name of detectAgentConflicts(gitRoot, targets))
            found.push({ kind: 'agent', name });
    // ONE derivation of the hook set (selectedHookAssets), not a second copy of the rules here —
    // the duplicate is how a caller ended up omitting `fallow` and pruning an installed gate.
    const desiredHooks = selectedHookAssets(selection).scripts;
    if (desiredHooks.length)
        for (const name of detectHookConflicts(gitRoot, targets, desiredHooks))
            found.push({ kind: 'agent-hook', name });
    if (!found.length)
        return () => false;
    const list = found.map((c) => `${c.kind}:${c.name}`).join(', ');
    if (force) {
        console.log(`  overriding ${found.length} non-devkit collision(s) with devkit's version: ${list}`);
        return () => true;
    }
    if (!interactive) {
        console.log(`  ! preserving ${found.length} non-devkit asset(s) that collide with devkit's: ${list}`);
        console.log("    (re-run with --force to overwrite them with devkit's versions)");
        return () => false;
    }
    const picked = await multiselect({
        message: 'These assets already exist and were NOT installed by devkit. Select any to OVERWRITE with devkit’s version (unselected are kept):',
        options: found.map((c) => ({
            value: `${c.kind}:${c.name}`,
            label: `${c.kind}: ${c.name}`,
        })),
        initialValues: [],
        required: false,
    });
    if (isCancel(picked))
        return () => false;
    const set = new Set(picked);
    return (kind, name) => set.has(`${kind}:${name}`);
}
