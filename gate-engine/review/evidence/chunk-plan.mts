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
 * NOT called by production yet: un-chunked runs (today: all runs) emit nothing. Production
 * chunking (sc-1907) is the caller; the tests pin the wire shape until then.
 */
import { emitGateEvent } from '../../judge/gate-events.mts';
import type { ChunkPlanFacts } from '../lens/chunk.mts';

/** One packed slice: membership hash + sizes, index-aligned with the plan. */
export interface ChunkPlanEntry {
  index: number;
  files_sha: string;
  file_count: number;
  bytes: number;
}

export function emitReviewChunkPlan(
  reviewer: string,
  plan: ChunkPlanFacts,
  chunks: ChunkPlanEntry[],
): void {
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
