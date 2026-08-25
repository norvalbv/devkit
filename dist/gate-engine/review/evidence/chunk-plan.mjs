/**
 * The `review_chunk_plan` event (sc-1999): ONE row per CHUNKED reviewer selection describing how
 * the diff was packed — its own event type, per the gate-telemetry-self-describing ruling (a
 * distinct outcome never rides as synthetic fields on an existing event), and the rollout's arm
 * marker: `armed` is explicit so "chunking armed but the diff fit one chunk", "not armed", and
 * "old emitter" stay distinguishable — `chunk_count IS NOT NULL` inference cannot separate them,
 * and the sc-1996 before/after readout needs the distinction.
 *
 * Per-chunk facts ride here (not on review_scope) because a chunk is its own scope: the plan
 * PARTITIONS the reviewer's files, so file lists, counts, and byte sizes all diverge per chunk —
 * one (ship, reviewer) scope row cannot carry them without becoming internally inconsistent. The
 * warehouse ingests these into chunk-grain child tables and leaves its per-reviewer tables alone.
 *
 * Called by planReviewWork's chunked branch (sc-1907) whenever GUARD_CORRECTNESS_CHUNK arms and
 * a diff crosses the trigger; un-chunked runs emit nothing.
 */
import { emitGateEvent } from '../../judge/gate-events.mjs';
export function emitReviewChunkPlan(reviewer, plan, chunks) {
    emitGateEvent({
        type: 'review_chunk_plan',
        reviewer,
        armed: 1,
        chunk_count: plan.count,
        chunk_cap_bytes: plan.capBytes,
        chunk_plan_hash: plan.planHash,
        chunks,
    });
}
