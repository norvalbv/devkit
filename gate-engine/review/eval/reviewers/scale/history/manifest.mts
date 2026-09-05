import { z } from 'zod';
import { canonicalJson, sha256 } from '../../../../../eval/history.mts';

export const hash = <T,>(value: T): string => sha256(canonicalJson(value));
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
const names = z
  .array(z.string().min(1))
  .min(1)
  .refine((xs) => new Set(xs).size === xs.length);
export const armSchema = z.enum(['current', 'history']);
export const roundKinds = ['initial', 'unchanged', 'partial', 'repaired', 'reopened'] as const;
const taskSchema = z.strictObject({
  key: id,
  lenses: names,
  files: names,
  diffSha256: digest,
  inventorySha256: digest,
});
const roundSchema = z.strictObject({
  kind: z.enum(roundKinds),
  baseSha: commit,
  postTreeSha: commit,
  diffSha256: digest,
  authorSha256: digest,
  tasks: z.array(taskSchema).min(1).max(100),
});
const familySchema = z.strictObject({
  id,
  branchSha256: digest,
  incidentSha256s: z.array(digest).min(1),
  caseIds: names,
  exposure: z.enum(['exposed-development', 'reserved']),
  rounds: z.array(roundSchema).length(5),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  runId: id,
  executionSha256: digest,
  nativeArm: z.literal('cap400'),
  historyCapBytes: z.number().int().min(512).max(65536),
  historyPolicy: z.literal('newest-contiguous-whole-rounds'),
  families: z.array(familySchema).min(1).max(8),
});
export type TimelineManifest = z.infer<typeof manifestSchema>;
export type TimelineFamily = TimelineManifest['families'][number];
export type TimelineRound = TimelineFamily['rounds'][number];
export type TimelineTask = TimelineRound['tasks'][number];
export type TimelineArm = z.infer<typeof armSchema>;

/** Validates declared lineage only; it cannot discover undeclared shared incidents or certify labels. */
export const parseTimeline = manifestSchema.transform((manifest): TimelineManifest => {
  const ownership = new Set<string>();
  for (const family of manifest.families) {
    for (const token of [
      `family:${family.id}`,
      ...family.incidentSha256s.map((s) => `incident:${s}`),
      ...family.caseIds.map((s) => `case:${s}`),
    ]) {
      if (ownership.has(token)) throw new Error('DUPLICATE_FAMILY_LINEAGE');
      ownership.add(token);
    }
    family.rounds.forEach((round, index) => {
      if (round.kind !== roundKinds[index]) throw new Error('ROUND_ORDER');
      if (round.baseSha !== family.rounds[0].baseSha) throw new Error('ROUND_BASE_CHANGED');
      if (new Set(round.tasks.map((t) => t.key)).size !== round.tasks.length)
        throw new Error('DUPLICATE_TASK');
    });
    const [initial, unchanged] = family.rounds;
    if (
      initial.diffSha256 !== unchanged.diffSha256 ||
      initial.postTreeSha !== unchanged.postTreeSha
    )
      throw new Error('RESUBMISSION_CHANGED');
  }
  return manifest;
}).parse;
