/** Resolve anti-slop for an OVERLAY install: refuse-or-install, then grandfather existing debt. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAntiSlopBaseline } from '../../../../commands/oxc/anti-slop.mjs';
import { trackedPathPredicate } from '../../../git-tracked.mjs';
import { firstLine } from '../../../standalone.mjs';
import { OVERLAY_ENTRY_REL, OXLINT_CONFIGS, syncOxcCapability } from '../../oxc/lifecycle.mjs';
import { ANTI_SLOP_BASELINE_REL, ANTI_SLOP_MANIFEST_REL } from '../constants.mjs';
import { removeAntiSlopCapability, syncAntiSlopCapability } from '../lifecycle.mjs';
/**
 * Paths an overlay anti-slop install owns; git must track NONE, since `.git/info/exclude` cannot
 * hide a tracked file. Dirs not files: a partly tracked capability is refused, not half-projected.
 */
const OVERLAY_OXC_OWNED = [OVERLAY_ENTRY_REL, '.devkit/oxc'];
const OVERLAY_ANTI_SLOP_OWNED = [...OVERLAY_OXC_OWNED, ANTI_SLOP_BASELINE_REL, '.devkit/anti-slop'];
/** True, with the untrack remedy printed, when git tracks any owned path the overlay must write. */
function ownedPathTracked(gitRoot, pfx, owned, what) {
    const isTracked = trackedPathPredicate(gitRoot);
    const tracked = owned.filter((rel) => isTracked(`${pfx}${rel}`));
    if (tracked.length === 0)
        return false;
    console.log(`  ! ${what} skipped — git already TRACKS ${tracked.join(', ')}; an overlay cannot hide a tracked path.`);
    // NOT `devkit clean`: it now declines to delete a tracked path (and prints why), so naming it
    // here would point at a command that cannot perform the fix. Untracking is the only remedy.
    console.log(`    Untrack them first: \`git rm -r --cached ${tracked.map((rel) => `${pfx}${rel}`).join(' ')}\` and commit.`);
    return true;
}
/** Reclaim a half-installed capability so no stranded managed tree outlives its gate. */
function abandon(cwd, reason) {
    console.log(`  ! anti-slop ${reason} — skipping the gate.`);
    try {
        removeAntiSlopCapability(cwd, false, true);
    }
    catch {
        // Preserve the original failure; doctor reports and repairs any residual managed state.
    }
    return false;
}
/** Never reconciles the exclude: `installOverlay` excludes every overlay-written path in one call, and
 * a second call naming only these would prune every agent line it omits. */
export function wireOverlayAntiSlop(cwd, gitRoot, pfx, sel, dryRun) {
    let wired = false;
    if (sel.antiSlop) {
        console.log('  anti-slop (vendored Oxlint rules + per-clone baseline)');
        wired = resolveOverlayAntiSlop(cwd, gitRoot, pfx, dryRun);
    }
    else {
        if (existsSync(join(cwd, ANTI_SLOP_MANIFEST_REL))) {
            console.log('  anti-slop (deselected — reclaiming)');
            removeAntiSlopCapability(cwd, dryRun, true);
        }
        // Core Oxc, as package mode always installs it; anti-slop's own sync carries it otherwise.
        if (!ownedPathTracked(gitRoot, pfx, OVERLAY_OXC_OWNED, 'Oxc')) {
            try {
                syncOxcCapability(cwd, { dryRun, antiSlop: false, overlay: true });
            }
            catch (error) {
                // The install goes on so its excludes still hide what it wrote; doctor reports the gap.
                console.log(`  ! Oxc could not be installed (${firstLine(error)}) — skipping it.`);
            }
        }
    }
    return { wired };
}
/**
 * Returns whether to wire the gate; the hook renders from `selection.antiSlop`, so this comes first.
 * A missing baseline BLOCKS, so create it here — if absent, never `--force` (overlay-self-heal).
 */
export function resolveOverlayAntiSlop(cwd, gitRoot, pfx, dryRun) {
    if (dryRun) {
        console.log('  [dry-run] anti-slop: sync capability → baseline-if-absent → gate in hook');
        return true;
    }
    if (ownedPathTracked(gitRoot, pfx, OVERLAY_ANTI_SLOP_OWNED, 'anti-slop'))
        return false;
    // `-c` replaces discovery outright, so a consumer's own Oxlint config would stop being read;
    // refusing beats silently overriding a linter config in a repo devkit does not own.
    const consumerConfig = OXLINT_CONFIGS.find((name) => existsSync(join(cwd, name)));
    if (consumerConfig) {
        console.log(`  ! anti-slop skipped — this repo has its own ${consumerConfig}, which an overlay install cannot compose with yet.`);
        console.log('    Overlay passes `-c oxlint.devkit.json`, and that replaces config discovery rather than extending it.');
        return false;
    }
    try {
        syncAntiSlopCapability(cwd, { overlay: true });
    }
    catch (error) {
        return abandon(cwd, `could not be installed (${firstLine(error)})`);
    }
    if (existsSync(join(cwd, ANTI_SLOP_BASELINE_REL))) {
        console.log(`  ✓ anti-slop baseline present (${ANTI_SLOP_BASELINE_REL}) — not re-snapshotted`);
        return true;
    }
    console.log('  adopting existing debt into a per-clone baseline (whole repository)...');
    if (createAntiSlopBaseline(cwd, [], false, false) !== 0) {
        return abandon(cwd, 'baseline could not be created');
    }
    return true;
}
