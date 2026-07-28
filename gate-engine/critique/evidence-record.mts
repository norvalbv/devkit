import { createHash } from 'node:crypto';

export type Sha256 = string;
export type PlanCritiqueId = `pc1_${string}`;
export type BlobRefV1 = { sha256: Sha256; byteLength: number; ref: string };
export type OpaqueTranscriptRefV1 = BlobRefV1 & { expiresAt: string };

export const PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES = 512 * 1024;
export const PLAN_CRITIQUE_PROJECTION_MAX_BYTES = 8 * 1024;
export const PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
export const PLAN_CRITIQUE_PROVIDERS = ['claude', 'codex', 'cursor'] as const;
export const PLAN_CRITIQUE_STATUSES = ['reviewed', 'wrong_phase', 'aborted'] as const;
export const PLAN_CRITIQUE_VERDICTS = [
  'PROCEED',
  'PROCEED_WITH_CHANGES',
  'RETHINK',
  'REJECT',
] as const;
export const PLAN_CRITIQUE_INELIGIBLE_REASONS = [
  'invalid_contract',
  'wrong_phase',
  'aborted',
  'blocking_verdict',
  'critical_findings',
  'unnecessary_recheck',
  'retry_limit_exceeded',
] as const;

export type PlanCritiqueProvider = (typeof PLAN_CRITIQUE_PROVIDERS)[number];
type Status = (typeof PLAN_CRITIQUE_STATUSES)[number] | null;
type Verdict = (typeof PLAN_CRITIQUE_VERDICTS)[number] | null;
type IneligibleReason = (typeof PLAN_CRITIQUE_INELIGIBLE_REASONS)[number];

export interface PlanCritiqueRecordV1 {
  schemaVersion: 1;
  kind: 'plan_critique_record';
  critiqueId: PlanCritiqueId;
  workId: string;
  lineage: { pass: number; parentCritiqueId: PlanCritiqueId | null };
  execution: {
    provider: PlanCritiqueProvider;
    callbackHash: Sha256;
    model: string | null;
    modelHash: Sha256 | null;
    promptHash: Sha256 | null;
  };
  repository: {
    fingerprint: Sha256;
    fingerprintSource: 'canonical_remote' | 'local_path';
    branch: string | null;
    head: string | null;
  };
  timestamps: { capturedAt: string; providerCompletedAt: string | null };
  contract: {
    state: 'valid' | 'invalid';
    error: { code: string; path: string } | null;
    status: Status;
    verdict: Verdict;
    criticalCount: number | null;
    eligibility:
      | { eligible: true; reason: 'eligible' }
      | { eligible: false; reason: IneligibleReason };
  };
  exactResponse: BlobRefV1;
  sanitizedProjection: (BlobRefV1 & { projectionSchemaVersion: 1 }) | null;
  opaqueTranscript: OpaqueTranscriptRefV1 | null;
}

export interface PlanCritiqueBlobPayloadsV1 {
  exactResponse: Uint8Array;
  sanitizedProjection?: Uint8Array;
  opaqueTranscript?: Uint8Array;
}

export interface PlanCritiqueBlobSnapshotsV1 {
  exactResponse: Buffer;
  sanitizedProjection?: Buffer;
  opaqueTranscript?: Buffer;
}

export type PlanCritiqueContractFactsV1 = Omit<PlanCritiqueRecordV1['contract'], 'eligibility'>;

export interface PlanCritiqueCaptureInputV1 {
  workId: string;
  execution: Pick<
    PlanCritiqueRecordV1['execution'],
    'provider' | 'callbackHash' | 'model' | 'promptHash'
  >;
  repository: PlanCritiqueRecordV1['repository'];
  providerCompletedAt: string | null;
  contract: PlanCritiqueContractFactsV1;
  exactResponse: Uint8Array;
  sanitizedProjection?: Uint8Array;
  opaqueTranscript?: { bytes: Uint8Array; expiresAt: string };
}

