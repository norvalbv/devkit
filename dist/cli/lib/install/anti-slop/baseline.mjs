/** Deterministic, explicit, shrink-only anti-slop baseline model. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mjs';
import { ANTI_SLOP_BASELINE_REL, ANTI_SLOP_UPSTREAM } from './constants.mjs';
function expectedFingerprint(entry) {
    return createHash('sha256')
        .update(JSON.stringify([entry.ruleId, entry.file, entry.diagnostic, entry.context]))
        .digest('hex');
}
function validateEntry(value) {
    if (!value || typeof value !== 'object')
        return false;
    const entry = value;
    if (typeof entry.fingerprint !== 'string' ||
        typeof entry.ruleId !== 'string' ||
        typeof entry.file !== 'string' ||
        typeof entry.diagnostic !== 'string' ||
        typeof entry.context !== 'string' ||
        !Number.isSafeInteger(entry.count) ||
        (entry.count ?? 0) < 1) {
        return false;
    }
    return (expectedFingerprint({
        ruleId: entry.ruleId,
        file: entry.file,
        diagnostic: entry.diagnostic,
        context: entry.context,
    }) === entry.fingerprint);
}
export function baselineFromGroups(groups) {
    return {
        schemaVersion: 1,
        upstreamCommit: ANTI_SLOP_UPSTREAM,
        entries: [...groups]
            .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
            .map(({ severity: _severity, line: _line, column: _column, ...entry }) => entry),
    };
}
export function parseBaseline(json, source = ANTI_SLOP_BASELINE_REL) {
    let value;
    try {
        value = JSON.parse(json);
    }
    catch (error) {
        throw new Error(`invalid ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const baseline = value;
    if (baseline.schemaVersion !== 1 ||
        baseline.upstreamCommit !== ANTI_SLOP_UPSTREAM ||
        !Array.isArray(baseline.entries) ||
        !baseline.entries.every(validateEntry)) {
        throw new Error(`invalid or stale ${source}; inspect it, then explicitly recreate it`);
    }
    const sorted = [...baseline.entries].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    if (new Set(sorted.map((entry) => entry.fingerprint)).size !== sorted.length) {
        throw new Error(`invalid ${source}: duplicate fingerprints`);
    }
    return { schemaVersion: 1, upstreamCommit: baseline.upstreamCommit, entries: sorted };
}
export function readBaseline(cwd) {
    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    return existsSync(path) ? parseBaseline(readFileSync(path, 'utf8')) : null;
}
export function writeBaseline(cwd, baseline) {
    writeFileAtomic(join(cwd, ANTI_SLOP_BASELINE_REL), `${JSON.stringify(baseline, null, 2)}\n`);
}
export function compareBaseline(baseline, groups) {
    const allowed = new Map(baseline.entries.map((entry) => [entry.fingerprint, entry.count]));
    const current = new Map(groups.map((group) => [group.fingerprint, group.count]));
    return {
        newGroups: groups.flatMap((group) => {
            const additionalCount = Math.max(0, group.count - (allowed.get(group.fingerprint) ?? 0));
            return additionalCount > 0 ? [{ ...group, additionalCount }] : [];
        }),
        currentCount: groups.reduce((sum, group) => sum + group.count, 0),
        debtCount: baseline.entries.reduce((sum, entry) => sum + entry.count, 0),
        resolvedCount: baseline.entries.reduce((sum, entry) => sum + Math.max(0, entry.count - (current.get(entry.fingerprint) ?? 0)), 0),
    };
}
/**
 * Move adopted debt across Git-detected file renames without allowing its rule/message/context or
 * count to change. Multiple entries that converge on one fingerprint are deliberately combined.
 */
export function migrateBaselineRenames(baseline, renames) {
    const migrated = new Map();
    for (const entry of baseline.entries) {
        const file = renames.get(entry.file) ?? entry.file;
        const stable = {
            ruleId: entry.ruleId,
            file,
            diagnostic: entry.diagnostic,
            context: entry.context,
        };
        const fingerprint = expectedFingerprint(stable);
        const current = migrated.get(fingerprint);
        if (current)
            current.count += entry.count;
        else
            migrated.set(fingerprint, { fingerprint, ...stable, count: entry.count });
    }
    return {
        ...baseline,
        entries: [...migrated.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    };
}
/** Return only candidate debt that exceeds the base commit's count envelope. */
export function baselineIncreases(base, candidate, renames = new Map()) {
    const allowed = new Map(migrateBaselineRenames(base, renames).entries.map((entry) => [entry.fingerprint, entry.count]));
    return candidate.entries.flatMap((entry) => {
        const additionalCount = Math.max(0, entry.count - (allowed.get(entry.fingerprint) ?? 0));
        return additionalCount > 0 ? [{ ...entry, additionalCount }] : [];
    });
}
/** Return only still-present baseline debt; never add an unbaselined current finding. */
export function pruneBaseline(baseline, groups) {
    const current = new Map(groups.map((group) => [group.fingerprint, group.count]));
    return {
        ...baseline,
        entries: baseline.entries.flatMap((entry) => {
            const count = Math.min(entry.count, current.get(entry.fingerprint) ?? 0);
            return count > 0 ? [{ ...entry, count }] : [];
        }),
    };
}
