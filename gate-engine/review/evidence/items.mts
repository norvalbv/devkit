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
import { z } from 'zod';
import { saveTranscriptUnique } from '../../judge/transcript-store.mts';
import type {
  ChecklistState,
  ReviewCapture,
  ReviewCaptureItem,
  ReviewItem,
  ReviewOutcome,
} from '../runtime.mts';

// Non-passing items sort FIRST so any truncation can never keep the passes and drop the findings.
const ITEM_CAP = 40;
const ISSUE_CHARS = 200;
// Mirrored by skills/_devkit/checklist-store.mjs (consumer asset, cannot import this module):
// both read GUARD_REVIEW_MAX_ISSUES_PER_LENS with the same default and clamp.
export function issuesPerLensCap(): number {
  const n = Number.parseInt(
    process.env.GUARD_REVIEW_MAX_ISSUES_PER_LENS ??
      process.env.FRINK_REVIEW_MAX_ISSUES_PER_LENS ??
      '',
    10,
  );
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 3;
}
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
const checklistIdentitySchema = z.string().refine((value) => value.trim().length > 0);
const checklistStatusSchema = z.enum(['pending', 'pass', 'fail']);

export const reviewCaptureItemSchema = z.strictObject({
  itemIndex: z.number().int().nonnegative(),
  lens: z.string(),
  status: z.string(),
  disposition: z.enum(['blocking', 'waived', 'dropped_out_of_charter']).optional(),
  issues: z.array(z.string()),
});
export const reviewCaptureSchema = z
  .strictObject({
    version: z.literal(1),
    provenance: z.enum(['exact-checklist', 'capped-fallback', 'missing-invalid']),
    artifact: z.enum(['items', 'files']).optional(),
    skipped: z.string().optional(),
    items: z
      .array(reviewCaptureItemSchema)
      .refine(
        (items) => new Set(items.map((item) => item.itemIndex)).size === items.length,
        'Capture item indices must be unique',
      ),
  })
  .refine(
    (capture) =>
      capture.provenance !== 'exact-checklist' ||
      capture.items.every(
        (item) =>
          checklistIdentitySchema.safeParse(item.lens).success &&
          checklistStatusSchema.safeParse(item.status).success,
      ),
    'Exact capture requires named items with valid checklist statuses',
  ) satisfies z.ZodType<ReviewCapture>;

const checklistCaptureItemSchema = z
  .strictObject({
    name: checklistIdentitySchema.nullish(),
    path: checklistIdentitySchema.nullish(),
    category: z.string().optional(),
    status: checklistStatusSchema,
    issues: z.array(z.string()).optional(),
  })
  .refine((item) => item.name != null || item.path != null);
const checklistSkipSchema = z.string().optional();
const wireItemSchema = z.object({}).loose();

/**
 * Re-derive the item fields for a vector assembled from SEVERAL runs — the lens split produces one
 * outcome per lens group and merges them into a single `review_result`.
 *
 * attachItems caps, tallies and size-checks each part IN ISOLATION. Merging by spreading the worst
 * part and concatenating `items` therefore published one part's `item_count`/`item_tally` beside
 * every part's `items`: a four-way split reported one lens while carrying four, so "which lens
 * fired" — the question the tally exists to answer cheaply — read as though only one ever ran. The
 * concatenation itself also escaped both ITEM_CAP and the inline budget, since those were applied
 * before the parts were joined.
 *
 * The tally SUMS the parts' own tallies rather than recounting the merged vector. Each part's tally
 * is always inline, even when that part's items spilled to a sidecar, so summing stays accurate for
 * a part whose vector this function cannot see.
 *
 * A CACHED part is the other direction: planReviewWork rebuilds it from the verdict cache with its
 * items but no count or tally, so those are derived from the items it does carry. Keying inclusion
 * on itemCount alone would drop a cached lens from the merged vector entirely — and on a re-run
 * where three of four lenses hit cache, that is most of the reviewer's output.
 */
