import { canonicalPlanCritiqueRecordJson, assertPlanCritiqueRecordValue as requireValue, sha256Bytes, } from "./evidence-record.mjs";
import { managedPath, publishImmutable, readPrivateFile } from "./immutable-file.mjs";
import { resolvePlanCritiqueEvidenceRoot } from "./persistence-lock.mjs";
export function validatePersistedParent(record, parent) {
    if (record.lineage.pass === 1)
        return;
    requireValue(parent !== null, '$.lineage.parentCritiqueId');
    requireValue(parent.lineage.pass + 1 === record.lineage.pass, '$.lineage.pass');
    requireValue(parent.workId === record.workId, '$.lineage.parentCritiqueId');
    requireValue(parent.repository.fingerprint === record.repository.fingerprint, '$.lineage.parentCritiqueId');
    const recheckRequired = parent.contract.state === 'valid' &&
        parent.contract.status === 'reviewed' &&
        (parent.contract.verdict === 'RETHINK' ||
            parent.contract.verdict === 'REJECT' ||
            Number(parent.contract.criticalCount) > 0);
    if (record.contract.eligibility.eligible)
        requireValue(recheckRequired, '$.contract.eligibility');
    if (record.contract.eligibility.reason === 'unnecessary_recheck')
        requireValue(!recheckRequired, '$.contract.eligibility');
}
export function selectExistingCallback(candidate, records) {
    const matches = records.filter((stored) => stored.execution.provider === candidate.execution.provider &&
        stored.execution.callbackHash === candidate.execution.callbackHash &&
        stored.repository.fingerprint === candidate.repository.fingerprint);
    if (matches.length > 1)
        throw new Error('ambiguous plan critique callback identity');
    const stored = matches[0];
    if (!stored)
        return null;
    if (stored.workId !== candidate.workId ||
        stored.exactResponse.sha256 !== candidate.exactResponse.sha256 ||
        stored.exactResponse.byteLength !== candidate.exactResponse.byteLength)
        throw new Error('plan critique callback identity conflict');
    return stored;
}
export function matchingStoredPayload(ref, payload) {
    return ref &&
        payload &&
        ref.sha256 === sha256Bytes(payload) &&
        ref.byteLength === payload.byteLength
        ? payload
        : undefined;
}
export function publishBlobSnapshots(canonicalRoot, snapshots) {
    const blobs = managedPath(canonicalRoot, ['blobs', 'sha256'], true);
    for (const payload of [
        snapshots.exactResponse,
        snapshots.sanitizedProjection,
        snapshots.opaqueTranscript,
    ])
        if (payload)
            publishImmutable(blobs, sha256Bytes(payload), payload);
}
export function readStoredBlob(ref, options) {
    const base = resolvePlanCritiqueEvidenceRoot(options, false);
    const blobs = base && managedPath(base, ['blobs', 'sha256'], false);
    if (!blobs)
        return null;
    const value = readPrivateFile(blobs, ref.sha256);
    return value && value.byteLength === ref.byteLength && sha256Bytes(value) === ref.sha256
        ? value
        : null;
}
export function hasDurableRecordBlobs(record, options) {
    try {
        const durableRefs = [record.exactResponse, record.sanitizedProjection];
        return durableRefs.every((ref) => ref === null || readStoredBlob(ref, options) !== null);
    }
    catch {
        return false;
    }
}
/** Persist an already validated record while the canonical-root lock is held. */
export function persistPlanCritiqueRecordAtRoot(record, snapshots, canonicalRoot, records, readRecord) {
    const existing = selectExistingCallback(record, records);
    if (existing) {
        publishBlobSnapshots(canonicalRoot, {
            exactResponse: snapshots.exactResponse,
            sanitizedProjection: matchingStoredPayload(existing.sanitizedProjection, snapshots.sanitizedProjection),
            opaqueTranscript: matchingStoredPayload(existing.opaqueTranscript, snapshots.opaqueTranscript),
        });
        if (!hasDurableRecordBlobs(existing, { root: canonicalRoot }))
            throw new Error('plan critique callback evidence is incomplete');
        return { state: 'existing', record: existing };
    }
    const parent = record.lineage.pass === 1 ? null : readRecord(record.lineage.parentCritiqueId);
    validatePersistedParent(record, parent);
    const recordDirectory = managedPath(canonicalRoot, ['records'], true);
    const recordName = `${record.critiqueId}.json`;
    const recordContent = Buffer.from(canonicalPlanCritiqueRecordJson(record));
    let state = readPrivateFile(recordDirectory, recordName) === null
        ? undefined
        : publishImmutable(recordDirectory, recordName, recordContent);
    publishBlobSnapshots(canonicalRoot, snapshots);
    state ??= publishImmutable(recordDirectory, recordName, recordContent);
    return { state, record };
}
