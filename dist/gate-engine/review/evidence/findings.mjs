import { readTranscript } from '../../judge/transcript-store.mjs';
const FINDINGS_CAP = 12;
const ISSUE_LINE_CHARS = 160;
// A real code location, not any dotted-name:port — the extension allowlist keeps `db.internal:5432`
// out of the file:line bucket so unrelated findings never fold together.
const LOCATION_RE = /([\w@./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|go|rs|java|rb|swift|kt|sh|bash|zsh|sql|css|scss|html|vue|svelte|json|ya?ml|toml|md)):(\d+)\b/i;
const LINE_BUCKET = 5;
/** The correctness lens whose single counterexample stands for a class (mirrors CORRECTNESS_LENSES). */
export const CLASSIFICATION_LENS = 'error-and-edge-classification';
export const CLASS_FIX_HINT = '  ↳ If a finding names one input to a matcher/parser/predicate/validator, derive why it fails and fix + test the whole class (commit-gates skill).';
function fingerprint(lens, issue) {
    const loc = issue.match(LOCATION_RE);
    if (loc)
        return `${lens}|${loc[1]}|${Math.floor(Number(loc[2]) / LINE_BUCKET)}`;
    return `${lens}|${issue.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}
/** Every blocking issue a reviewer's lenses reported, one line each, deduplicated and bounded. */
export function summarizeFindings(items) {
    const seen = new Set();
    const lines = [];
    const blocking = new Set();
    let total = 0;
    let deduped = 0;
    for (const item of items ?? []) {
        // Only lenses the gate still holds against the commit: waived and out-of-charter-dropped
        // lenses both end in a PASS disposition and must not resurface here as blocking findings.
        if (item.status === 'pass' ||
            item.disposition === 'waived' ||
            item.disposition === 'dropped_out_of_charter')
            continue;
        for (const issue of item.issues ?? []) {
            blocking.add(item.lens);
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
    return { lines, total, deduped, blockingLenses: [...blocking].sort() };
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
export function renderFindingsBlockForParts(name, parts, readRef = readTranscript) {
    const items = parts.flatMap((part) => resolveItems(part, readRef) ?? []);
    const { lines, total, deduped, blockingLenses } = summarizeFindings(items);
    if (lines.length === 0)
        return '';
    const folded = deduped > 0 ? `, ${deduped} duplicate(s) folded` : '';
    const more = total > lines.length ? `\n  …and ${total - lines.length} more in the transcript` : '';
    const hint = blockingLenses.includes(CLASSIFICATION_LENS) ? `\n${CLASS_FIX_HINT}` : '';
    return `${name}: ${total} finding(s)${folded}:\n${lines.join('\n')}${more}${hint}`;
}
/** Single-outcome convenience over renderFindingsBlockForParts. */
export function renderFindingsBlock(res, readRef = readTranscript) {
    return renderFindingsBlockForParts(res.name, [res], readRef);
}