export function mergeItemVectors(res: ReviewOutcome, parts: readonly ReviewOutcome[]): void {
  const withArtifact = parts.filter((p) => p.itemCount !== undefined || p.items?.length);
  if (withArtifact.length === 0) return;
  res.itemArtifact = withArtifact.find((p) => p.itemArtifact)?.itemArtifact;
  res.itemCount = withArtifact.reduce((n, p) => n + (p.itemCount ?? p.items?.length ?? 0), 0);
  res.itemTally = withArtifact.reduce<Record<string, number>>((acc, p) => {
    const part = p.itemTally ?? tally(p.items ?? []);
    for (const [status, n] of Object.entries(part)) acc[status] = (acc[status] ?? 0) + n;
    return acc;
  }, {});
  const ordered = withArtifact
    .flatMap((p) => p.items ?? [])
    .sort((a, b) => Number(a.status === 'pass') - Number(b.status === 'pass'));
  const capped = ordered.slice(0, ITEM_CAP);
  res.items = undefined;
  res.itemsRef = undefined;
  if (JSON.stringify(capped).length <= ITEMS_INLINE_BUDGET) {
    res.items = capped;
    return;
  }
  res.itemsRef =
    saveTranscriptUnique(`items-${res.name}`, JSON.stringify(capped, null, 2)) ?? undefined;
}

/** The lens-part fields a cached PASS must round-trip (sc-1475): a part whose vector SPILLED
 * caches `items: undefined` (dropped by JSON.stringify), so without the aggregates the rebuilt
 * part is indistinguishable from "never ran" and mergeItemVectors drops it from the merged
 * review_result — a real artifact misreported as absent (gate-verdict-attribution). Resumed runs
 * re-seed the lens vector from these fields. */
export function cachedLensFields(res: ReviewOutcome): Record<string, unknown> {
  return { items: res.items, itemCount: res.itemCount, itemTally: res.itemTally };
}

/** How many lenses landed in each state — the "did this reviewer's lenses fire" question, answerable
 * even when the vector itself spilled to a sidecar. */
function tally(items: ReviewItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return counts;
}

/** Snapshot before wire sorting/capping. A malformed item cannot invent an exact claim. */
function captureChecklist(
  state: ChecklistState | null,
  disposition: Map<string, LensDisposition>,
): ReviewCapture {
  const capture: ReviewCapture = { version: 1, provenance: 'missing-invalid', items: [] };
  const raw = state?.items ?? state?.files;
  if (!Array.isArray(raw)) return capture;
  capture.artifact = state?.items != null ? 'items' : 'files';
  const skip = checklistSkipSchema.safeParse(state?.skipped);
  let valid = skip.success;
  if (skip.success && skip.data !== undefined) capture.skipped = skip.data;
  raw.forEach((it, itemIndex) => {
    const item = checklistCaptureItemSchema.safeParse(it);
    if (!item.success) {
      valid = false;
      return;
    }
    const lens = item.data.name ?? item.data.path;
    if (lens == null) {
      valid = false;
      return;
    }
    const itemDisposition = disposition.get(lens);
    const captured: ReviewCaptureItem = {
      itemIndex,
      lens,
      status: item.data.status,
      issues: item.data.issues ?? [],
    };
    if (itemDisposition) captured.disposition = itemDisposition;
    capture.items.push(captured);
  });
  if (valid) capture.provenance = 'exact-checklist';
  return capture;
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
  opts: { full?: boolean } = {},
): void {
  if (opts.full) {
    res.capture = captureChecklist(state, disposition);
    res.itemsFull = res.capture.items;
  }
  // Domain reviewers key on items[] (one per checklist lens); commit-guard keys on files[] (one per
  // reviewed file, identified by `path`). Same precedence verifyChecklist uses — reading only items[]
  // would label every commit-guard entry '(finding)'.
  const raw = state?.items ?? state?.files;
  if (!Array.isArray(raw) || raw.length === 0) return;
  res.itemArtifact = state?.items ? 'items' : 'files';
  const ordered = raw
    .filter((it) => wireItemSchema.safeParse(it).success)
    .sort((a, b) => Number(a.status === 'pass') - Number(b.status === 'pass'));
  res.itemCount = ordered.length;
  // lens → rationale for whatever fired the valve this run, so a 'waived' item can carry its own
  // reason inline — the decoy-minting signal a consumer would otherwise need a waivers[] join for.
  const rationaleByLens = new Map((res.waivers ?? []).map((w) => [w.lens, w.rationale]));
  const capped = ordered.slice(0, ITEM_CAP).map((it): ReviewItem => {
    const lens = String(it.name ?? it.path ?? '(finding)').slice(0, LENS_CHARS);
    // checkItem clears issues on a pass, so this only ever carries text for a non-pass.
    const issues = (Array.isArray(it.issues) ? it.issues : [])
      .slice(0, issuesPerLensCap())
      .map((issue) => String(issue).slice(0, ISSUE_CHARS));
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
  // only the ref. saveTranscriptUnique is a no-op off-run, in which case the tally + counts still stand.
  res.itemsRef =
    saveTranscriptUnique(`items-${res.name}`, JSON.stringify(capped, null, 2)) ?? undefined;
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
