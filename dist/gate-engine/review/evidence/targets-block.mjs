/**
 * The governing-Targets prompt block, shared by every judge that reads recorded decisions
 * (sc-1440). Extracted from completeness.mts so the domain-reviewer cascade (sc-1441) can render
 * the SAME rulings under a different framing — completeness treats a recorded Target as "not a
 * gap" (its judge hunts omissions), while a reviewer treats it as the product's recorded boundary
 * (violating one is IN CHARTER). One renderer, two framings: the bytes a judge reads are the
 * contract, so the shape must never fork.
 */
import { scopedTargets } from "../../decisions/scoped-targets.mjs";
/** completeness.mts's original bytes, verbatim — its judge must keep reading exactly this. */
export const COMPLETENESS_TARGETS_FRAMING = Object.freeze({
    header: '## RELEVANT RECORDED TARGETS (authoritative — a recorded decision is NOT a completeness gap)',
    skipHeader: '## RELEVANT RECORDED TARGETS — SKIP',
    skipNote: 'No governing Target found (index unreachable, or none match). Do not claim ' +
        'decision-alignment you did not check; a recorded decision is not a completeness gap.',
});
/** The domain-reviewer framing (sc-1441): Targets describe what the product's boundary IS. */
export const REVIEWER_TARGETS_FRAMING = Object.freeze({
    header: "## RECORDED TARGETS (authoritative — what this product's security/performance boundary IS)",
    skipHeader: '## RECORDED TARGETS — SKIP',
    skipNote: 'No governing Target found (no decisions store, index unreachable, or none match). Review on ' +
        'the checklist alone; do not claim Target-alignment you did not check.',
});
/**
 * Render the governing-Targets block (the consumer prep-critique shape) or its SKIP note.
 *
 * `capBytes` bounds the RENDERED block: rulings render 8–20KB files' Target sections and the
 * block rides in `-p` argv beside a ~8KB brief with several judges concurrent, so an unbounded
 * block risks argv limits and buries the checklist. Whole rulings are dropped from the end, and
 * every drop is NAMED (`OMITTED: …`) — silent truncation would read as "no other Targets govern".
 * Default Infinity keeps completeness byte-identical to its pre-extraction output.
 */
export function renderTargets(blocks, framing = COMPLETENESS_TARGETS_FRAMING, capBytes = Number.POSITIVE_INFINITY) {
    if (blocks.length === 0)
        return `${framing.skipHeader}\n${framing.skipNote}`;
    const lines = [framing.header, ''];
    const omitted = [];
    let size = framing.header.length + 1;
    for (const b of blocks) {
        const section = `### ${b.slug}${b.scope ? ` · scope: \`${b.scope}\`` : ''} _(${b.via})_\n${b.ruling.trim()}\n`;
        if (size + section.length > capBytes) {
            omitted.push(b.slug);
            continue;
        }
        size += section.length;
        lines.push(`### ${b.slug}${b.scope ? ` · scope: \`${b.scope}\`` : ''} _(${b.via})_`);
        lines.push(b.ruling.trim());
        lines.push('');
    }
    if (omitted.length > 0)
        lines.push(`OMITTED: ${omitted.length} further governing Target(s) over the size cap — ${omitted.join(', ')}. Read them under docs/decisions/ if this diff touches their scope.`, '');
    return lines.join('\n');
}
/**
 * The domain-cascade Targets block, loaded ONCE per gate run (sc-1441): scope-glob matches at
 * pre-commit (no commit message exists yet, so the semantic half is skipped — sc-1442 supplies
 * the query on ship), reviewer framing, 8KB named-omission cap. Fail-open: an unreadable
 * decisions store renders the SKIP note, never throws.
 */
export async function loadReviewerTargetsBlock(cwd, files, query = '') {
    const targets = await scopedTargets(files, query, 6, cwd).catch(() => []);
    return renderTargets(targets, REVIEWER_TARGETS_FRAMING, 8_192);
}
