import {
  assertPlanCritiquePayloadRefs,
  type BlobRefV1,
  derivePlanCritiqueId,
  type PlanCritiqueBlobSnapshotsV1,
  type PlanCritiqueCaptureInputV1,
  type PlanCritiqueContractFactsV1,
  type PlanCritiqueRecordV1,
  sha256Bytes,
  snapshotPlanCritiquePayloads,
} from './evidence-record.mts';
import {
  listPlanCritiqueRecordMetadata,
  readPlanCritiqueRecord,
  validatePlanCritiqueCaptureInput,
  validatePlanCritiqueRecord,
} from './evidence-store.mts';
import {
  persistPlanCritiqueRecordAtRoot,
  selectExistingCallback,
} from './evidence-store-internal.mts';
import { withPlanCritiquePersistenceLock } from './persistence-lock.mts';

export type { PlanCritiqueCaptureInputV1 } from './evidence-record.mts';

interface PreparedCaptureV1 {
  workId: string;
  execution: PlanCritiqueCaptureInputV1['execution'] & {
    modelHash: PlanCritiqueRecordV1['execution']['modelHash'];
  };
  repository: PlanCritiqueRecordV1['repository'];
  capturedAt: string;
  providerCompletedAt: string | null;
  contract: PlanCritiqueContractFactsV1;
  exactResponse: BlobRefV1;
  sanitizedProjection: PlanCritiqueRecordV1['sanitizedProjection'];
  opaqueTranscript: PlanCritiqueRecordV1['opaqueTranscript'];
  payloads: PlanCritiqueBlobSnapshotsV1;
}

function blobRef(payload: Buffer): BlobRefV1 {
  const sha256 = sha256Bytes(payload);
  return { sha256, byteLength: payload.byteLength, ref: `blobs/sha256/${sha256}` };
}

function prepareCapture(input: PlanCritiqueCaptureInputV1): PreparedCaptureV1 {
  const execution = input.execution;
  const repository = input.repository;
  const contract = input.contract;
  const error = contract.error;
  const transcript = input.opaqueTranscript;
  const transcriptExpiresAt = transcript?.expiresAt;
  const payloads = snapshotPlanCritiquePayloads({
    exactResponse: input.exactResponse,
    sanitizedProjection: input.sanitizedProjection,
    opaqueTranscript: transcript?.bytes,
  });
  const projectionRef = payloads.sanitizedProjection
    ? { ...blobRef(payloads.sanitizedProjection), projectionSchemaVersion: 1 as const }
    : null;
  const transcriptRef = payloads.opaqueTranscript
    ? { ...blobRef(payloads.opaqueTranscript), expiresAt: transcriptExpiresAt as string }
    : null;
  return {
    workId: input.workId,
    execution: {
      provider: execution.provider,
      callbackHash: execution.callbackHash,
      model: execution.model,
      modelHash: execution.model === null ? null : sha256Bytes(Buffer.from(execution.model)),
      promptHash: execution.promptHash,
    },
    repository: {
      fingerprint: repository.fingerprint,
      fingerprintSource: repository.fingerprintSource,
      branch: repository.branch,
      head: repository.head,
    },
    capturedAt: new Date().toISOString(),
    providerCompletedAt: input.providerCompletedAt,
    contract: {
      state: contract.state,
      error: error === null ? null : { code: error.code, path: error.path },
      status: contract.status,
      verdict: contract.verdict,
      criticalCount: contract.criticalCount,
    },
    exactResponse: blobRef(payloads.exactResponse),
    sanitizedProjection: projectionRef,
    opaqueTranscript: transcriptRef,
    payloads,
  };
}

function selectUniqueLineageParent(
  records: readonly PlanCritiqueRecordV1[],
  workId: string,
  repositoryFingerprint: string,
): PlanCritiqueRecordV1 | null {
  const ordered = records
    .filter(
      (record) =>
        record.workId === workId && record.repository.fingerprint === repositoryFingerprint,
    )
    .sort((left, right) =>
      left.lineage.pass === right.lineage.pass
        ? left.critiqueId.localeCompare(right.critiqueId)
        : left.lineage.pass < right.lineage.pass
          ? -1
          : 1,
    );
  for (const [index, record] of ordered.entries()) {
    const expectedPass = index + 1;
    const expectedParent = index === 0 ? null : ordered[index - 1]?.critiqueId;
    if (record.lineage.pass !== expectedPass || record.lineage.parentCritiqueId !== expectedParent)
      throw new Error('ambiguous plan critique lineage');
  }
  return ordered.at(-1) ?? null;
}

