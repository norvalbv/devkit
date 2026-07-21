import {
  type BlobRefV1,
  type PlanCritiqueBlobSnapshotsV1,
  type PlanCritiqueRecordV1,
  assertPlanCritiqueRecordValue as requireValue,
  sha256Bytes,
} from './evidence-record.mts';
import { managedPath, publishImmutable, readPrivateFile } from './immutable-file.mts';
import { resolvePlanCritiqueEvidenceRoot } from './persistence-lock.mts';

export function validatePersistedParent(
  record: PlanCritiqueRecordV1,
  parent: PlanCritiqueRecordV1 | null,
): void {
  if (record.lineage.pass === 1) return;
  requireValue(parent !== null, '$.lineage.parentCritiqueId');
  requireValue(parent.lineage.pass + 1 === record.lineage.pass, '$.lineage.pass');
  requireValue(parent.workId === record.workId, '$.lineage.parentCritiqueId');
  requireValue(
    parent.repository.fingerprint === record.repository.fingerprint,
    '$.lineage.parentCritiqueId',
  );
  const recheckRequired =
    parent.contract.state === 'valid' &&
    parent.contract.status === 'reviewed' &&
    (parent.contract.verdict === 'RETHINK' ||
      parent.contract.verdict === 'REJECT' ||
      Number(parent.contract.criticalCount) > 0);
  if (record.contract.eligibility.eligible) requireValue(recheckRequired, '$.contract.eligibility');
  if (record.contract.eligibility.reason === 'unnecessary_recheck')
    requireValue(!recheckRequired, '$.contract.eligibility');
}

export function selectExistingCallback(
  candidate: PlanCritiqueRecordV1,
  records: readonly PlanCritiqueRecordV1[],
): PlanCritiqueRecordV1 | null {
  const matches = records.filter(
    (stored) =>
      stored.execution.provider === candidate.execution.provider &&
      stored.execution.callbackHash === candidate.execution.callbackHash &&
      stored.repository.fingerprint === candidate.repository.fingerprint,
  );
  if (matches.length > 1) throw new Error('ambiguous plan critique callback identity');
  const stored = matches[0];
  if (!stored) return null;
  if (
    stored.workId !== candidate.workId ||
    stored.exactResponse.sha256 !== candidate.exactResponse.sha256 ||
    stored.exactResponse.byteLength !== candidate.exactResponse.byteLength
  )
    throw new Error('plan critique callback identity conflict');
  return stored;
}

export function matchingStoredPayload(
  ref: BlobRefV1 | null,
  payload: Buffer | undefined,
): Buffer | undefined {
  return ref &&
    payload &&
    ref.sha256 === sha256Bytes(payload) &&
    ref.byteLength === payload.byteLength
    ? payload
    : undefined;
}

export function publishBlobSnapshots(
  canonicalRoot: string,
  snapshots: PlanCritiqueBlobSnapshotsV1,
): void {
  const blobs = managedPath(canonicalRoot, ['blobs', 'sha256'], true) as string;
  for (const payload of [
    snapshots.exactResponse,
    snapshots.sanitizedProjection,
    snapshots.opaqueTranscript,
  ])
    if (payload) publishImmutable(blobs, sha256Bytes(payload), payload);
}

export function readStoredBlob(ref: BlobRefV1, options: { root?: string }): Buffer | null {
  const base = resolvePlanCritiqueEvidenceRoot(options, false);
  const blobs = base && managedPath(base, ['blobs', 'sha256'], false);
  if (!blobs) return null;
  const value = readPrivateFile(blobs, ref.sha256);
  return value && value.byteLength === ref.byteLength && sha256Bytes(value) === ref.sha256
    ? value
    : null;
}

export function hasDurableRecordBlobs(
  record: PlanCritiqueRecordV1,
  options: { root?: string },
): boolean {
  try {
    const durableRefs = [record.exactResponse, record.sanitizedProjection];
    return durableRefs.every((ref) => ref === null || readStoredBlob(ref, options) !== null);
  } catch {
    return false;
  }
}