export const sha256Bytes = (value: Uint8Array): Sha256 =>
  createHash('sha256').update(value).digest('hex');

const invalid = (at: string): never => {
  throw new Error(`invalid plan critique record: ${at}`);
};

export function assertPlanCritiqueRecordValue(condition: unknown, at: string): asserts condition {
  if (!condition) invalid(at);
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get;

function snapshotPayload(value: unknown, at: string, maxBytes: number): Buffer {
  const byteLengthGetter = typedArrayByteLength;
  if (!byteLengthGetter) return invalid(at);
  let byteLength: number;
  try {
    byteLength = Reflect.apply(byteLengthGetter, value, []) as number;
  } catch {
    return invalid(at);
  }
  if (byteLength > maxBytes) invalid(at);
  const snapshot = Buffer.allocUnsafe(byteLength);
  try {
    Reflect.apply(Uint8Array.prototype.set, snapshot, [value]);
  } catch {
    return invalid(at);
  }
  if (snapshot.byteLength !== byteLength || snapshot.byteLength > maxBytes) invalid(at);
  return snapshot;
}

export function snapshotPlanCritiquePayloads(
  payloads: PlanCritiqueBlobPayloadsV1,
): PlanCritiqueBlobSnapshotsV1 {
  const exactResponse = payloads.exactResponse;
  const sanitizedProjection = payloads.sanitizedProjection;
  const opaqueTranscript = payloads.opaqueTranscript;
  return {
    exactResponse: snapshotPayload(
      exactResponse,
      '$.exactResponse payload',
      PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES,
    ),
    sanitizedProjection:
      sanitizedProjection === undefined
        ? undefined
        : snapshotPayload(
            sanitizedProjection,
            '$.sanitizedProjection payload',
            PLAN_CRITIQUE_PROJECTION_MAX_BYTES,
          ),
    opaqueTranscript:
      opaqueTranscript === undefined
        ? undefined
        : snapshotPayload(
            opaqueTranscript,
            '$.opaqueTranscript payload',
            PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES,
          ),
  };
}

function assertPayload(
  ref: BlobRefV1 | null,
  payload: Uint8Array | undefined,
  at: string,
  maxBytes: number,
): void {
  if ((ref === null) !== (payload === undefined)) invalid(at);
  if (!ref || !payload) return;
  if (
    payload.byteLength > maxBytes ||
    ref.byteLength > maxBytes ||
    ref.sha256 !== sha256Bytes(payload) ||
    ref.byteLength !== payload.byteLength
  )
    invalid(at);
}

export function assertPlanCritiquePayloadRefs(
  record: PlanCritiqueRecordV1,
  payloads: PlanCritiqueBlobSnapshotsV1,
): void {
  assertPayload(
    record.exactResponse,
    payloads.exactResponse,
    '$.exactResponse payload',
    PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES,
  );
  assertPayload(
    record.sanitizedProjection,
    payloads.sanitizedProjection,
    '$.sanitizedProjection payload',
    PLAN_CRITIQUE_PROJECTION_MAX_BYTES,
  );
  assertPayload(
    record.opaqueTranscript,
    payloads.opaqueTranscript,
    '$.opaqueTranscript payload',
    PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES,
  );
}

type Identity = Pick<PlanCritiqueRecordV1, 'workId' | 'lineage' | 'execution' | 'repository'>;

export function derivePlanCritiqueId(value: Identity): PlanCritiqueId {
  const key = [
    'plan_critique_record',
    1,
    value.execution.provider,
    value.execution.callbackHash,
    value.repository.fingerprint,
    value.workId,
    value.lineage.pass,
    value.lineage.parentCritiqueId,
  ];
  return `pc1_${sha256Bytes(Buffer.from(JSON.stringify(key)))}`;
}

export function canonicalPlanCritiqueRecordJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  })}\n`;
}
