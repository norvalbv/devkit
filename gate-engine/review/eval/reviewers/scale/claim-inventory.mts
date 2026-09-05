/** Private census of recorded claims. Locations and labels never select the denominator. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { reviewCaptureItemSchema, reviewCaptureSchema } from '../../../evidence/items.mts';
import { extractLocations, type ArchivedDiffEvidence } from './labels.mts';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const jsonSchema = z.json();
export type JsonValue = z.infer<typeof jsonSchema>;
const canonicalSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(canonicalSchema),
    z
      .record(z.string(), canonicalSchema)
      .transform((value) =>
        Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ),
  ]),
);
export const canonical = (value: JsonValue): string => JSON.stringify(canonicalSchema.parse(value));
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({ lenses: z.array(z.string()), files: z.array(z.string()) });
const parentSchema = z.strictObject({
  id: z.string().min(1),
  expectedTaskKeys: z
    .array(z.string())
    .min(1)
    .refine((keys) => new Set(keys).size === keys.length),
});
const rowSchema = z
  .object({
    key: z.string().optional(),
    identity: z.string().optional(),
    at: z.string().optional(),
    diff: z.string().optional(),
    model: z.string().optional(),
    arm: z.string().optional(),
    base: z.string().optional(),
    status: z.string().optional(),
    issues: jsonSchema.optional(),
    capture: jsonSchema.optional(),
    scope: jsonSchema.optional(),
    parentReplay: jsonSchema.optional(),
  })
  .catchall(jsonSchema);
const envelopeSchema = z
  .object({ diff: hashSchema, rows: z.array(jsonSchema), labels: z.array(jsonSchema).default([]) })
  .catchall(jsonSchema);
const locationSchema = z.strictObject({ file: z.string(), line: z.number().nullable() });
const occurrenceSchema = z.strictObject({
  occurrenceId: hashSchema,
  textSha256: hashSchema,
  taskId: hashSchema,
  itemIndex: z.number().int().nonnegative(),
  issueIndex: z.number().int().nonnegative(),
  lens: z.string(),
  itemStatus: z.string(),
  disposition: z.enum(['blocking', 'waived', 'dropped_out_of_charter']).optional(),
  text: z.string(),
  locations: z.array(locationSchema),
});
const errorCodeSchema = z.enum([
  'unreadable-results-file',
  'invalid-results-file',
  'invalid-task-row',
  'task-diff-mismatch',
  'missing-diff',
  'unreadable-diff-archive',
  'invalid-diff-archive',
  'diff-hash-mismatch',
  'invalid-capture',
  'invalid-scope',
  'invalid-parent-roster',
  'legacy-identity',
  'unattributed-fail',
  'inexact-claim-text',
  'unknown-claim-count',
]);
const taskSchema = z.strictObject({
  taskId: hashSchema,
  key: z.string(),
  namespace: z.string(),
  diffSha256: hashSchema,
  identity: z.string().nullable(),
  at: z.string().nullable(),
  model: z.string().nullable(),
  arm: z.string(),
  base: z.string().nullable(),
  status: z.string(),
  terminal: z.boolean(),
  captureProvenance: z.enum([
    'exact-checklist',
    'capped-fallback',
    'missing-invalid',
    'legacy-unknown',
  ]),
  captureArtifact: z.enum(['items', 'files']).optional(),
  skipReason: z.string().optional(),
  captureExact: z.boolean(),
  coverage: z.enum(['complete', 'incomplete', 'unknown', 'skipped']),
  scope: scopeSchema.optional(),
  parentReplay: parentSchema.optional(),
  items: z.array(reviewCaptureItemSchema.strict()),
  occurrenceIds: z.array(hashSchema),
  missingClaims: z.boolean(),
  errors: z.array(errorCodeSchema),
  sourceRow: jsonSchema,
});
const errorSchema = z.strictObject({
  code: errorCodeSchema,
  source: z.string(),
  taskId: hashSchema.optional(),
});
const inputSchema = z.strictObject({
  diffSha256: hashSchema,
  diffText: z.string().nullable(),
  labels: z.array(z.object({ id: hashSchema, value: jsonSchema })),
});
export const claimInventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  cohort: z.literal('historical-FAIL-selected-replay'),
  tasks: z.array(taskSchema),
  occurrences: z.array(occurrenceSchema),
  inputs: z.array(inputSchema),
  errors: z.array(errorSchema),
  rejectedRows: z.array(jsonSchema),
  copiedTasks: z.number().int().nonnegative(),
});
export type ClaimInventory = z.infer<typeof claimInventorySchema>;
export type ClaimTask = z.infer<typeof taskSchema>;
export type ClaimOccurrence = z.infer<typeof occurrenceSchema>;
export type CensusError = z.infer<typeof errorSchema>;
export interface CensusSource {
  source: string;
  namespace: string;
  resultJson: string;
  diffText: string | null;
  diffError?: ArchivedDiffEvidence['error'];
}
type CensusRow = z.infer<typeof rowSchema>;
type CaptureItem = z.infer<typeof reviewCaptureItemSchema>;
const legacyIssueSchema = z.object({ text: z.string(), lens: z.string().catch('') });

export function parseResultsEnvelope(json: string) {
  return envelopeSchema.safeParse(JSON.parse(json));
}

function legacyItems(raw: JsonValue | undefined): CaptureItem[] {
  const parsed = z.array(jsonSchema).safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.flatMap((value, itemIndex) => {
    const issue = legacyIssueSchema.safeParse(value);
    return issue.success
      ? [{ itemIndex, lens: issue.data.lens, status: 'unknown', issues: [issue.data.text] }]
      : [];
  });
}

function coverageOf(
  items: CaptureItem[],
  scope: ClaimTask['scope'],
  skipReason?: string,
): ClaimTask['coverage'] {
  if (items.length === 0 && skipReason?.trim()) return 'skipped';
  if (!scope || scope.lenses.length === 0) return 'unknown';
  return scope.lenses.every((lens) =>
    items.some(
      (item) =>
        item.lens === lens && ['pass', 'fail', 'skipped'].includes(item.status.toLowerCase()),
    ),
  )
    ? 'complete'
    : 'incomplete';
}

function taskOf(
  row: CensusRow,
  sourceRow: JsonValue,
  input: CensusSource,
  diff: string,
  rowIndex: number,
): ClaimTask {
  const key = row.key ?? `legacy-row:${rowIndex}`;
  const identity = row.identity ?? null;
  const at = row.at ?? null;
  const taskId = sha256(canonical([input.namespace, diff, key, identity, at]));
  const parsedCapture = reviewCaptureSchema.safeParse(row.capture);
  const capture = parsedCapture.success ? parsedCapture.data : undefined;
  const parsedScope = scopeSchema.safeParse(row.scope);
  const scope = parsedScope.success ? parsedScope.data : undefined;
  const parsedParent = parentSchema.safeParse(row.parentReplay);
  const parentReplay = parsedParent.success ? parsedParent.data : undefined;
  const items = capture?.items ?? legacyItems(row.issues);
  const status = row.status?.toLowerCase() ?? 'unknown';
  const errors: z.infer<typeof errorCodeSchema>[] = [];
  if (row.diff !== undefined && row.diff !== diff) errors.push('task-diff-mismatch');
  if (input.diffText === null) errors.push(input.diffError ?? 'missing-diff');
  else if (sha256(input.diffText) !== diff) errors.push('diff-hash-mismatch');
  if (row.capture !== undefined && !capture) errors.push('invalid-capture');
  if (row.scope !== undefined && !scope) errors.push('invalid-scope');
  if (row.parentReplay !== undefined && !parentReplay) errors.push('invalid-parent-roster');
  if (!row.key || !identity || !at) errors.push('legacy-identity');
  const captureExact = capture?.provenance === 'exact-checklist';
  // Native checkItem/checkFile clear issues on pass. Keep inconsistent recorded bytes, but
  // exclude their task from adjudication credit through the existing capture-integrity error.
  if (captureExact && items.some((item) => item.status === 'pass' && item.issues.length > 0))
    errors.push('invalid-capture');
  const blocking = items.filter(
    (i) =>
      i.status.toLowerCase() === 'fail' &&
      i.disposition !== 'waived' &&
      i.disposition !== 'dropped_out_of_charter',
  );
  if (captureExact && status === 'pass' && blocking.length > 0) errors.push('invalid-capture');
  const attributed = blocking.some((i) => i.issues.length > 0);
  const missingClaims =
    !captureExact ||
    (status === 'fail' && (!attributed || blocking.some((i) => i.issues.length === 0)));
  if (status === 'fail' && !attributed) errors.push('unattributed-fail');
  if (!captureExact)
    errors.push(items.some((i) => i.issues.length) ? 'inexact-claim-text' : 'unknown-claim-count');
  return {
    taskId,
    key,
    namespace: input.namespace,
    diffSha256: diff,
    identity,
    at,
    model: row.model ?? null,
    arm: row.arm ?? 'unknown',
    base: row.base ?? null,
    status,
    terminal: status === 'pass' || status === 'fail',
    captureProvenance: capture?.provenance ?? 'legacy-unknown',
    captureArtifact: capture?.artifact,
    skipReason: capture?.skipped,
    captureExact,
    coverage: coverageOf(
      items,
      scope,
      captureExact && status === 'pass' ? capture?.skipped : undefined,
    ),
    scope,
    parentReplay,
    items,
    occurrenceIds: [],
    missingClaims,
    errors,
    sourceRow,
  };
}

/** Census first; exact copies count once; a changed task with the same identity aborts. */
export function buildClaimInventory(
  sources: CensusSource[],
  readErrors: CensusError[] = [],
): ClaimInventory {
  const result: ClaimInventory = {
    schemaVersion: 1,
    cohort: 'historical-FAIL-selected-replay',
    tasks: [],
    occurrences: [],
    inputs: [],
    errors: [...readErrors],
    rejectedRows: [],
    copiedTasks: 0,
  };
  const seen = new Map<string, string>();
  const inputs = new Map<string, ClaimInventory['inputs'][number]>();
  const parsedSources: { source: CensusSource; envelope: z.infer<typeof envelopeSchema> }[] = [];
  for (const source of sources) {
    let envelope: ReturnType<typeof parseResultsEnvelope>;
    try {
      envelope = parseResultsEnvelope(source.resultJson);
    } catch {
      result.errors.push({ source: source.source, code: 'invalid-results-file' });
      continue;
    }
    if (!envelope.success) {
      result.errors.push({ source: source.source, code: 'invalid-results-file' });
      continue;
    }
    const diff = envelope.data.diff;
    parsedSources.push({ source, envelope: envelope.data });
    const existingInput = inputs.get(diff);
    if (
      existingInput &&
      existingInput.diffText !== null &&
      source.diffText !== null &&
      existingInput.diffText !== source.diffText
    )
      throw new Error(`Conflicting diff bytes for ${diff}`);
    const labels = [
      ...new Map(
        envelope.data.labels.map((value) => [
          sha256(canonical(value)),
          { id: sha256(canonical(value)), value },
        ]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id));
    if (
      existingInput &&
      canonical(existingInput.labels.map((l) => l.id)) !== canonical(labels.map((l) => l.id))
    )
      throw new Error(`Conflicting label sets for ${diff}`);
    inputs.set(diff, {
      diffSha256: diff,
      diffText: source.diffText ?? existingInput?.diffText ?? null,
      labels,
    });
  }
  for (const { source, envelope } of parsedSources) {
    const diff = envelope.diff;
    const resolvedSource = { ...source, diffText: inputs.get(diff)!.diffText };
    envelope.rows.forEach((sourceRow, rowIndex) => {
      const parsed = rowSchema.safeParse(sourceRow);
      if (!parsed.success) {
        result.errors.push({ source: source.source, code: 'invalid-task-row' });
        result.rejectedRows.push(sourceRow);
        return;
      }
      const task = taskOf(parsed.data, sourceRow, resolvedSource, diff, rowIndex);
      const signature = canonical(sourceRow);
      if (seen.has(task.taskId)) {
        if (seen.get(task.taskId) !== signature)
          throw new Error(`Conflicting task identity ${task.taskId}`);
        result.copiedTasks += 1;
        return;
      }
      seen.set(task.taskId, signature);
      result.tasks.push(task);
      for (const code of task.errors)
        result.errors.push({ source: source.source, code, taskId: task.taskId });
      for (const item of task.items)
        item.issues.forEach((text, issueIndex) => {
          const textSha256 = sha256(text);
          const occurrenceId = sha256(
            canonical([task.taskId, item.itemIndex, issueIndex, textSha256]),
          );
          task.occurrenceIds.push(occurrenceId);
          result.occurrences.push({
            occurrenceId,
            textSha256,
            taskId: task.taskId,
            itemIndex: item.itemIndex,
            issueIndex,
            lens: item.lens,
            itemStatus: item.status,
            disposition: item.disposition,
            text,
            locations: extractLocations(text),
          });
        });
    });
  }
  result.inputs = [...inputs.values()];
  return result;
}

/** No arm/model, disposition, other claims, labels, repetition counts, or source filenames. */
export function blindClaimPackets(inventory: ClaimInventory) {
  return inventory.occurrences.map((claim) => {
    const task = inventory.tasks.find((t) => t.taskId === claim.taskId)!;
    const input = inventory.inputs.find((i) => i.diffSha256 === task.diffSha256)!;
    return {
      schemaVersion: 1,
      occurrenceId: claim.occurrenceId,
      textSha256: claim.textSha256,
      claim: claim.text,
      charterLens: claim.lens,
      archivedInput: { diffSha256: task.diffSha256, diffText: input.diffText },
      evaluatedBase: task.base,
      claimCapture: { provenance: task.captureProvenance, exact: task.captureExact },
      instruction:
        'Assess this full claim against the evaluated code. Record concrete evidence and context limits. Do not infer truth from confidence or location. Partly true compound claims remain UNSURE.',
    };
  });
}
