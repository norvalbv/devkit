/** Relocated anti-slop debt: findings a partial move carried between files Git sees only as edits. */
import { ANTI_SLOP_BASELINE_REL } from './constants.mjs';
export const relocationKey = (entry) => JSON.stringify([entry.ruleId, entry.diagnostic, entry.context]);
const countsOf = (entries) => new Map(entries.map((entry) => [entry.fingerprint, entry.count]));
const copyPool = (vacated) => new Map([...vacated].map(([key, credits]) => [key, credits.map((credit) => ({ ...credit }))]));
/** Take up to `wanted` credit for one key from sources other than `file`, in path order. */
function consume(pool, key, file, wanted) {
    const credits = (pool.get(key) ?? []).filter((credit) => credit.source !== file && credit.count > 0);
    const sources = credits.map((credit) => credit.source);
    const from = [];
    let taken = 0;
    for (const credit of credits) {
        if (taken >= wanted)
            break;
        const take = Math.min(credit.count, wanted - taken);
        credit.count -= take;
        taken += take;
        from.push({ ...credit, count: take });
    }
    return { taken, from, sources };
}
/** Base paths worth linting: changed sources whose bound debt shares a key with the findings. */
export function relocationBasePaths(bound, sources, keys) {
    const paths = new Set();
    for (const entry of bound.entries) {
        const source = sources.get(entry.file);
        if (source && keys.has(relocationKey(entry)))
            paths.add(source.basePath);
    }
    return [...paths].sort((a, b) => a.localeCompare(b));
}
/**
 * Debt a changed file provably gave up. Bounded by BOTH its base baseline count and a lint of its
 * base bytes, so unpruned stale credit is never spendable, minus what the candidate still carries.
 */
export function vacatedDebt(bound, inherited, candidateGroups, sources, inLintScope, excludedRuleIds = new Set()) {
    const linted = countsOf(inherited.entries);
    const current = countsOf(candidateGroups);
    const vacated = new Map();
    const ordered = [...bound.entries].sort((a, b) => a.file.localeCompare(b.file) || a.fingerprint.localeCompare(b.fingerprint));
    for (const entry of ordered) {
        const source = sources.get(entry.file);
        if (!source || excludedRuleIds.has(entry.ruleId))
            continue;
        // An unlinted surviving file proves nothing left it; never assume it did.
        if (!source.deleted && !inLintScope(entry.file))
            continue;
        const evidenced = Math.min(entry.count, linted.get(entry.fingerprint) ?? 0);
        const remaining = source.deleted ? 0 : (current.get(entry.fingerprint) ?? 0);
        if (evidenced <= remaining)
            continue;
        const key = relocationKey(entry);
        const credit = {
            source: entry.file,
            fingerprint: entry.fingerprint,
            count: evidenced - remaining,
        };
        vacated.set(key, [...(vacated.get(key) ?? []), credit]);
    }
    return vacated;
}
/** Split new findings into genuinely new ones and ones paired 1:1 with vacated debt elsewhere. */
export function classifyRelocations(newGroups, vacated) {
    const pool = copyPool(vacated);
    const relocated = [];
    const residual = [];
    for (const group of newGroups) {
        const key = relocationKey(group);
        const { taken, from, sources } = consume(pool, key, group.file, group.additionalCount);
        if (taken > 0)
            relocated.push({ ...group, relocatedCount: taken, from, sources });
        if (group.additionalCount > taken) {
            residual.push({ ...group, additionalCount: group.additionalCount - taken });
        }
    }
    return { newGroups: residual, relocated };
}
/**
 * Accept baseline growth only where it re-anchors vacated debt: the source entry must actually
 * shrink in the candidate baseline, and the destination may not exceed what its lint observed.
 */
