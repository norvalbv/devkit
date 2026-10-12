import { resolveGuardConfig } from '../../../gate-engine/config.mjs';
/**
 * prior-art advisory: gate on but no `research.referenceCheckouts` means the local leg reads nothing.
 * Declaration only — the agent is the one glob resolver; a corrupt config is the validity check's.
 */
export function printPriorArtAdvisoryHealth(cwd, sel) {
    if (!sel.priorArtGate)
        return;
    let declared;
    try {
        declared = resolveGuardConfig(cwd).research.referenceCheckouts;
    }
    catch {
        return;
    }
    if (declared.length)
        return;
    console.log('  · prior-art: guard.config.json declares no research.referenceCheckouts — the local research leg reads no reference checkout (declare sibling clones as globs)');
}