function requiresRecheck(record: PlanCritiqueRecordV1): boolean {
  return (
    record.contract.state === 'valid' &&
    record.contract.status === 'reviewed' &&
    (record.contract.verdict === 'RETHINK' ||
      record.contract.verdict === 'REJECT' ||
      Number(record.contract.criticalCount) > 0)
  );
}

function deriveEligibility(
  contract: PlanCritiqueContractFactsV1,
  pass: number,
  parent: PlanCritiqueRecordV1 | null,
): PlanCritiqueRecordV1['contract']['eligibility'] {
  if (contract.state === 'invalid') return { eligible: false, reason: 'invalid_contract' };
  if (contract.status === 'wrong_phase' || contract.status === 'aborted')
    return { eligible: false, reason: contract.status };
  if (contract.verdict === 'RETHINK' || contract.verdict === 'REJECT')
    return { eligible: false, reason: 'blocking_verdict' };
  if (Number(contract.criticalCount) > 0) return { eligible: false, reason: 'critical_findings' };
  if (pass > 2) return { eligible: false, reason: 'retry_limit_exceeded' };
  if (pass === 2 && parent && !requiresRecheck(parent))
    return { eligible: false, reason: 'unnecessary_recheck' };
  return { eligible: true, reason: 'eligible' };
}

function buildRecord(
  prepared: PreparedCaptureV1,
  parent: PlanCritiqueRecordV1 | null,
): PlanCritiqueRecordV1 {
  const lineage = parent
    ? { pass: parent.lineage.pass + 1, parentCritiqueId: parent.critiqueId }
    : { pass: 1, parentCritiqueId: null };
  const base = {
    schemaVersion: 1 as const,
    kind: 'plan_critique_record' as const,
    workId: prepared.workId,
    lineage,
    execution: prepared.execution,
    repository: prepared.repository,
    timestamps: {
      capturedAt: prepared.capturedAt,
      providerCompletedAt: prepared.providerCompletedAt,
    },
    contract: {
      ...prepared.contract,
      eligibility: deriveEligibility(prepared.contract, lineage.pass, parent),
    },
    exactResponse: prepared.exactResponse,
    sanitizedProjection: prepared.sanitizedProjection,
    opaqueTranscript: prepared.opaqueTranscript,
  };
  return { ...base, critiqueId: derivePlanCritiqueId(base) };
}

export function capturePlanCritiqueRecord(
  input: PlanCritiqueCaptureInputV1,
  options: { root?: string } = {},
): { state: 'created' | 'existing'; record: PlanCritiqueRecordV1 } {
  validatePlanCritiqueCaptureInput(input);
  const prepared = prepareCapture(input);
  const preflightRecord = buildRecord(prepared, null);
  validatePlanCritiqueRecord(preflightRecord);
  assertPlanCritiquePayloadRefs(preflightRecord, prepared.payloads);
  const capture = (
    canonicalRoot: string,
  ): { state: 'created' | 'existing'; record: PlanCritiqueRecordV1 } => {
    const rootOptions = { root: canonicalRoot };
    const records = listPlanCritiqueRecordMetadata(rootOptions);
    const existing = selectExistingCallback(prepared, records);
    if (existing)
      return persistPlanCritiqueRecordAtRoot(
        existing,
        prepared.payloads,
        canonicalRoot,
        records,
        (critiqueId) => readPlanCritiqueRecord(critiqueId, rootOptions),
      );

    const parent = selectUniqueLineageParent(
      records,
      prepared.workId,
      prepared.repository.fingerprint,
    );
    const record = buildRecord(prepared, parent);
    validatePlanCritiqueRecord(record);
    assertPlanCritiquePayloadRefs(record, prepared.payloads);
    return persistPlanCritiqueRecordAtRoot(
      record,
      prepared.payloads,
      canonicalRoot,
      records,
      (critiqueId) => readPlanCritiqueRecord(critiqueId, rootOptions),
    );
  };
  return withPlanCritiquePersistenceLock(options, capture);
}