export function creditRelocatedGrowth(increases, migratedBase, candidate, candidateGroups, vacated, inLintScope) {
    const base = countsOf(migratedBase.entries);
    const persisted = countsOf(candidate.entries);
    const linted = countsOf(candidateGroups);
    const pool = copyPool(vacated);
    for (const credits of pool.values()) {
        for (const credit of credits) {
            const released = (base.get(credit.fingerprint) ?? 0) - (persisted.get(credit.fingerprint) ?? 0);
            credit.count = Math.min(credit.count, Math.max(0, released));
        }
    }
    const accepted = [];
    const blocked = [];
    for (const increase of increases) {
        const room = inLintScope(increase.file)
            ? Math.max(0, (linted.get(increase.fingerprint) ?? 0) - (base.get(increase.fingerprint) ?? 0))
            : 0;
        const wanted = Math.min(increase.additionalCount, room);
        const { taken, sources } = consume(pool, relocationKey(increase), increase.file, wanted);
        if (taken > 0)
            accepted.push({ ...increase, additionalCount: taken, sources });
        if (increase.additionalCount > taken) {
            blocked.push({ ...increase, additionalCount: increase.additionalCount - taken });
        }
    }
    return { accepted, blocked };
}
/** Move exactly the paired counts: shrink each source (never below its bound minus what left). */
export function reanchorBaseline(baseline, bound, relocated) {
    const entries = new Map(baseline.entries.map((entry) => [entry.fingerprint, { ...entry }]));
    const bounds = countsOf(bound.entries);
    const released = new Map();
    for (const credit of relocated.flatMap((group) => group.from)) {
        released.set(credit.fingerprint, (released.get(credit.fingerprint) ?? 0) + credit.count);
    }
    for (const [fingerprint, count] of released) {
        const entry = entries.get(fingerprint);
        if (!entry)
            continue;
        const next = Math.min(entry.count, (bounds.get(fingerprint) ?? entry.count) - count);
        if (next > 0)
            entry.count = next;
        else
            entries.delete(fingerprint);
    }
    for (const group of relocated) {
        const { fingerprint, ruleId, file, diagnostic, context } = group;
        const count = (entries.get(fingerprint)?.count ?? 0) + group.relocatedCount;
        entries.set(fingerprint, { fingerprint, ruleId, file, diagnostic, context, count });
    }
    return {
        ...baseline,
        entries: [...entries.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    };
}
export function formatSources(paths) {
    const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
    if (unique.length <= 3)
        return unique.join(', ');
    return `${unique.slice(0, 3).join(', ')} +${unique.length - 3} more`;
}
export const relocationRemedy = (baseRef) => baseRef
    ? `devkit anti-slop adopt-relocations --base ${baseRef}`
    : 'devkit anti-slop adopt-relocations';
export function printRelocatedAntiSlopFindings(groups) {
    for (const group of groups) {
        const tag = group.severity === 'error' ? 'RELOCATED' : 'RELOCATED-WARN';
        console.log(`${tag} ${group.ruleId} ${group.file}:${group.line}:${group.column} <- ${formatSources(group.sources)} (+${group.relocatedCount})`);
        console.log(`      ${group.diagnostic}`);
    }
}
/** The FAIL summary once any relocated error exists: new and relocated debt counted apart. */
export function reportRelocatedFailure(newErrorCount, relocated, baseRef) {
    const errors = relocated.filter((group) => group.severity === 'error');
    const moved = errors.reduce((sum, group) => sum + group.relocatedCount, 0);
    console.error(`anti-slop: FAIL — ${newErrorCount} new, ${moved} relocated from ${formatSources(errors.flatMap((group) => group.sources))}; baseline unchanged`);
    console.error(`anti-slop: re-anchor relocated debt with \`${relocationRemedy(baseRef)}\`, then stage ${ANTI_SLOP_BASELINE_REL}`);
}
export function relocatedWarningNote(relocated, baseRef) {
    const moved = relocated.reduce((sum, group) => sum + group.relocatedCount, 0);
    return moved > 0
        ? `, ${moved} relocated warning finding(s) — re-anchor with \`${relocationRemedy(baseRef)}\``
        : '';
}
