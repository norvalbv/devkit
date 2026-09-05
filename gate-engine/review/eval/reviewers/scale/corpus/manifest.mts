import { z } from 'zod';
import { pairGroups } from '../../corpus/twins.mts';
import { canonical, sha256 } from '../claim-inventory.mts';

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const alias = z.string().regex(/^[a-z]+-[0-9]{3}$/);
const relativeFile = z
  .string()
  .min(1)
  .refine(
    (file) =>
      !file.startsWith('/') &&
      !file.includes('\\') &&
      !file.includes('\0') &&
      file.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  );
export const spanSchema = z
  .strictObject({
    file: relativeFile,
    side: z.enum(['base', 'post']),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    fileSha256: digest,
    spanSha256: digest,
  })
  .refine((span) => span.end >= span.start);
export const entrySchema = z.strictObject({
  id: alias,
  family: alias,
  incidentSha256: digest,
  exposure: z.enum(['exposed-development', 'reserved']),
  role: z.enum(['bug', 'repair']),
  variantOf: alias.nullable(),
  targetLens: z.enum([
    'state-transitions',
    'concurrency-races',
    'error-and-edge-classification',
    'writer-reader-contracts',
  ]),
  qualification: z.enum(['unresolved', 'target-controlled', 'qualified-pair']),
  source: z.strictObject({
    repoAlias: alias,
    baseSha: commit,
    diffSha256: digest,
    provenanceSha256: digest,
  }),
  evidence: z.strictObject({
    requirementSha256: digest.nullable(),
    controlSha256: digest.nullable(),
    assessmentSha256: digest.nullable(),
  }),
  spans: z.array(spanSchema).min(1),
});
export const manifestSchema = z.strictObject({
  version: z.literal(1),
  mode: z.literal('zero-judge-source-census'),
  entries: z.array(entrySchema).min(1),
  selectedFamilies: z.array(alias).min(1).max(8),
});
export type CensusEntry = z.infer<typeof entrySchema>;
export type CensusManifest = z.infer<typeof manifestSchema>;

/** Validate the entire declared universe before selecting any family. Evidence receipts are
 * assertions to audit, not machine-generated truth or permission to admit corpus rows. */
export function parseManifest(serialized: string): CensusManifest {
  const parsed = manifestSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) throw new Error('INVALID_MANIFEST');
  const manifest = parsed.data;
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  if (entries.size !== manifest.entries.length) throw new Error('DUPLICATE_CASE');
  const incidents = new Map<string, string>();
  const families = new Map<
    string,
    { bug: boolean; repair: boolean; qualified: number; total: number }
  >();
  for (const entry of manifest.entries) {
    if (entry.role === 'bug' && entry.variantOf) throw new Error('INVALID_VARIANT');
    if (entry.role === 'repair' && !entry.variantOf) throw new Error('MISSING_BUG_REFERENCE');
    if (entry.variantOf) {
      const parent = entries.get(entry.variantOf);
      if (!parent || parent.id === entry.id || parent.role !== 'bug')
        throw new Error('INVALID_VARIANT');
      if (parent.family !== entry.family) throw new Error('FAMILY_BRIDGE');
      if (
        parent.incidentSha256 !== entry.incidentSha256 ||
        parent.source.repoAlias !== entry.source.repoAlias ||
        parent.targetLens !== entry.targetLens ||
        (parent.evidence.requirementSha256 !== null &&
          entry.evidence.requirementSha256 !== null &&
          parent.evidence.requirementSha256 !== entry.evidence.requirementSha256)
      )
        throw new Error('REPAIR_TARGET_MISMATCH');
    }
    const members = families.get(entry.family) ?? {
      bug: false,
      repair: false,
      qualified: 0,
      total: 0,
    };
    members[entry.role] = true;
    members.total += 1;
    if (entry.qualification === 'qualified-pair') members.qualified += 1;
    families.set(entry.family, members);
    const family = incidents.get(entry.incidentSha256);
    if (family && family !== entry.family) throw new Error('INCIDENT_BRIDGE');
    incidents.set(entry.incidentSha256, entry.family);
    if (
      entry.qualification !== 'unresolved' &&
      Object.values(entry.evidence).some((hash) => hash === null)
    )
      throw new Error('MISSING_QUALIFICATION_EVIDENCE');
  }
  const groups = pairGroups(
    manifest.entries.map((entry) => ({
      id: entry.id,
      caseId: entry.family,
      variantOf: entry.variantOf,
    })),
  );
  const repaired = new Set(
    manifest.entries.filter((entry) => entry.role === 'repair').map((entry) => entry.variantOf),
  );
  const exposures = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.qualification === 'qualified-pair' && entry.role === 'bug' && !repaired.has(entry.id))
      throw new Error('INCOMPLETE_QUALIFIED_FAMILY');
    const group = z.string().safeParse(groups.get(entry.id));
    if (!group.success) throw new Error('INVALID_FAMILY');
    const key = group.data;
    if (exposures.has(key) && exposures.get(key) !== entry.exposure)
      throw new Error('EXPOSURE_SPLIT');
    exposures.set(key, entry.exposure);
  }
  for (const family of families.values()) {
    if (family.qualified && (!family.bug || !family.repair || family.qualified !== family.total))
      throw new Error('INCOMPLETE_QUALIFIED_FAMILY');
  }
  const known = new Set(manifest.entries.map((entry) => entry.family));
  if (
    new Set(manifest.selectedFamilies).size !== manifest.selectedFamilies.length ||
    manifest.selectedFamilies.some((family) => !known.has(family))
  )
    throw new Error('INVALID_SELECTION');
  return manifest;
}

export const manifestHash = (manifest: CensusManifest): string => sha256(canonical(manifest));
