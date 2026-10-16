// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/** Admission rule for corpus rows absent from the base: only source-anchored rows may join. Proves
 * the anchoring fields are present, not that the cited source is true. */

import { z } from 'zod';

const ROUTE =
  'Target benchmarks-grow-from-telemetry admits only mined/known-answer rows and adapted siblings with caseId + source; grow the corpus via docs/benchmarks/corpus-growth.md (mine → propose → finalize), and prove a prompt edit with the reviewers README A/B on existing rows, never by adding rows';

const Text = z.string().trim().min(1);
const nonEmpty = (v) => Text.safeParse(v).success;

/** A source anchor: a numeric sourcePr, or a source object naming a url or a receipt. */
const hasSourceAnchor = (row) =>
  z.number().safeParse(row.sourcePr).success ||
  nonEmpty(row.source?.url) ||
  nonEmpty(row.source?.receipt);

function rowGaps(row, byId) {
  const gaps = [];
  if (!row.provenance || row.provenance === 'authored')
    gaps.push(`provenance ${row.provenance ?? 'missing'}`);
  if (!hasSourceAnchor(row)) gaps.push('no source.url, source.receipt or numeric sourcePr');
  if (row.provenance === 'adapted' && !nonEmpty(row.caseId)) gaps.push('adapted without caseId');
  // An unresolved variantOf is not judged: finalize --check sees one proposal, not its batch.
  const target = row.variantOf == null ? null : byId.get(row.variantOf);
  if (row.variantOf != null && (!nonEmpty(row.caseId) || (target && target.caseId !== row.caseId)))
    gaps.push(`variantOf ${row.variantOf} without a caseId shared with it`);
  return gaps;
}

/** One message per row whose id is not in baseIds and that fails the admission rule. */
export function admissionProblems(rows, baseIds, reviewerName) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((row) => !baseIds.has(row.id))
    .map((row) => [row, rowGaps(row, byId)])
    .filter(([, gaps]) => gaps.length)
    .map(
      ([row, gaps]) =>
        `${reviewerName}/${row.id}: unanchored corpus row (${gaps.join('; ')}) — ${ROUTE}`,
    );
}
