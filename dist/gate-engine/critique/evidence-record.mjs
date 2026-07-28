import { createHash } from 'node:crypto';
export const PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES = 512 * 1024;
export const PLAN_CRITIQUE_PROJECTION_MAX_BYTES = 8 * 1024;
export const PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
export const PLAN_CRITIQUE_PROVIDERS = ['claude', 'codex', 'cursor'];
export const PLAN_CRITIQUE_STATUSES = ['reviewed', 'wrong_phase', 'aborted'];
export const PLAN_CRITIQUE_VERDICTS = [
    'PROCEED',
    'PROCEED_WITH_CHANGES',
    'RETHINK',
    'REJECT',
];
export const PLAN_CRITIQUE_INELIGIBLE_REASONS = [
    'invalid_contract',
    'wrong_phase',
    'aborted',
    'blocking_verdict',
    'critical_findings',
    'unnecessary_recheck',
    'retry_limit_exceeded',
];
export const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex');
const invalid = (at) => {
    throw new Error(`invalid plan critique record: ${at}`);
};
export function assertPlanCritiqueRecordValue(condition, at) {
    if (!condition)
        invalid(at);
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
function snapshotPayload(value, at, maxBytes) {
    const byteLengthGetter = typedArrayByteLength;
    if (!byteLengthGetter)
        return invalid(at);
    let byteLength;
    try {
        byteLength = Reflect.apply(byteLengthGetter, value, []);
    }
    catch {
        return invalid(at);
    }
    if (byteLength > maxBytes)
        invalid(at);
    const snapshot = Buffer.allocUnsafe(byteLength);
    try {
        Reflect.apply(Uint8Array.prototype.set, snapshot, [value]);
    }
    catch {
        return invalid(at);
    }
    if (snapshot.byteLength !== byteLength || snapshot.byteLength > maxBytes)
        invalid(at);
    return snapshot;
}
export function snapshotPlanCritiquePayloads(payloads) {
    const exactResponse = payloads.exactResponse;
    const sanitizedProjection = payloads.sanitizedProjection;
    const opaqueTranscript = payloads.opaqueTranscript;
    return {
        exactResponse: snapshotPayload(exactResponse, '$.exactResponse payload', PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES),
        sanitizedProjection: sanitizedProjection === undefined
            ? undefined
            : snapshotPayload(sanitizedProjection, '$.sanitizedProjection payload', PLAN_CRITIQUE_PROJECTION_MAX_BYTES),
        opaqueTranscript: opaqueTranscript === undefined
            ? undefined
            : snapshotPayload(opaqueTranscript, '$.opaqueTranscript payload', PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES),
    };
}
function assertPayload(ref, payload, at, maxBytes) {
    if ((ref === null) !== (payload === undefined))
        invalid(at);
    if (!ref || !payload)
        return;
    if (payload.byteLength > maxBytes ||
        ref.byteLength > maxBytes ||
        ref.sha256 !== sha256Bytes(payload) ||
        ref.byteLength !== payload.byteLength)
        invalid(at);
}
export function assertPlanCritiquePayloadRefs(record, payloads) {
    assertPayload(record.exactResponse, payloads.exactResponse, '$.exactResponse payload', PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES);
    assertPayload(record.sanitizedProjection, payloads.sanitizedProjection, '$.sanitizedProjection payload', PLAN_CRITIQUE_PROJECTION_MAX_BYTES);
    assertPayload(record.opaqueTranscript, payloads.opaqueTranscript, '$.opaqueTranscript payload', PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES);
}
export function derivePlanCritiqueId(value) {
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
export function canonicalPlanCritiqueRecordJson(value) {
    return `${JSON.stringify(value, (_key, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return item;
        return Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    })}\n`;
}
