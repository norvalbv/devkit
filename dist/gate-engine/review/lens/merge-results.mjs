/**
 * The merged review_result row for a lens-split reviewer, split out of lens/split.mts (which plans
 * and holds the parts) so the per-lens planner stays under the size ceiling.
 */
import { emitGateEvent } from '../../judge/gate-events.mjs';
import { composeTranscript, saveTranscript } from '../../judge/transcript-store.mjs';
import { reportMcpDegraded } from '../evidence/base-context.mjs';
import { itemFields, mergeItemVectors } from '../evidence/items.mjs';
import { coverageFields } from '../evidence/packet/coverage.mjs';
import { lensGroupId } from './groups.mjs';
import { mergeLensOutcomes } from './split.mjs';
/** The ONE review_result row per split reviewer (gate-verdict-attribution): `secs` SUMS the groups'
 * judge time, and the item vectors concatenate so per-lens rates stay joinable across the flag. */
export function emitMergedLensResults(splitParts, firstModel) {
    for (const [name, parts] of splitParts) {
        // SAFETY: each held part is a settled ReviewOutcome or a cached PASS re-seeded by planReviewWork,
        // and the merge spreads one of them, so these optional fields hold their ReviewOutcome types.
        const merged = mergeLensOutcomes(parts.map((p) => p.res), name);
        const transcript = parts
            .filter((p) => p.res.transcript)
            .map((p) => p.res.transcript)
            .join('\n\n');
        const transcriptRef = transcript
            ? saveTranscript(`review-${name}`, composeTranscript(parts[0].task.diffText, transcript))
            : null;
        // Item fields rebuilt ACROSS the parts, or a four-way split reads as a single-lens reviewer.
        // SAFETY: the same parts as above; mergeItemVectors touches only the optional item fields.
        mergeItemVectors(merged, parts.map((p) => p.res));
        // ANY part, not `worst` (an all-PASS merge spreads parts[0]); a live cause wins over a replayed one.
        const degradedParts = parts.filter((p) => p.res.status === 'pass' && p.res.mcpDegraded);
        const mcp = (degradedParts.find((p) => !p.res.mcpDegraded?.cached) ?? degradedParts[0])?.res;
        const mcpCause = merged.status === 'pass' ? mcp?.mcpDegraded?.cause : undefined;
        // Per-group cost and verdict: `secs` sums and `escalated`/`model` collapse to the worst part, so
        // without this vector a slow or repeatedly-escalating lens is invisible.
        const lensParts = parts.map((p) => {
            const row = {
                lens: lensGroupId(p.task.sel.reviewer.lens ?? []),
                status: p.res.status,
                secs: p.secs,
                // sc-1999 wire format: WHICH chunk slice this part judged, by index AND membership hash
                // (an index alone is unstable); null on every un-chunked run, which is all of them today.
                chunk_index: p.task.chunk?.index ?? null,
                chunk_files_sha: p.task.chunk?.filesSha ?? null,
                ...coverageFields([p.task]),
            };
            if (p.res.model)
                row.model = p.res.model;
            if (p.retried)
                row.retried = true;
            return row;
        });
        const event = {
            type: 'review_result',
            reviewer: name,
            status: merged.status,
            escalated: Boolean(merged.escalated),
            model: merged.model ?? firstModel,
            reason: merged.reason,
            inconclusive_cause: merged.inconclusiveCause,
            mcp_degraded_cause: mcpCause,
            secs: parts.reduce((sum, p) => sum + p.secs, 0),
            lens_parts: lensParts,
        };
        // The merged row itself is flagged when ANY part needed the post-wave recovery (sc-1476).
        if (parts.some((p) => p.retried)) {
            event.retried = true;
            event.retry_phase = 'deferred';
        }
        if (merged.waivers?.length)
            event.waivers = merged.waivers;
        // SAFETY: `merged` carries the ReviewOutcome item fields mergeItemVectors just rebuilt.
        const items = itemFields(merged);
        if (transcriptRef)
            event.transcript_ref = transcriptRef;
        emitGateEvent({ ...event, ...items, ...coverageFields(parts.map((p) => p.task)) });
        // Once per reviewer, not per group: the digest renders one unverified row per event.
        if (mcpCause)
            reportMcpDegraded(name, mcpCause, mcp?.mcpDegraded?.cached === true);
    }
}
