/** A linked worktree holding its own `.devkit/config.json` is a hand copy of the overlay, never an
 * install of its own: core.hooksPath names one home, so only that home's hooks ever run. */
import { basename, dirname, join, relative } from 'node:path';
import { overlayConfigured } from '../../../../gate-engine/overlay-mode.mjs';
import { detectGitRoot } from '../../detect-git-root.mjs';
import { sameDir } from '../../doctor/hooks-path.mjs';
import { declaresOverlay, namedHome, overlayHome, ownsOverlayConfig, worktrees, } from './overlay-home.mjs';
// devkit review's private worktrees hold a real config by design: <temp>/devkit-review-<id>/{final,base},
// where <temp> is the first writable of $TMPDIR, /tmp, /var/tmp (review-target.sh STATE_ROOT).
const isReviewRuntime = (wt) => ['final', 'base'].includes(basename(wt)) &&
    basename(dirname(wt)).startsWith('devkit-review-') &&
    [process.env.TMPDIR, '/tmp', '/var/tmp'].some((t) => t && sameDir(dirname(dirname(wt)), t));
// Package mode tracks a real config.json in every worktree, so one that parses as non-overlay is
// never an owner or a copy. An unparsable one still counts: gates fail closed on it anyway.
const ownsOverlay = (wt, pkgRel) => {
    if (!ownsOverlayConfig(wt, pkgRel))
        return false;
    try {
        return overlayConfigured(join(wt, pkgRel));
    }
    catch {
        return true;
    }
};
/** The checkout that owns the overlay: the one devkit's hooksPath names, else the main worktree,
 * either only while it holds an overlay config (a deleted or plain checkout owns nothing). */
function overlayOwner(gitRoot, pkgRel) {
    const [main] = worktrees(gitRoot);
    const candidates = [namedHome(gitRoot), main && !main.bare ? main.path : null];
    return candidates.find((dir) => dir !== null && ownsOverlay(dir, pkgRel)) ?? null;
}
/** The owner whose `.devkit` the worktree `wt` holds a copy of; null when it holds none. */
export function copiedFrom(wt, pkgRel) {
    if (!ownsOverlay(wt, pkgRel) || isReviewRuntime(wt))
        return null;
    const owner = overlayOwner(wt, pkgRel);
    return owner && !sameDir(owner, wt) ? owner : null;
}
export const copiedOverlayRow = (wt, pkgRel) => `  ⚠ ${wt}: its .devkit is a copy of the overlay's (it holds its own config.json), so projection skips it and gates there run on that copy's stale config — remove ${join(wt, pkgRel, '.devkit')} (move its baselines/ aside first if this branch froze its own), then run \`devkit doctor --fix\``;
/** Where an overlay-owning command runs: the home, when `cwd` borrows its overlay through links or
 * holds a copy of it. `refuseCopy` throws in a copy instead (clean would tear down the home). */
export function overlayCommandCwd(cwd, refuseCopy = false) {
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    const owner = copiedFrom(gitRoot, pkgRel);
    if (owner && refuseCopy)
        throw new Error(copiedOverlayRow(gitRoot, pkgRel).trim());
    // Own only when config.json itself is real: a real dir can hold a LINKED config (merged in).
    if (!owner && ownsOverlayConfig(gitRoot, pkgRel))
        return cwd;
    const home = owner ?? overlayHome(gitRoot);
    if (!home || sameDir(home, gitRoot))
        return cwd;
    const how = owner ? 'holds a copy of' : 'borrows';
    console.error(`devkit: this worktree ${how} the overlay at ${home} — running there`);
    return join(home, relative(gitRoot, cwd));
}
/** Ship's overlay root: `root` itself when it declares its own overlay, else the home — the owner
 * too for a copy. Found by config, not hook, so ship fails closed on a missing hook. */
export function shipOverlayRoot(root) {
    if (!declaresOverlay(root))
        return overlayHome(root, declaresOverlay);
    const { gitRoot, pkgRel } = detectGitRoot(root);
    const owner = copiedFrom(gitRoot, pkgRel);
    return owner ? join(owner, pkgRel) : root;
}
