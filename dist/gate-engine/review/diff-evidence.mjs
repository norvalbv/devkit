import { splitDiffByFile } from '../judge/diff-focus.mjs';
export function capNamedSegments(segments, { totalCap, segmentCap, hint }) {
    const kept = [];
    const omitted = [];
    let used = 0;
    let truncated = 0;
    let shownBytes = 0;
    for (const seg of segments) {
        const room = totalCap - used;
        if (room <= 0) {
            omitted.push(`OMITTED: ${seg.label} (${seg.content.length} chars over the evidence budget — ${hint(seg.label)})`);
            continue;
        }
        const cap = Math.min(segmentCap, room);
        if (seg.content.length <= cap) {
            kept.push(seg.content);
            used += seg.content.length;
            shownBytes += Buffer.byteLength(seg.content, 'utf8');
        }
        else {
            truncated += 1;
            shownBytes += Buffer.byteLength(seg.content.slice(0, cap), 'utf8');
            kept.push(`${seg.content.slice(0, cap)}\n[TRUNCATED: ${seg.label} — ${cap} of ${seg.content.length} chars shown; ${hint(seg.label)} for the rest]\n`);
            used += cap;
        }
    }
    return { kept, omitted, truncated, shownBytes };
}
/** `capNamedSegments` + the OMITTED-list cutoff + the trailing INCOMPLETE-evidence warning —
 * everything after the caller's own leading context (e.g. a `--stat` map) rides first. */
export function renderCappedSegments(segments, opts) {
    const { kept, omitted, truncated } = capNamedSegments(segments, opts);
    const omittedBlock = omitted.length > opts.omittedListMax
        ? `${omitted.slice(0, opts.omittedListMax).join('\n')}\n…and ${omitted.length - opts.omittedListMax} more OMITTED segment(s) — ${opts.omittedFooterHint}`
        : omitted.join('\n');
    const warning = omitted.length || truncated
        ? `\n[WARNING: ${omitted.length} segment(s) OMITTED and ${truncated} TRUNCATED — the stdin evidence is INCOMPLETE. Investigate EVERY OMITTED/TRUNCATED path before any PASS verdict.]`
        : '';
    return `${kept.join('')}${omitted.length ? `\n${omittedBlock}` : ''}${warning}`;
}
// ─── The diff-specific instance (moved from completeness.mts, sc-1060) ────────────
const EVIDENCE_TOTAL_CAP = 60000; // same total budget as the old blunt cap — no cost claim
const SEGMENT_CAP = 8000; // no single file may eat the budget (greedy in diff order)
const OMITTED_LIST_MAX = 40; // OMITTED pointer lines; the --stat header is the full inventory
const SEGMENT_PATH_RE = /^diff --git (?:a\/)?(\S+)/;
function segmentPath(seg) {
    return seg.match(SEGMENT_PATH_RE)?.[1] ?? '(unknown path)';
}
const diffHint = (label) => `run \`git diff --cached -- ${label}\``;
export function measureDiffEvidenceCap(fullDiff) {
    const diff = String(fullDiff);
    if (diff.length <= EVIDENCE_TOTAL_CAP)
        return {
            evidence_bytes_shown: Buffer.byteLength(diff, 'utf8'),
            omitted_files: 0,
            truncated_files: 0,
        };
    const segments = splitDiffByFile(diff).map((content) => ({
        label: segmentPath(content),
        content,
    }));
    const { omitted, truncated, shownBytes } = capNamedSegments(segments, {
        totalCap: EVIDENCE_TOTAL_CAP,
        segmentCap: SEGMENT_CAP,
        omittedListMax: OMITTED_LIST_MAX,
        hint: diffHint,
        omittedFooterHint: '',
    });
    return {
        evidence_bytes_shown: shownBytes,
        omitted_files: omitted.length,
        truncated_files: truncated,
    };
}
/** Per-file capped diff evidence + explicit omission accounting. `inventory` (the full `--stat`
 * map, or a churn-free `--name-only` list for a reviewer with no Bash to verify churn with — see
 * cascade/reviewer.mts) always rides first, and either form names every file. */
export function buildCappedDiffEvidence(fullDiff, inventory) {
    const diff = String(fullDiff);
    if (diff.length <= EVIDENCE_TOTAL_CAP)
        return `${inventory}\n${diff}`;
    const segments = splitDiffByFile(diff).map((content) => ({
        label: segmentPath(content),
        content,
    }));
    const body = renderCappedSegments(segments, {
        totalCap: EVIDENCE_TOTAL_CAP,
        segmentCap: SEGMENT_CAP,
        omittedListMax: OMITTED_LIST_MAX,
        hint: diffHint,
        omittedFooterHint: 'the staged-file inventory above lists every file',
    });
    return `${inventory}\n${body}`;
}
