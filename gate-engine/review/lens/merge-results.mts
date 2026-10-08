/**
 * The merged review_result row for a lens-split reviewer, split out of lens/split.mts (which plans
 * and holds the parts) so the per-lens planner stays under the size ceiling.
 */

import { emitGateEvent } from '../../judge/gate-events.mts';
import { composeTranscript, saveTranscript } from '../../judge/transcript-store.mts';
import { parseAdvisories } from '../contracts/response.mts';
import { reportAdvisories, reportMcpDegraded } from '../evidence/base-context.mts';
import { itemFields, mergeItemVectors } from '../evidence/items.mts';
import { type CoverageFields, coverageFields } from '../evidence/packet/coverage.mts';
import { lensGroupId } from './groups.mts';
import { type LensPart, mergeLensOutcomes } from './split.mts';

type MergedLens = LensPart['res'] & {
  reason?: string;
  escalated?: boolean;
  waivers?: unknown[];
  inconclusiveCause?: string;
};

/** One split group's cost and verdict on the merged row. */
type LensPartRow = {
  lens: string;
  status: string;
  secs: number;
  chunk_index: number | null;
  chunk_files_sha: string | null;
  model?: string;
  retried?: true;
} & CoverageFields;

/** The ONE merged review_result row; the item fields join from itemFields(). */
type MergedLensRow = {
  type: 'review_result';
  reviewer: string;
  status: string;
  escalated: boolean;
  model: string;
  reason?: string;
  inconclusive_cause?: string;
  mcp_degraded_cause?: string;
  secs: number;
  lens_parts: LensPartRow[];
  retried?: true;
  retry_phase?: 'deferred';
  waivers?: unknown[];
  transcript_ref?: string;
};

/** The ONE review_result row per split reviewer (gate-verdict-attribution): `secs` SUMS the groups'
 * judge time, and the item vectors concatenate so per-lens rates stay joinable across the flag. */
export function emitMergedLensResults(
  splitParts: Map<string, LensPart[]>,
  firstModel: string,
): void {
  for (const [name, parts] of splitParts) {
    // SAFETY: each held part is a settled ReviewOutcome or a cached PASS re-seeded by planReviewWork,
    // and the merge spreads one of them, so these optional fields hold their ReviewOutcome types.
    const merged = mergeLensOutcomes(
      parts.map((p) => p.res),
      name,
    ) as MergedLens;
    const transcript = parts
      .filter((p) => p.res.transcript)
      .map((p) => p.res.transcript)
      .join('\n\n');
    const transcriptRef = transcript
      ? saveTranscript(`review-${name}`, composeTranscript(parts[0].task.diffText, transcript))
      : null;
    // Item fields rebuilt ACROSS the parts, or a four-way split reads as a single-lens reviewer.
    // SAFETY: the same parts as above; mergeItemVectors touches only the optional item fields.
    mergeItemVectors(merged as never, parts.map((p) => p.res) as never);
    // ANY part, not `worst` (an all-PASS merge spreads parts[0]); a live cause wins over a replayed one.
    const degradedParts = parts.filter((p) => p.res.status === 'pass' && p.res.mcpDegraded);
    const mcp = (degradedParts.find((p) => !p.res.mcpDegraded?.cached) ?? degradedParts[0])?.res;
    const mcpCause = merged.status === 'pass' ? mcp?.mcpDegraded?.cause : undefined;
    // Per-group cost and verdict: `secs` sums and `escalated`/`model` collapse to the worst part, so
    // without this vector a slow or repeatedly-escalating lens is invisible.
    const lensParts = parts.map((p) => {
      const row: LensPartRow = {
        lens: lensGroupId(p.task.sel.reviewer.lens ?? []),
        status: p.res.status,
        secs: p.secs,
        // sc-1999 wire format: WHICH chunk slice this part judged, by index AND membership hash
        // (an index alone is unstable); null on every un-chunked run, which is all of them today.
        chunk_index: p.task.chunk?.index ?? null,
        chunk_files_sha: p.task.chunk?.filesSha ?? null,
        ...coverageFields([p.task]),
      };
      if (p.res.model) row.model = p.res.model;
      if (p.retried) row.retried = true;
      return row;
    });
    const event: MergedLensRow = {
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
    if (merged.waivers?.length) event.waivers = merged.waivers;
    // SAFETY: `merged` carries the ReviewOutcome item fields mergeItemVectors just rebuilt.
    const items = itemFields(merged as never);
    if (transcriptRef) event.transcript_ref = transcriptRef;
    emitGateEvent({ ...event, ...items, ...coverageFields(parts.map((p) => p.task)) });
    // Once per reviewer, not per group: the digest renders one unverified row per event.
    if (mcpCause) reportMcpDegraded(name, mcpCause, mcp?.mcpDegraded?.cached === true);
    // Live parts only: a cached part's advisories replay with its own cache line.
    if (merged.status === 'pass')
      reportAdvisories(name, parseAdvisories(transcript), transcriptRef);
  }
}
