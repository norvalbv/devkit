import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { QAVIS_RECIPE, qavisOnPath, qavisSupportsPublish, } from '../../../gate-engine/qavis-advisory/check.mjs';
import { detectGitRoot } from '../detect-git-root.mjs';
import { QAVIS_ADVISORY_ID } from '../husky/husky-block.mjs';
/**
 * qavis-advisory health — ADVISORY, printed by every doctor mode, never a CheckResult and never a
 * `--fix` target. Deliberately outside the exit code: a repo that keeps the guard selected but has
 * no qavis installed is a choice, not drift.
 *
 * What it catches is the gate's one blind spot: it fails OPEN when qavis can't be reached, so a
 * missing binary looks exactly like a healthy "nothing to QA" at commit time. Resolved against the
 * git ROOT because that's the cwd the husky fragment shells the gate from — doctor should report
 * what the hook would actually see, not what this cwd sees.
 */
export function printQavisAdvisoryHealth(cwd, guards) {
    if (!guards.includes(QAVIS_ADVISORY_ID))
        return;
    const { gitRoot } = detectGitRoot(cwd);
    if (!existsSync(join(gitRoot, QAVIS_RECIPE))) {
        console.log(`  · ${QAVIS_ADVISORY_ID}: no ${QAVIS_RECIPE} — gate inert (nothing to QA)`);
    }
    else if (!qavisOnPath(process.env, gitRoot)) {
        console.log(`  · ${QAVIS_ADVISORY_ID}: ${QAVIS_RECIPE} present but qavis is NOT on PATH — the QA advisory is skipped on every commit (install qavis, or drop the guard)`);
    }
    else {
        // The gate is live — but ship's OTHER qavis path can still be inert, and it reports that only in
        // post-push stderr, which a headless shipping agent may never read. Paid solely on this arm (one
        // `qavis --help` spawn in a repo already proven to have both a recipe and the binary). Three
        // states, not two: null means the probe could not ask, and reporting that as "cannot publish"
        // would state a fact about a binary devkit never managed to interrogate.
        const supportsPublish = qavisSupportsPublish(gitRoot);
        const publish = supportsPublish === null
            ? 'publication support UNKNOWN — its --help did not answer (ship will decline to publish)'
            : supportsPublish
                ? 'PR evidence publishes on ship'
                : 'ship cannot publish PR evidence — this qavis predates `publish` (upgrade it)';
        console.log(`  ✓ ${QAVIS_ADVISORY_ID}: qavis on PATH (${QAVIS_RECIPE} present) · ${publish}`);
    }
}
