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
import { listAgents } from '../../../commands/sync/sync-agents.mjs';
import { walk } from '../../../commands/sync/sync-skills.mjs';
import { skillNamesForSelection } from '../../components.mjs';
import { agentAssetDir, projectAgentAsset, projectedAssetRel } from './agent-assets.mjs';
/** The working tree, read the way the sync writers see it. */
export function fsReader(root) {
    return {
        list: (dir) => (existsSync(join(root, dir)) ? walk(join(root, dir)) : []),
        // Guarded: `walk` reports a symlink-to-directory as a leaf (EISDIR); unreadable = not identical.
        read: (rel) => {
            try {
                return readFileSync(join(root, rel));
            }
            catch {
                return null;
            }
        },
    };
}
/** The logical files the writer would ship for `kind`, after the shared selection filter. */
export function projectedLogicals({ root, kind, srcDir, selection = {}, reader, }) {
    if (kind === 'agents')
        return reader
            ? reader.list(srcDir).filter((rel) => !rel.includes('/') && rel.endsWith('.md'))
            : listAgents(join(root, srcDir));
    const all = (reader ?? fsReader(root)).list(srcDir);
    const names = new Set(skillNamesForSelection([...new Set(all.map((rel) => rel.split('/')[0]))], selection));
    return all.filter((rel) => names.has(rel.split('/')[0]));
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
    const reader = input.reader ?? fsReader(root);
    const drift = [];
    // A source the snapshot lists but cannot read (a symlink staged in place of a file) is reported
    // once and skipped, rather than crashing the advisory or repeating per target.
    const logicals = projectedLogicals(input);
    const sources = new Map();
    for (const logical of logicals) {
        const bytes = reader.read(`${srcDir}/${logical}`);
        if (bytes)
            sources.set(logical, bytes);
        else
            drift.push(`unreadable ${srcDir}/${logical}`);
    }
    for (const target of targets) {
        const dir = agentAssetDir(target, kind);
        const expected = new Map(logicals.map((rel) => [projectedAssetRel(target, kind, rel), rel]));
        const present = new Set(reader.list(dir));
        for (const [rel, logical] of expected) {
            const source = sources.get(logical);
            if (!source)
                continue;
            const want = projectAgentAsset(target, kind, logical, source);
            if (!present.has(rel))
                drift.push(`missing ${dir}/${rel}`);
            else if (!reader.read(`${dir}/${rel}`)?.equals(want))
                drift.push(`stale ${dir}/${rel}`);
        }
        // A target dir that was never synced lists nothing, so it yields no orphans — its files are
        // already fully reported by the `missing` pass above.
        for (const found of present)
            if (!expected.has(found))
                drift.push(`orphan ${dir}/${found}`);
    }
    return drift;
}
