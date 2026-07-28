import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { derivePlanCritiqueId, type PlanCritiqueRecordV1 } from '../evidence-store.mts';

export const bytes = (value: string): Uint8Array => Buffer.from(value);

export const sha256Bytes = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const makeBlobRef = (value: Uint8Array) => {
  const sha256 = sha256Bytes(value);
  return { sha256, byteLength: value.byteLength, ref: `blobs/sha256/${sha256}` };
};

export const temporaryRoot = (): string =>
  path.join(mkdtempSync(path.join(tmpdir(), 'critique-store-')), 'evidence');

export function recordFor(
  exact: Uint8Array,
  optional: { projection?: Uint8Array; transcript?: Uint8Array } = {},
): PlanCritiqueRecordV1 {
  const execution = {
    provider: 'codex' as const,
    callbackHash: sha256Bytes(bytes('callback-1')),
    model: 'gpt-5.6',
    modelHash: sha256Bytes(bytes('gpt-5.6')),
    promptHash: sha256Bytes(bytes('prompt')),
  };
  const repository = {
    fingerprint: sha256Bytes(bytes('repo')),
    fingerprintSource: 'canonical_remote' as const,
    branch: 'codex/example',
    head: 'a'.repeat(40),
  };
  const base = {
    schemaVersion: 1 as const,
    kind: 'plan_critique_record' as const,
    workId: 'work-1',
    lineage: { pass: 1, parentCritiqueId: null },
    execution,
    repository,
    timestamps: { capturedAt: '2026-07-19T01:02:03.000Z', providerCompletedAt: null },
    contract: {
      state: 'valid' as const,
      error: null,
      status: 'reviewed' as const,
      verdict: 'PROCEED_WITH_CHANGES' as const,
      criticalCount: 0,
      eligibility: { eligible: true, reason: 'eligible' as const },
    },
    exactResponse: makeBlobRef(exact),
    sanitizedProjection: optional.projection
      ? { ...makeBlobRef(optional.projection), projectionSchemaVersion: 1 as const }
      : null,
    opaqueTranscript: optional.transcript
      ? { ...makeBlobRef(optional.transcript), expiresAt: '2026-08-19T01:02:03.000Z' }
      : null,
  };
  return { ...base, critiqueId: derivePlanCritiqueId(base) };
}
