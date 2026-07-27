import { assertPlanCritiquePayloadRefs, canonicalPlanCritiqueRecordJson, derivePlanCritiqueId, PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES, PLAN_CRITIQUE_INELIGIBLE_REASONS, PLAN_CRITIQUE_PROJECTION_MAX_BYTES, PLAN_CRITIQUE_PROVIDERS, PLAN_CRITIQUE_STATUSES, PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES, PLAN_CRITIQUE_VERDICTS, assertPlanCritiqueRecordValue as requireValue, sha256Bytes, snapshotPlanCritiquePayloads, } from "./evidence-record.mjs";
import { hasDurableRecordBlobs, persistPlanCritiqueRecordAtRoot, readStoredBlob, } from "./evidence-store-internal.mjs";
import { listPrivateFiles, managedPath, readPrivateFile } from "./immutable-file.mjs";
import { resolvePlanCritiqueEvidenceRoot, withPlanCritiquePersistenceLock, } from "./persistence-lock.mjs";
export { derivePlanCritiqueId, PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES, PLAN_CRITIQUE_PROJECTION_MAX_BYTES, } from "./evidence-record.mjs";
const SHA = /^[0-9a-f]{64}$/;
const ID = /^pc1_[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_FILE = /^pc1_[0-9a-f]{64}\.json$/;
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_CRITICAL_FINDINGS = 50;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactObject(value, fields, at, optionalFields = []) {
    requireValue(isObject(value), at);
    const object = value;
    const prototype = Object.getPrototypeOf(object);
    requireValue(prototype === Object.prototype || prototype === null, at);
    requireValue(!('toJSON' in object), at);
    const keys = Reflect.ownKeys(object);
    const allowed = [...fields, ...optionalFields];
    requireValue(fields.every((field) => Object.hasOwn(object, field)) &&
        keys.every((key) => typeof key === 'string' && allowed.includes(key)), at);
    for (const key of keys) {
        requireValue(typeof key === 'string', at);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        requireValue(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), `${at}.${key}`);
    }
    return object;
}
function metadataText(value, at) {
    const containsControl = typeof value === 'string' &&
        [...value].some((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        });
    requireValue(typeof value === 'string' &&
        value.trim().length > 0 &&
        Buffer.byteLength(value, 'utf8') <= MAX_METADATA_BYTES &&
        !containsControl, at);
    return value;
}
function oneOf(value, allowed, at) {
    requireValue(typeof value === 'string' && allowed.includes(value), at);
    return value;
}
function sha256(value, at) {
    requireValue(typeof value === 'string' && SHA.test(value), at);
    return value;
}
function timestamp(value, at) {
    const text = metadataText(value, at);
    const milliseconds = Date.parse(text);
    requireValue(ISO_TIMESTAMP.test(text) &&
        Number.isFinite(milliseconds) &&
        new Date(milliseconds).toISOString() === text, at);
    return text;
}
function positiveInteger(value, at) {
    requireValue(Number.isSafeInteger(value) && Number(value) > 0, at);
    return value;
}
function nonnegativeInteger(value, at, max = Number.MAX_SAFE_INTEGER) {
    requireValue(Number.isSafeInteger(value) &&
        !Object.is(value, -0) &&
        Number(value) >= 0 &&
        Number(value) <= max, at);
    return value;
}
function validateRef(value, at, maxBytes = PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES) {
    const ref = exactObject(value, ['sha256', 'byteLength', 'ref'], at);
    const hash = sha256(ref.sha256, `${at}.sha256`);
    nonnegativeInteger(ref.byteLength, `${at}.byteLength`, maxBytes);
    requireValue(ref.ref === `blobs/sha256/${hash}`, `${at}.ref`);
}
function validateInvalidContract(contract) {
    requireValue(contract.error !== null, '$.contract.error');
    requireValue(contract.status === null, '$.contract.status');
    requireValue(contract.verdict === null, '$.contract.verdict');
    requireValue(contract.criticalCount === null, '$.contract.criticalCount');
    requireValue(!contract.eligibility.eligible && contract.eligibility.reason === 'invalid_contract', '$.contract.eligibility');
}
function validateUnreviewedContract(contract, status) {
    requireValue(contract.verdict === null, '$.contract.verdict');
    requireValue(contract.criticalCount === null, '$.contract.criticalCount');
    requireValue(!contract.eligibility.eligible && contract.eligibility.reason === status, '$.contract.eligibility');
}
function validateReviewedContract(record) {
    const { contract } = record;
    requireValue(contract.verdict !== null, '$.contract.verdict');
    requireValue(contract.criticalCount !== null, '$.contract.criticalCount');
    if (contract.verdict === 'PROCEED')
        requireValue(contract.criticalCount === 0, '$.contract.criticalCount');
    if (contract.verdict === 'RETHINK' || contract.verdict === 'REJECT')
        requireValue(contract.criticalCount > 0, '$.contract.criticalCount');
    const expectedEligibility = contract.verdict === 'RETHINK' || contract.verdict === 'REJECT'
        ? { eligible: false, reason: 'blocking_verdict' }
        : contract.criticalCount > 0
            ? { eligible: false, reason: 'critical_findings' }
            : record.lineage.pass > 2
                ? { eligible: false, reason: 'retry_limit_exceeded' }
                : record.lineage.pass === 2 &&
                    !contract.eligibility.eligible &&
                    contract.eligibility.reason === 'unnecessary_recheck'
                    ? { eligible: false, reason: 'unnecessary_recheck' }
                    : { eligible: true, reason: 'eligible' };
    requireValue(contract.eligibility.eligible === expectedEligibility.eligible &&
        contract.eligibility.reason === expectedEligibility.reason, '$.contract.eligibility');
}
function validateContract(record) {
    const { contract } = record;
    if (contract.state === 'invalid') {
        validateInvalidContract(contract);
        return;
    }
    requireValue(contract.error === null, '$.contract.error');
    requireValue(contract.status !== null, '$.contract.status');
    if (contract.status === 'wrong_phase' || contract.status === 'aborted') {
        validateUnreviewedContract(contract, contract.status);
        return;
    }
    validateReviewedContract(record);
}
function validateLineage(value) {
    const lineage = exactObject(value, ['pass', 'parentCritiqueId'], '$.lineage');
    const pass = positiveInteger(lineage.pass, '$.lineage.pass');
    requireValue(pass === 1
        ? lineage.parentCritiqueId === null
        : typeof lineage.parentCritiqueId === 'string' && ID.test(lineage.parentCritiqueId), '$.lineage.parentCritiqueId');
}
function validateExecution(value) {
    const execution = exactObject(value, ['provider', 'callbackHash', 'model', 'modelHash', 'promptHash'], '$.execution');
    oneOf(execution.provider, PLAN_CRITIQUE_PROVIDERS, '$.execution.provider');
    sha256(execution.callbackHash, '$.execution.callbackHash');
    const model = execution.model === null ? null : metadataText(execution.model, '$.execution.model');
    const modelHash = execution.modelHash === null ? null : sha256(execution.modelHash, '$.execution.modelHash');
    requireValue((model === null) === (modelHash === null), '$.execution.modelHash');
    if (model !== null && modelHash !== null)
        requireValue(modelHash === sha256Bytes(Buffer.from(model)), '$.execution.modelHash');
    if (execution.promptHash !== null)
        sha256(execution.promptHash, '$.execution.promptHash');
}
function validateRepository(value) {
    const repository = exactObject(value, ['fingerprint', 'fingerprintSource', 'branch', 'head'], '$.repository');
    sha256(repository.fingerprint, '$.repository.fingerprint');
    oneOf(repository.fingerprintSource, ['canonical_remote', 'local_path'], '$.repository.fingerprintSource');
    if (repository.branch !== null)
        metadataText(repository.branch, '$.repository.branch');
    requireValue(repository.head === null ||
        (typeof repository.head === 'string' && GIT_OBJECT_ID.test(repository.head)), '$.repository.head');
}
function validateTimestamps(value) {
    const timestamps = exactObject(value, ['capturedAt', 'providerCompletedAt'], '$.timestamps');
    const capturedAt = timestamp(timestamps.capturedAt, '$.timestamps.capturedAt');
    if (timestamps.providerCompletedAt !== null) {
        const providerCompletedAt = timestamp(timestamps.providerCompletedAt, '$.timestamps.providerCompletedAt');
        requireValue(Date.parse(providerCompletedAt) <= Date.parse(capturedAt), '$.timestamps.providerCompletedAt');
    }
    return capturedAt;
}
function validateContractShape(value) {
    const contract = exactObject(value, ['state', 'error', 'status', 'verdict', 'criticalCount', 'eligibility'], '$.contract');
    oneOf(contract.state, ['valid', 'invalid'], '$.contract.state');
    if (contract.error !== null) {
        const error = exactObject(contract.error, ['code', 'path'], '$.contract.error');
        metadataText(error.code, '$.contract.error.code');
        metadataText(error.path, '$.contract.error.path');
    }
    if (contract.status !== null)
        oneOf(contract.status, PLAN_CRITIQUE_STATUSES, '$.contract.status');
    if (contract.verdict !== null)
        oneOf(contract.verdict, PLAN_CRITIQUE_VERDICTS, '$.contract.verdict');
    if (contract.criticalCount !== null)
        nonnegativeInteger(contract.criticalCount, '$.contract.criticalCount', MAX_CRITICAL_FINDINGS);
    const eligibility = exactObject(contract.eligibility, ['eligible', 'reason'], '$.contract.eligibility');
    requireValue(typeof eligibility.eligible === 'boolean', '$.contract.eligibility.eligible');
    if (eligibility.eligible)
        requireValue(eligibility.reason === 'eligible', '$.contract.eligibility.reason');
    else
        oneOf(eligibility.reason, PLAN_CRITIQUE_INELIGIBLE_REASONS, '$.contract.eligibility.reason');
}
function validateEvidenceRefs(root, capturedAt) {
    validateRef(root.exactResponse, '$.exactResponse', PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES);
    if (root.sanitizedProjection !== null) {
        const projection = exactObject(root.sanitizedProjection, ['sha256', 'byteLength', 'ref', 'projectionSchemaVersion'], '$.sanitizedProjection');
        validateRef({ sha256: projection.sha256, byteLength: projection.byteLength, ref: projection.ref }, '$.sanitizedProjection', PLAN_CRITIQUE_PROJECTION_MAX_BYTES);
        requireValue(projection.projectionSchemaVersion === 1, '$.sanitizedProjection.projectionSchemaVersion');
    }
    if (root.opaqueTranscript === null)
        return;
    const transcript = exactObject(root.opaqueTranscript, ['sha256', 'byteLength', 'ref', 'expiresAt'], '$.opaqueTranscript');
    validateRef({ sha256: transcript.sha256, byteLength: transcript.byteLength, ref: transcript.ref }, '$.opaqueTranscript', PLAN_CRITIQUE_TRANSCRIPT_MAX_BYTES);
    const expiresAt = timestamp(transcript.expiresAt, '$.opaqueTranscript.expiresAt');
    requireValue(Date.parse(expiresAt) > Date.parse(capturedAt), '$.opaqueTranscript.expiresAt');
}
/** @internal Rejects hostile or extended capture inputs before deriving a record. */
export function validatePlanCritiqueCaptureInput(value) {
    const root = exactObject(value, ['workId', 'execution', 'repository', 'providerCompletedAt', 'contract', 'exactResponse'], '$', ['sanitizedProjection', 'opaqueTranscript']);
    exactObject(root.execution, ['provider', 'callbackHash', 'model', 'promptHash'], '$.execution');
    exactObject(root.repository, ['fingerprint', 'fingerprintSource', 'branch', 'head'], '$.repository');
    const contract = exactObject(root.contract, ['state', 'error', 'status', 'verdict', 'criticalCount'], '$.contract');
    if (contract.error !== null)
        exactObject(contract.error, ['code', 'path'], '$.contract.error');
    if (root.opaqueTranscript !== undefined)
        exactObject(root.opaqueTranscript, ['bytes', 'expiresAt'], '$.opaqueTranscript');
}
/** @internal Shared with the capture transaction; callers should use the public store APIs. */
export function validatePlanCritiqueRecord(value) {
    const root = exactObject(value, [
        'schemaVersion',
        'kind',
        'critiqueId',
        'workId',
        'lineage',
        'execution',
        'repository',
        'timestamps',
        'contract',
        'exactResponse',
        'sanitizedProjection',
        'opaqueTranscript',
    ], '$');
    requireValue(root.schemaVersion === 1, '$.schemaVersion');
    requireValue(root.kind === 'plan_critique_record', '$.kind');
    requireValue(typeof root.critiqueId === 'string' && ID.test(root.critiqueId), '$.critiqueId');
    metadataText(root.workId, '$.workId');
    validateLineage(root.lineage);
    validateExecution(root.execution);
    validateRepository(root.repository);
    const capturedAt = validateTimestamps(root.timestamps);
    validateContractShape(root.contract);
    validateEvidenceRefs(root, capturedAt);
    const record = value;
    requireValue(record.critiqueId === derivePlanCritiqueId(record), '$.critiqueId');
    requireValue(record.lineage.parentCritiqueId !== record.critiqueId, '$.lineage.parentCritiqueId');
    validateContract(record);
}
export function persistPlanCritiqueRecord(record, payloads, options = {}) {
    const snapshots = snapshotPlanCritiquePayloads(payloads);
    validatePlanCritiqueRecord(record);
    assertPlanCritiquePayloadRefs(record, snapshots);
    const publish = (canonicalRoot) => {
        const rootOptions = { root: canonicalRoot };
        return persistPlanCritiqueRecordAtRoot(record, snapshots, canonicalRoot, listPlanCritiqueRecordMetadata(rootOptions), (critiqueId) => readPlanCritiqueRecord(critiqueId, rootOptions));
    };
    return withPlanCritiquePersistenceLock(options, publish);
}
export function readPlanCritiqueRecord(critiqueId, options = {}) {
    const record = readPlanCritiqueRecordMetadata(critiqueId, options);
    if (!record)
        return null;
    return hasDurableRecordBlobs(record, options) ? record : null;
}
function readPlanCritiqueRecordMetadata(critiqueId, options = {}) {
    if (!ID.test(critiqueId))
        return null;
    const base = resolvePlanCritiqueEvidenceRoot(options, false);
    const records = base && managedPath(base, ['records'], false);
    if (!records)
        return null;
    const raw = readPrivateFile(records, `${critiqueId}.json`);
    if (!raw)
        return null;
    try {
        const record = JSON.parse(raw.toString('utf8'));
        validatePlanCritiqueRecord(record);
        const canonical = Buffer.from(canonicalPlanCritiqueRecordJson(record));
        if (record.critiqueId !== critiqueId || !raw.equals(canonical))
            return null;
        return record;
    }
    catch {
        return null;
    }
}
/** @internal Includes valid metadata whose durable blobs may be missing. */
export function listPlanCritiqueRecordMetadata(options = {}) {
    const base = resolvePlanCritiqueEvidenceRoot(options, false);
    const records = base && managedPath(base, ['records'], false);
    if (!records)
        return [];
    return listPrivateFiles(records)
        .filter((name) => RECORD_FILE.test(name))
        .map((name) => readPlanCritiqueRecordMetadata(name.slice(0, -5), options))
        .filter((record) => record !== null);
}
export function readPlanCritiqueExactResponse(critiqueId, options = {}) {
    const record = readPlanCritiqueRecord(critiqueId, options);
    return record ? readStoredBlob(record.exactResponse, options) : null;
}
export function readPlanCritiqueProjection(critiqueId, options = {}) {
    const record = readPlanCritiqueRecord(critiqueId, options);
    return record?.sanitizedProjection ? readStoredBlob(record.sanitizedProjection, options) : null;
}
export function readPlanCritiqueTranscript(critiqueId, options = {}) {
    const record = readPlanCritiqueRecord(critiqueId, options);
    if (!record?.opaqueTranscript)
        return null;
    const expiresAt = timestamp(record.opaqueTranscript.expiresAt, '$.opaqueTranscript.expiresAt');
    return Date.parse(expiresAt) > Date.now()
        ? readStoredBlob(record.opaqueTranscript, options)
        : null;
}
export function listPlanCritiqueRecords(options = {}) {
    return listPlanCritiqueRecordMetadata(options).filter((record) => hasDurableRecordBlobs(record, options));
}
