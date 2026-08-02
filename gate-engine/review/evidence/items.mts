/**
 * The per-lens vector a judge actually reported, snapshotted off the checklist artifact immediately
 * before the gate deletes it — INCLUDING the passes, which is the only thing that distinguishes a
 * reviewer that cleared every lens from one that never looked.
 *
 * Bounded by BYTES, not just by element count, for the same reason as ./scope.mts: gate-events.mts
 * relies on every event fitting one sub-4KB append so concurrent judges cannot tear each other's
 * lines. Element caps alone are not a byte bound — commit-guard's lens is a FILE PATH and each item
 * may carry issue text, so 40 capped entries can still serialize to tens of KB. Past the budget the
 * full vector spills to a sidecar and the event carries a ref; the counts and the status tally ride
 * inline either way, so a reader can always tell a spilled vector from a short one.
 */
import { saveTranscript } from '../../judge/transcript-store.mts';
import type { ChecklistState } from '../reviewers.mts';
import type { ReviewItem, ReviewOutcome } from '../runtime.mts';

// Non-passing items sort FIRST so any truncation can never keep the passes and drop the findings.
const ITEM_CAP = 40;
const ISSUE_CHARS = 200;
const ISSUES_PER_ITEM = 3;
const LENS_CHARS = 200; // a commit-guard lens is a repo path; deep trees make these long
// A waiver rationale is free text a human wrote — unbounded in the overrides file, but an element
// cap alone is not a byte bound (see module docstring), so the copy riding the event is capped here.
// The overrides file keeps the full text; this is only the telemetry copy.
const WAIVER_RATIONALE_CHARS = 500;
// Matches scope.mts's budget. The rest of a review_result (reason, waivers, envelope) shares the same
// 4KB line, so the vector gets half of it rather than all of it.
const ITEMS_INLINE_BUDGET = 2000;

/** What the GATE did with a failing lens — not recoverable from the artifact alone, since an
 * out-of-charter drop and a waived finding both leave a PASS verdict behind. */
export type LensDisposition = 'blocking' | 'waived' | 'dropped_out_of_charter';

/** How many lenses landed in each state — the "did this reviewer's lenses fire" question, answerable
 * even when the vector itself spilled to a sidecar. */
function tally(items: ReviewItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return counts;
}

/**
 * Snapshot the checklist artifact onto the outcome for EVERY status, immediately before the gate
 * deletes it. Leaves `items` absent when there was no artifact — "no artifact" is a different fact
 * from "an artifact with zero failures", and a consumer needs to tell them apart.
 */
export function attachItems(
  res: ReviewOutcome,
  state: ChecklistState | null,
  disposition: Map<string, LensDisposition>,
): void {
  // Domain reviewers key on items[] (one per checklist lens); commit-guard keys on files[] (one per
  // reviewed file, identified by `path`). Same precedence verifyChecklist uses — reading only items[]
  // would label every commit-guard entry '(finding)'.
  const raw = state?.items ?? state?.files;
  if (!Array.isArray(raw) || raw.length === 0) return;
  res.itemArtifact = state?.items ? 'items' : 'files';
  const ordered = [...raw].sort(
    (a, b) => Number(a.status === 'pass') - Number(b.status === 'pass'),
  );
  res.itemCount = ordered.length;
  // lens → rationale for whatever fired the valve this run, so a 'waived' item can carry its own
  // reason inline — the decoy-minting signal a consumer would otherwise need a waivers[] join for.
  const rationaleByLens = new Map((res.waivers ?? []).map((w) => [w.lens, w.rationale]));
  const capped = ordered.slice(0, ITEM_CAP).map((it): ReviewItem => {
    const lens = String(it.name ?? it.path ?? '(finding)').slice(0, LENS_CHARS);
    // checkItem clears issues on a pass, so this only ever carries text for a non-pass.
    const issues = (it.issues ?? [])
      .slice(0, ISSUES_PER_ITEM)
      .map((issue: unknown) => String(issue).slice(0, ISSUE_CHARS));
    const lensDisposition = disposition.get(lens);
    const rationale = rationaleByLens.get(lens);
    return {
      lens,
      status: String(it.status),
      ...(lensDisposition ? { disposition: lensDisposition } : {}),
      ...(issues.length > 0 ? { issues } : {}),
      ...(lensDisposition === 'waived' && rationale
        ? { rationale: rationale.slice(0, WAIVER_RATIONALE_CHARS) }
        : {}),
    };
  });
  // The tally is always inline: it is the cheap answer to "did these lenses fire", and it must
  // survive a spill.
  res.itemTally = tally(capped);
  if (JSON.stringify(capped).length <= ITEMS_INLINE_BUDGET) {
    res.items = capped;
    return;
  }
  // Over budget: the FULL capped vector goes to a sidecar so nothing is lost, and the event carries
  // only the ref. saveTranscript is a no-op off-run, in which case the tally + counts still stand.
  res.itemsRef = saveTranscript(`items-${res.name}`, JSON.stringify(capped, null, 2)) ?? undefined;
}

/**
 * The item fields of a `review_result` event. Lives beside `attachItems` so the wire shape and the
 * spill decision cannot drift apart: `items` and `items_ref` are mutually exclusive, while the count,
 * artifact kind and tally ride along either way — so a spilled vector is never read as a short one.
 * Empty when there was no artifact at all.
 */
export function itemFields(res: ReviewOutcome): Record<string, unknown> {
  if (res.itemCount === undefined) return {};
  return {
    item_count: res.itemCount,
    item_artifact: res.itemArtifact,
    item_tally: res.itemTally,
    ...(res.items ? { items: res.items } : {}),
    ...(res.itemsRef ? { items_ref: res.itemsRef } : {}),
  };
}
