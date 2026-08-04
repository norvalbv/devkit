/**
 * What each reviewer was GIVEN, and which reviewers never ran.
 *
 * The forcing problem (docs/decisions/gate-verdict-attribution.md): a verdict alone is not evidence.
 * A cached PASS emits `cache_hit` and no `review_result`, so ~13% of reviewer outcomes left no row at
 * all and read downstream as "that reviewer was never selected" — indistinguishable from one that
 * genuinely never looked.
 *
 * Best-effort telemetry only: nothing here may influence a verdict. Every payload is bounded, because
 * gate-events.mts relies on sub-4KB single-append writes staying atomic under concurrent judges — an
 * unbounded array is a data-CORRUPTION bug, not a large row.
 */
import { createHash } from 'node:crypto';
import { emitGateEvent } from "../../judge/gate-events.mjs";
import { saveTranscript } from "../../judge/transcript-store.mjs";
import { hasChecklist, REVIEWERS } from "../reviewers.mjs";
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export function emitReviewSkipped(reviewer, reason) {
    emitGateEvent({ type: 'review_skipped', reviewer, reason });
}
/** Every registered reviewer absent from `selected`, so non-selection is a row and not an absence. */
export function emitUnselected(selected, alreadyReported) {
    const ran = new Set(selected.map((s) => s.reviewer.name));
    for (const { name } of REVIEWERS)
        if (!ran.has(name) && !alreadyReported.has(name))
            emitReviewSkipped(name, 'not_selected');
}
// Past this budget the path list spills to a sidecar and the event carries the ref instead.
// `file_count` + `files_sha256` ride inline either way, so a reader can always tell a truly-empty
// scope from a spilled one — the list is never silently dropped.
const SCOPE_FILES_INLINE_BUDGET = 2000;
/**
 * One row per reviewer the gate SELECTED — emitted before the judge runs, so it lands for a cached
 * PASS too. This is the row that answers "did this reviewer see this file, on which bytes, under
 * which prompt version".
 */
export function emitReviewScope(sel, diffText, promptIdentity, cached, 
// sc-1442: bounded per-run context facts — did the prompt carry a commit message, and which
// Targets tier loaded. Without these the epic's "reviewers with intent vs blind" field
// comparison cannot be computed from the sink.
contextFields = null) {
    const files = [...sel.files].sort();
    const inline = JSON.stringify(files);
    const spilled = inline.length > SCOPE_FILES_INLINE_BUDGET
        ? saveTranscript(`scope-${sel.reviewer.name}`, inline)
        : null;
    emitGateEvent({
        type: 'review_scope',
        reviewer: sel.reviewer.name,
        domain: sel.reviewer.domain,
        prompt_identity: promptIdentity,
        diff_sha256: sha256(diffText),
        diff_bytes: Buffer.byteLength(diffText, 'utf8'),
        file_count: files.length,
        files_sha256: sha256(files.join('\n')),
        ...(spilled ? { scope_ref: spilled } : { files }),
        // No static lens vocabulary here on purpose: the per-run `items` vector lists EVERY checklist
        // item including the passes, so "this lens never fired" and "this reviewer has no such lens" are
        // already distinguishable from the run itself. A duplicated ALL_ITEMS copy would only add a
        // second source of truth the gate cannot import and would have to sync-test.
        has_checklist: hasChecklist(sel.reviewer),
        cached,
        ...(contextFields ?? {}),
    });
}
