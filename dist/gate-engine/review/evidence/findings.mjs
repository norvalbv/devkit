import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadScopedTargets, matchScope } from '../../decisions/check-alignment.mjs';
import { emitGateEvent } from '../../judge/gate-events.mjs';
import { readTranscript } from '../../judge/transcript-store.mjs';
import { issueLocations, LOCATION_RE } from '../contracts/response.mjs';
const FINDINGS_CAP = 12;
const ISSUE_LINE_CHARS = 160;
const LINE_BUCKET = 5;
/** Printed once per run under the first findings block, whichever reviewer or lens it came from. */
export const CLASS_FIX_HINT = '  ↳ A finding naming one input of a check, or one site of a rule the change states, stands for a class: fix + test every instance (commit-gates skill).';
const LEADING_DOT_SLASH_RE = /^\.?\//;
/** Whether a lens is itself the file an issue cites — commit-guard keys its items on paths. */
function lensIsCitedFile(lens, cited) {
    const file = cited.replace(LEADING_DOT_SLASH_RE, '');
    return lens === file || lens.endsWith(`/${file}`);
}
function fingerprint(lens, issue) {
    const loc = issue.match(LOCATION_RE);
    // A lens that IS the cited file separates nothing, so the 5-line bucket would merge two distinct
    // findings in one file: fold those on the exact line only.
    if (loc && lensIsCitedFile(lens, loc[1]))
        return `${lens}||${loc[2]}`;
    if (loc)
        return `${lens}|${loc[1]}|${Math.floor(Number(loc[2]) / LINE_BUCKET)}`;
    return `${lens}|${issue.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}
/** Only lenses the gate still holds against the commit: waived and out-of-charter-dropped lenses
 * both end in a PASS disposition and must not resurface as blocking findings. */
export function isBlockingItem(item) {
    return (item.status !== 'pass' &&
        item.disposition !== 'waived' &&
        item.disposition !== 'dropped_out_of_charter');
}
/** Every blocking issue a reviewer's lenses reported, one line each, deduplicated and bounded. */
export function summarizeFindings(items) {
    const seen = new Set();
    const lines = [];
    let total = 0;
    let deduped = 0;
    for (const item of items ?? []) {
        if (!isBlockingItem(item))
            continue;
        for (const issue of item.issues ?? []) {
            const key = fingerprint(item.lens, issue);
            if (seen.has(key)) {
                deduped += 1;
                continue;
            }
            seen.add(key);
            total += 1;
            if (lines.length < FINDINGS_CAP) {
                const loc = issue.match(LOCATION_RE);
                const text = issue.replace(/\s+/g, ' ').trim().slice(0, ISSUE_LINE_CHARS);
                lines.push(`  • ${item.lens}${loc ? ` · ${loc[1]}:${loc[2]}` : ''} — ${text}`);
            }
        }
    }
    return { lines, total, deduped };
}
/** `items` spills to an `itemsRef` sidecar past the event byte budget (items.mts) — the block must
 * not vanish on exactly the multi-finding failures it exists for, so read the spill back. */
function resolveItems(res, readRef) {
    if (res.items)
        return res.items;
    if (!res.itemsRef)
        return undefined;
    try {
        const raw = readRef(res.itemsRef);
        // SAFETY: the sidecar is written by attachItems as JSON.stringify of the capped ReviewItem[].
        return raw ? JSON.parse(raw) : undefined;
    }
    catch {
        return undefined; // best-effort — the transcript still carries everything
    }
}
/** The block printed under a FAILED reviewer's reason — ONE block per reviewer, merged across a
 * split reviewer's failing lens parts so multi-lens failures never fragment or double-count. */
export function renderFindingsBlockForParts(name, parts, readRef = readTranscript, withHint = true, driftDeps = {}) {
    const items = parts.flatMap((part) => resolveItems(part, readRef) ?? []);
    const { lines, total, deduped } = summarizeFindings(items);
    if (lines.length === 0)
        return '';
    const folded = deduped > 0 ? `, ${deduped} duplicate(s) folded` : '';
    const more = total > lines.length ? `\n  …and ${total - lines.length} more in the transcript` : '';
    const hint = withHint ? `\n${CLASS_FIX_HINT}` : '';
    const drift = scopeDriftHint(name, items, driftDeps);
    return `${name}: ${total} finding(s)${folded}:\n${lines.join('\n')}${more}${hint}${drift ? `\n${drift}` : ''}`;
}
/** Single-outcome convenience over renderFindingsBlockForParts. */
export function renderFindingsBlock(res, readRef = readTranscript) {
    return renderFindingsBlockForParts(res.name, [res], readRef);
}
// A blocking finding citing `TARGET: <slug>` outside that Target's Scope means the edit-time brief
// never showed the ruling. Advisory only: the hint and its event never change a verdict.
const TARGET_CITE_RE = /TARGET:\s*([a-z0-9][a-z0-9-]*)/g;
/** Repo-relative form of a cited path, or null when it cannot be resolved to a real file. */
export function normalizeCitedPath(cited, cwd, exists) {
    const rel = path.isAbsolute(cited) ? path.relative(cwd, cited) : path.normalize(cited);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
        return null;
    const posix = rel.split(path.sep).join('/');
    return exists(path.join(cwd, posix)) ? posix : null;
}
/** Every (slug, path) pair where a blocking issue cites a known Target on an out-of-Scope path. */
export function scopeDriftFindings(items, targets, cwd, exists) {
    const bySlug = new Map(targets.map((t) => [t.slug, t.scopeGlobs]));
    const seen = new Set();
    const drifts = [];
    for (const issue of items.filter(isBlockingItem).flatMap((i) => i.issues ?? [])) {
        const slugs = [...issue.matchAll(TARGET_CITE_RE)].map((m) => m[1]);
        for (const slug of slugs) {
            const globs = bySlug.get(slug);
            if (!globs)
                continue;
            for (const loc of issueLocations(issue)) {
                const rel = normalizeCitedPath(loc.file, cwd, exists);
                if (!rel || matchScope([rel], globs) || seen.has(`${slug}\0${rel}`))
                    continue;
                seen.add(`${slug}\0${rel}`);
                drifts.push({ slug, path: rel, globs });
            }
        }
    }
    return drifts;
}
/** One advisory line per drift, with the rescope command prefilled — rescope REPLACES the Scope. */
export function renderScopeDriftHints(reviewer, drifts) {
    return drifts
        .map(({ slug, path: p, globs }) => {
        const scope = globs.join(',');
        return (`  ↳ Target ${slug} was enforced outside its Scope (${scope}) on ${p}. If it governs this file: ` +
            `guard-decisions rescope ${slug} --scope "${scope},${p}" --reason "enforced on ${p} by ${reviewer}"; ` +
            'if not, the finding applies a ruling outside its Scope.');
    })
        .join('\n');
}
const DEFAULT_DEPS = {
    loadTargets: () => loadScopedTargets(undefined, 'index'),
    exists: existsSync,
    emit: (ev) => {
        emitGateEvent(ev);
    },
};
/** The hint block for a failed reviewer, or '' — fail-open, and Targets load only on a citation. */
export function scopeDriftHint(reviewer, items, deps = {}) {
    if (!items.some((i) => isBlockingItem(i) && i.issues?.some((s) => s.includes('TARGET:'))))
        return '';
    const d = { ...DEFAULT_DEPS, cwd: process.cwd(), ...deps };
    try {
        const drifts = scopeDriftFindings(items, d.loadTargets(), d.cwd, d.exists);
        for (const { slug, path: p } of drifts)
            d.emit({ type: 'decision_scope_drift', reviewer, slug, path: p });
        return renderScopeDriftHints(reviewer, drifts);
    }
    catch {
        return '';
    }
}
