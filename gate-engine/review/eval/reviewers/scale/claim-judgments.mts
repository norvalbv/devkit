/** Exact occurrence-bound adjudications. Historical stub/location judgments are incompatible. */
import { z } from 'zod';
import { sha256, type ClaimInventory, type ClaimOccurrence } from './claim-inventory.mts';

const evidenceSchema = z.strictObject({
  reference: z.string().trim().min(1),
  observation: z.string().trim().min(1),
});
const adjudicatorSchema = z.strictObject({
  id: z.string().trim().min(1),
  tier: z.enum(['HUMAN', 'AI', 'HUMAN_WITH_AI']),
  model: z.string().trim().min(1).optional(),
});
const judgmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  occurrenceId: z.string(),
  textSha256: z.string(),
  truth: z.enum(['REAL', 'NOT', 'UNSURE']),
  changeScope: z.enum(['INTRODUCED', 'PRE_EXISTING', 'NOT_APPLICABLE', 'UNSURE']),
  charterScope: z.enum(['IN_CHARTER', 'OUT_OF_CHARTER', 'NOT_APPLICABLE', 'UNSURE']),
  knownLabelRelation: z.enum([
    'SAME_DEFECT',
    'DISTINCT',
    'PARTIAL_OVERLAP',
    'UNSURE',
    'NOT_COMPARED',
  ]),
  knownLabelIds: z.array(z.string()),
  duplicateGroup: z.string().trim().min(1).nullable(),
  contextBasis: z.enum([
    'PROVEN_ORIGINAL_INPUT',
    'RECONSTRUCTED_FROM_VERIFIED_BASE',
    'PATCH_APPLICATION_ONLY',
    'UNVERIFIED',
  ]),
  evidence: z.array(evidenceSchema),
  limitations: z.array(z.string()),
  adjudicator: adjudicatorSchema,
  at: z.iso.datetime({ offset: true }),
  labelComparison: z
    .strictObject({
      basis: z.enum(['FULL_DEFECT_EVIDENCE', 'CAPPED_CONTEXT']),
      labelIds: z.array(z.string()),
      evidence: z.array(evidenceSchema),
    })
    .optional(),
});
export type ClaimEvidence = z.infer<typeof evidenceSchema>;
export type ClaimJudgment = z.infer<typeof judgmentSchema>;
const sameSet = (a: string[], b: string[]): boolean =>
  new Set(a).size === a.length && a.length === b.length && a.every((id) => b.includes(id));

function validateDimensions(j: ClaimJudgment): void {
  if (j.adjudicator.tier !== 'HUMAN' && !j.adjudicator.model)
    throw new Error('AI-assisted adjudication requires the actual model');
  if (j.truth !== 'UNSURE' && j.evidence.length === 0)
    throw new Error('Resolved truth requires evidence');
  if (
    j.truth === 'REAL' &&
    (j.changeScope === 'NOT_APPLICABLE' || j.charterScope === 'NOT_APPLICABLE')
  )
    throw new Error('Real findings require scope assessment or UNSURE');
}

function validateLabelRelation(j: ClaimJudgment, labelIds: string[]): void {
  if (
    new Set(j.knownLabelIds).size !== j.knownLabelIds.length ||
    j.knownLabelIds.some((id) => !labelIds.includes(id))
  )
    throw new Error('Unknown or repeated known-label ID');
  const comparison = j.labelComparison;
  if (
    ['SAME_DEFECT', 'PARTIAL_OVERLAP'].includes(j.knownLabelRelation) &&
    (!j.knownLabelIds.length ||
      !comparison ||
      !comparison.evidence.length ||
      j.knownLabelIds.some((id) => !comparison.labelIds.includes(id)))
  )
    throw new Error('Causal label relation requires relation-specific comparison evidence');
  if (
    comparison &&
    (comparison.labelIds.some((id) => !labelIds.includes(id)) ||
      new Set(comparison.labelIds).size !== comparison.labelIds.length)
  )
    throw new Error('Invalid label comparison');
  if (
    j.knownLabelRelation === 'DISTINCT' &&
    (!comparison ||
      comparison.basis !== 'FULL_DEFECT_EVIDENCE' ||
      !sameSet(comparison.labelIds, labelIds) ||
      !sameSet(j.knownLabelIds, labelIds) ||
      (labelIds.length > 0 && comparison.evidence.length === 0))
  )
    throw new Error('DISTINCT requires comparison against the full available label set');
}

/** Parse every field before exact binding and precision calculations. */
export function validateClaimJudgments(json: string, inventory: ClaimInventory): ClaimJudgment[] {
  const parsed = z.array(judgmentSchema).safeParse(JSON.parse(json));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[1];
    if (field === 'adjudicator') throw new Error('Invalid adjudicator');
    if (!field || field === 'schemaVersion')
      throw new Error('Incompatible historical or malformed judgment');
    throw new Error(`Invalid judgment ${String(field)}`);
  }
  const claims = new Map(inventory.occurrences.map((claim) => [claim.occurrenceId, claim]));
  const seen = new Set<string>();
  for (const judgment of parsed.data) {
    const claim = claims.get(judgment.occurrenceId);
    if (
      !claim ||
      judgment.textSha256 !== claim.textSha256 ||
      sha256(claim.text) !== claim.textSha256
    )
      throw new Error('Judgment does not bind to the exact occurrence text');
    if (seen.has(claim.occurrenceId)) throw new Error('Multiple judgments for one occurrence');
    seen.add(claim.occurrenceId);
    validateDimensions(judgment);
    const task = inventory.tasks.find((t) => t.taskId === claim.taskId);
    if (!task) throw new Error('Occurrence is missing its task');
    const labels = inventory.inputs.find((i) => i.diffSha256 === task.diffSha256)?.labels ?? [];
    validateLabelRelation(
      judgment,
      labels.map((l) => l.id),
    );
  }
  return parsed.data;
}

export function judgmentTemplate(claim: ClaimOccurrence): ClaimJudgment {
  return {
    schemaVersion: 1,
    occurrenceId: claim.occurrenceId,
    textSha256: claim.textSha256,
    truth: 'UNSURE',
    changeScope: 'UNSURE',
    charterScope: 'UNSURE',
    knownLabelRelation: 'NOT_COMPARED',
    knownLabelIds: [],
    duplicateGroup: null,
    contextBasis: 'UNVERIFIED',
    evidence: [],
    limitations: [],
    adjudicator: { id: '', tier: 'AI', model: '' },
    at: '',
  };
}
