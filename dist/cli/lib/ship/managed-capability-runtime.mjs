#!/usr/bin/env node
/**
 * Refresh devkit-MANAGED Oxc/anti-slop capability state inside an ephemeral ship worktree, from the
 * RUNNING devkit package.
 *
 * Why: the ship worktree is a clean checkout at $BASE — for `ship --pr` that base is the EXISTING PR
 * branch tip, so its `.devkit/oxc/*` and `.devkit/anti-slop/*` are whatever the branch FORKED WITH.
 * But `prepare_gate_worktree` links the CALLER's node_modules in, so the gates that run there are the
 * caller's CURRENT devkit. `oxcBaseCapabilityIssue` (install/oxc/lifecycle.mts) compares the
 * worktree's COMMITTED `baseDigest` against `digest(baseContent())` read from `packageDir()` of that
 * install, and `capabilityHealth`'s `rulesComplete` (install/anti-slop/lifecycle.mts) compares the
 * worktree's COMMITTED ruleIds against `ANTI_SLOP_RULE_IDS` compiled into the same package. After a
 * gate-infra change lands on the base, both comparisons straddle two provenances devkit itself
 * created, and every re-push to a pre-change branch dies on "managed Oxlint base manifest digest is
 * stale; refusing an incomplete baseline" — deterministically, whatever content is staged (sc-2099).
 *
 * This is the same ruling as sc-1300 one file-set over: refresh the running package's state INSIDE
 * the ephemeral gate worktree, never in the caller checkout and never in the shipped commit. We write
 * only the WORKING TREE, so `ship_assert_staged_unchanged` still holds byte-exact and the commit
 * (made without `-a`) carries exactly the briefed paths.
 *
 * The refresh source is the RUNNING PACKAGE, not `origin/<base>`: that ref is not the operand either
 * check compares against, so copying from it would pass only by coincidence — and it would drag `gh`
 * into a flow that deliberately supports non-GitHub origins and dry runs.
 *
 * Usage:  managed-capability-runtime.mjs project <worktree> <consumer-root>
 * Always exits 0 for a projection OR a named skip: skipping only removes a FALSE NEGATIVE, since the
 * capability gate itself still runs in the worktree and still fails closed. Exit 1 is argv misuse.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from '../fs-helpers.mjs';
import { ANTI_SLOP_CONFIG_REL, ANTI_SLOP_MANAGED_REL, ANTI_SLOP_MANIFEST_REL, } from '../install/anti-slop/constants.mjs';
import { syncAntiSlopCapability } from '../install/anti-slop/lifecycle.mjs';
import { syncOxcCapability } from '../install/oxc/lifecycle.mjs';
const OXC_MANIFEST_REL = '.devkit/oxc/manifest.json';
const OXC_BASE_REL = '.devkit/oxc/oxlint.base.json';
/**
 * Does this repo run the anti-slop lane? The caller checkout's RECORDED selection is authoritative —
 * it is the same `sel` `devkit doctor --fix` acts on. A fork-point config may predate the
 * `components` block, so fall back to the managed-bytes probe `syncAntiSlopCapability`'s own rollback
 * path already uses.
 */
function antiSlopSelected(root, wt) {
    let recorded;
    try {
        recorded = readJson(join(root, '.devkit', 'config.json'))?.components?.antiSlop;
    }
    catch (error) {
        // `readJson` THROWS on unparseable JSON. A hand-edited or half-written config is a reason to
        // fall back to the on-disk evidence below — never to kill the refresh, which would degrade a
        // named skip into an unhandled stack trace and leave the fork-point dead-end in place.
        console.error(`  ↳ shipping: unreadable .devkit/config.json (${String(error)}) — probing disk`);
    }
    if (recorded === true)
        return true;
    if (recorded === false)
        return false;
    return existsSync(join(wt, ANTI_SLOP_MANIFEST_REL)) && existsSync(join(wt, ANTI_SLOP_CONFIG_REL));
}
/**
 * Overlay mode links `.devkit` wholesale from the caller (prepare-gate-worktree.sh), so the worktree
 * already READS live infra and there is nothing to refresh — while a write through that symlink would
 * be exactly the persistent caller-checkout mutation sc-1300 rejected. Test the directory boundary as
 * a LEAF (lstat, no traversal), the way `refresh_ship_reviewer_assets` does.
 */
function devkitDirIsLinked(wt) {
    try {
        return lstatSync(join(wt, '.devkit')).isSymbolicLink();
    }
    catch {
        return false; // absent → a fresh managed install below, not a link
    }
}
function skip(reason) {
    console.error(`  ↳ shipping: managed capability refresh skipped — ${reason}`);
}
/** Bring $wt's managed Oxc (+ anti-slop) bytes up to the running package. Never throws. */
export function projectManagedCapability(wt, root) {
    let physicalWt = '';
    let physicalRoot = '';
    try {
        physicalWt = realpathSync(wt);
        physicalRoot = realpathSync(root);
    }
    catch (error) {
        skip(`worktree or root path is unreadable (${String(error)})`);
        return;
    }
    if (physicalWt === physicalRoot) {
        skip('refusing to refresh managed capability state in the caller checkout');
        return;
    }
    if (devkitDirIsLinked(physicalWt)) {
        skip('overlay mode links .devkit from the caller — already current');
        return;
    }
    const antiSlop = antiSlopSelected(physicalRoot, physicalWt);
    try {
        if (antiSlop)
            syncAntiSlopCapability(physicalWt);
        else
            syncOxcCapability(physicalWt, { antiSlop: false });
    }
    catch (error) {
        // The bundled Oxc runtime can be unavailable (optional platform binaries), or a consumer config
        // collision can block the sync. Either way the capability gate still runs in the worktree and
        // still fails closed — so this degrades to today's behaviour rather than failing open.
        skip(`${error instanceof Error ? error.message : String(error)} — run \`devkit doctor --fix\` in your checkout`);
        return;
    }
    const refreshed = [OXC_MANIFEST_REL, OXC_BASE_REL];
    if (antiSlop)
        refreshed.push(`${ANTI_SLOP_MANAGED_REL}/**`);
    console.error(`  ↳ shipping: refreshed managed capability state from running devkit package (${refreshed.join(', ')}) — worktree only, never staged`);
}
function main() {
    const [verb, wt, root] = process.argv.slice(2);
    if (verb !== 'project' || !wt || !root) {
        console.error('usage: managed-capability-runtime.mjs project <worktree> <consumer-root>');
        process.exitCode = 1;
        return;
    }
    projectManagedCapability(wt, root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    main();
}
