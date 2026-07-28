import { assertPlanCritiquePayloadRefs, derivePlanCritiqueId, sha256Bytes, snapshotPlanCritiquePayloads, } from "./evidence-record.mjs";
import { listPlanCritiqueRecordMetadata, readPlanCritiqueRecord, validatePlanCritiqueCaptureInput, validatePlanCritiqueRecord, } from "./evidence-store.mjs";
import { persistPlanCritiqueRecordAtRoot, selectExistingCallback, } from "./evidence-store-internal.mjs";
import { withPlanCritiquePersistenceLock } from "./persistence-lock.mjs";
function blobRef(payload) {
    const sha256 = sha256Bytes(payload);
    return { sha256, byteLength: payload.byteLength, ref: `blobs/sha256/${sha256}` };
}
function prepareCapture(input) {
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
        ? { ...blobRef(payloads.sanitizedProjection), projectionSchemaVersion: 1 }
        : null;
    const transcriptRef = payloads.opaqueTranscript
        ? { ...blobRef(payloads.opaqueTranscript), expiresAt: transcriptExpiresAt }
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
function selectUniqueLineageParent(records, workId, repositoryFingerprint) {
    const ordered = records
        .filter((record) => record.workId === workId && record.repository.fingerprint === repositoryFingerprint)
        .sort((left, right) => left.lineage.pass === right.lineage.pass
        ? left.critiqueId.localeCompare(right.critiqueId)
        : left.lineage.pass < right.lineage.pass
            ? -1
            : 1);
    for (const [index, record] of ordered.entries()) {
        const expectedPass = index + 1;
        const expectedParent = index === 0 ? null : ordered[index - 1]?.critiqueId;
        if (record.lineage.pass !== expectedPass || record.lineage.parentCritiqueId !== expectedParent)
            throw new Error('ambiguous plan critique lineage');
    }
    return ordered.at(-1) ?? null;
}
function requiresRecheck(record) {
    return (record.contract.state === 'valid' &&
        record.contract.status === 'reviewed' &&
        (record.contract.verdict === 'RETHINK' ||
            record.contract.verdict === 'REJECT' ||
            Number(record.contract.criticalCount) > 0));
}
function deriveEligibility(contract, pass, parent) {
    if (contract.state === 'invalid')
        return { eligible: false, reason: 'invalid_contract' };
    if (contract.status === 'wrong_phase' || contract.status === 'aborted')
        return { eligible: false, reason: contract.status };
    if (contract.verdict === 'RETHINK' || contract.verdict === 'REJECT')
        return { eligible: false, reason: 'blocking_verdict' };
    if (Number(contract.criticalCount) > 0)
        return { eligible: false, reason: 'critical_findings' };
    if (pass > 2)
        return { eligible: false, reason: 'retry_limit_exceeded' };
    if (pass === 2 && parent && !requiresRecheck(parent))
        return { eligible: false, reason: 'unnecessary_recheck' };
    return { eligible: true, reason: 'eligible' };
}
function buildRecord(prepared, parent) {
    const lineage = parent
        ? { pass: parent.lineage.pass + 1, parentCritiqueId: parent.critiqueId }
        : { pass: 1, parentCritiqueId: null };
    const base = {
        schemaVersion: 1,
        kind: 'plan_critique_record',
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
export function capturePlanCritiqueRecord(input, options = {}) {
    validatePlanCritiqueCaptureInput(input);
    const prepared = prepareCapture(input);
    const preflightRecord = buildRecord(prepared, null);
    validatePlanCritiqueRecord(preflightRecord);
    assertPlanCritiquePayloadRefs(preflightRecord, prepared.payloads);
    const capture = (canonicalRoot) => {
        const rootOptions = { root: canonicalRoot };
        const records = listPlanCritiqueRecordMetadata(rootOptions);
        const existing = selectExistingCallback(prepared, records);
        if (existing)
            return persistPlanCritiqueRecordAtRoot(existing, prepared.payloads, canonicalRoot, records, (critiqueId) => readPlanCritiqueRecord(critiqueId, rootOptions));
        const parent = selectUniqueLineageParent(records, prepared.workId, prepared.repository.fingerprint);
        const record = buildRecord(prepared, parent);
        validatePlanCritiqueRecord(record);
        assertPlanCritiquePayloadRefs(record, prepared.payloads);
        return persistPlanCritiqueRecordAtRoot(record, prepared.payloads, canonicalRoot, records, (critiqueId) => readPlanCritiqueRecord(critiqueId, rootOptions));
    };
    return withPlanCritiquePersistenceLock(options, capture);
}
