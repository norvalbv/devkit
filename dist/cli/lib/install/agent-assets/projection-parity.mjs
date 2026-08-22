/**
 * Projection parity — does an agent surface still hold exactly what the sync writer would put there?
 *
 * `skills/` and `agents/` are sources of truth; `.claude/…`, `.cursor/…` and `.agents/…` are
 * projections of them. #405 and #395 each edited a source without re-running the writer, and the
 * projections served deleted scripts and a stale MCP tool profile for days. The recorded mitigation
 * (manifest sha256 + doctor) cannot catch it: doctor's asset check is advisory-only in self-host.
 *
 * This is the READER half of that contract, deliberately kept out of the test file so it is
 * typechecked (`tsconfig.json` excludes `**\/*.test.mts`) and can be exercised against fixtures.
 * Enumeration and selection reuse the writers' own `walk` / `listAgents` / `skillNamesForSelection`
 * rather than re-deriving them — reader and writer drifted apart once already (components.mts:346).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAgents } from "../../../commands/sync/sync-agents.mjs";
import { walk } from "../../../commands/sync/sync-skills.mjs";
import { skillNamesForSelection } from "../../components.mjs";
import { agentAssetDir, projectAgentAsset, projectedAssetRel } from "./agent-assets.mjs";
/** The logical files the writer would ship for `kind`, after the shared selection filter. */
export function projectedLogicals({ root, kind, srcDir, selection = {}, }) {
    const src = join(root, srcDir);
    if (kind === 'agents')
        return listAgents(src);
    const all = walk(src);
    const names = new Set(skillNamesForSelection([...new Set(all.map((rel) => rel.split('/')[0]))], selection));
    return all.filter((rel) => names.has(rel.split('/')[0]));
}
/**
 * Compare `dest` to the bytes the writer would produce.
 *
 * The read is guarded because `walk` is lstat-shaped: it reports a symlink-to-directory as a leaf,
 * so `readFileSync` on one throws EISDIR. A parity check that CRASHES on a malformed projection is
 * strictly worse than one that reports it — unreadable is, for this purpose, simply not identical.
 */
function matchesProjection(dest, want) {
    try {
        return readFileSync(dest).equals(want);
    }
    catch {
        return false;
    }
}
/**
 * Every way `root`'s projections diverge from their source, as human-readable lines.
 *
 * Three classes, because they need different repairs: `missing`/`stale` are fixed by re-running the
 * writer, but an `orphan` never is — sync removes only what the manifest records, so an unmanifested
 * file on disk survives every re-sync and has to be deleted by hand.
 *
 * An empty `targets` reports `unchecked` rather than returning `[]`. A vacuous pass is the one
 * outcome a drift guard must never produce: it is indistinguishable from a clean tree while
 * guarding nothing at all.
 */
export function projectionDrift(input) {
    const { root, kind, srcDir, targets } = input;
    if (!targets.length)
        return [`unchecked ${kind}/ — no agentTargets configured, nothing compared`];
    const src = join(root, srcDir);
    const logicals = projectedLogicals(input);
    const drift = [];
    for (const target of targets) {
        const dir = agentAssetDir(target, kind);
        const expected = new Map(logicals.map((rel) => [projectedAssetRel(target, kind, rel), rel]));
        for (const [rel, logical] of expected) {
            const dest = join(root, dir, rel);
            const want = projectAgentAsset(target, kind, logical, readFileSync(join(src, logical)));
            if (!existsSync(dest))
                drift.push(`missing ${dir}/${rel}`);
            else if (!matchesProjection(dest, want))
                drift.push(`stale ${dir}/${rel}`);
        }
        // A target dir that was never synced yields no orphans rather than an ENOENT — its files are
        // already fully reported by the `missing` pass above.
        for (const found of existsSync(join(root, dir)) ? walk(join(root, dir)) : [])
            if (!expected.has(found))
                drift.push(`orphan ${dir}/${found}`);
    }
    return drift;
}
