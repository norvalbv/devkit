import { canonicalPlanCritiqueRecordJson, sha256Bytes, } from "./evidence-record.mjs";
import { readPlanCritiqueRecord } from "./evidence-store.mjs";
import { listPrivateFiles, managedPath, publishImmutable, readPrivateFileBounded, } from "./immutable-file.mjs";
import { getPlanCritiqueWorkQuarantine } from "./lifecycle/work-quarantine.mjs";
import { resolvePlanCritiqueEvidenceRoot, withExistingPlanCritiquePersistenceLock, withPlanCritiquePersistenceLock, } from "./persistence-lock.mjs";
import { getPlanCritiqueRepositoryContext, isPlanCritiqueAncestor, } from "./repository-context.mjs";
export { getPlanCritiqueRepositoryContext, };
const SHA256 = /^[0-9a-f]{64}$/;
const CRITIQUE_ID = /^pc1_[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BINDING_FILE = /^[0-9a-f]{64}\.json$/;
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_BINDING_BYTES = 16 * 1024;
const BINDING_PATH = ['devkit', 'plan-critique-bindings', 'v1'];
const bindingKey = (workId) => sha256Bytes(Buffer.from(workId, 'utf8'));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactObject(value, fields) {
    if (!isObject(value))
        return null;
    const keys = Object.keys(value);
    return keys.length === fields.length && keys.every((key) => fields.includes(key)) ? value : null;
}
function validText(value) {
    return (typeof value === 'string' &&
        value.trim().length > 0 &&
        Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES &&
        ![...value].some((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        }));
}
function canonicalBindingJson(binding) {
    return Buffer.from(canonicalPlanCritiqueRecordJson(binding));
}
function parseBinding(raw, filename) {
    if (raw.byteLength > MAX_BINDING_BYTES || !BINDING_FILE.test(filename))
        return null;
    try {
        const value = JSON.parse(raw.toString('utf8'));
        const root = exactObject(value, [
            'schemaVersion',
            'kind',
            'workId',
            'critiqueId',
            'recordCapturedAt',
            'repository',
        ]);
        if (root?.schemaVersion !== 1 || root.kind !== 'plan_critique_binding')
            return null;
        if (!validText(root.workId) || filename !== `${bindingKey(root.workId)}.json`)
            return null;
        if (typeof root.critiqueId !== 'string' || !CRITIQUE_ID.test(root.critiqueId))
            return null;
        if (typeof root.recordCapturedAt !== 'string' ||
            !ISO_TIMESTAMP.test(root.recordCapturedAt) ||
            new Date(root.recordCapturedAt).toISOString() !== root.recordCapturedAt)
            return null;
        const repository = exactObject(root.repository, [
            'fingerprint',
            'fingerprintSource',
            'branch',
            'head',
        ]);
        if (!repository ||
            typeof repository.fingerprint !== 'string' ||
            !SHA256.test(repository.fingerprint) ||
            (repository.fingerprintSource !== 'canonical_remote' &&
                repository.fingerprintSource !== 'local_path') ||
            !validText(repository.branch) ||
            typeof repository.head !== 'string' ||
            !GIT_OBJECT_ID.test(repository.head))
            return null;
        const binding = value;
        return raw.equals(canonicalBindingJson(binding)) ? binding : null;
    }
    catch {
        return null;
    }
}
function bindingDirectory(context, create) {
    return managedPath(context.gitDir, BINDING_PATH, create);
}
function unavailable(reason, candidates) {
    return { status: 'unavailable', reason, candidates };
}
function differentRepository(left, right) {
    return (left.fingerprint !== right.fingerprint ||
        left.fingerprintSource !== right.fingerprintSource ||
        left.gitDir !== right.gitDir ||
        left.gitCommonDir !== right.gitCommonDir);
}
function evidenceOptions(evidenceRoot) {
    return evidenceRoot === undefined ? {} : { root: evidenceRoot };
}
function bindingFor(record, context) {
    return {
        schemaVersion: 1,
        kind: 'plan_critique_binding',
        workId: record.workId,
        critiqueId: record.critiqueId,
        recordCapturedAt: record.timestamps.capturedAt,
        repository: {
            fingerprint: context.fingerprint,
            fingerprintSource: context.fingerprintSource,
            branch: context.branch,
            head: context.head,
        },
    };
}
function quarantineReason(record, evidenceRoot) {
    const state = getPlanCritiqueWorkQuarantine({
        provider: record.execution.provider,
        repositoryFingerprint: record.repository.fingerprint,
        workId: record.workId,
    }, { root: evidenceRoot });
    if (state.status === 'clear')
        return null;
    return state.status === 'quarantined' ? 'work_quarantined' : 'malformed_quarantine';
}
export function persistPlanCritiqueBinding(critiqueId, options = {}) {
    const repository = getPlanCritiqueRepositoryContext(options.cwd);
    if (repository.status === 'unavailable')
        return repository;
    let evidenceRoot;
    try {
        evidenceRoot = resolvePlanCritiqueEvidenceRoot(evidenceOptions(options.evidenceRoot), false);
    }
    catch {
        evidenceRoot = null;
    }
    if (!evidenceRoot)
        return { status: 'unavailable', reason: 'malformed_record' };
    const publish = (canonicalRoot) => {
        let record;
        try {
            record = readPlanCritiqueRecord(critiqueId, { root: canonicalRoot });
        }
        catch {
            record = null;
        }
        if (!record)
            return { status: 'unavailable', reason: 'malformed_record' };
        const { context } = repository;
        if (record.repository.fingerprint !== context.fingerprint ||
            record.repository.fingerprintSource !== context.fingerprintSource)
            return { status: 'unavailable', reason: 'repository_mismatch' };
        if (record.repository.branch !== context.branch)
            return { status: 'unavailable', reason: 'branch_mismatch' };
        if (record.repository.head !== context.head)
            return { status: 'unavailable', reason: 'ancestry_mismatch' };
        if (!record.contract.eligibility.eligible)
            return { status: 'unavailable', reason: 'ineligible_record' };
        const quarantine = quarantineReason(record, canonicalRoot);
        if (quarantine)
            return { status: 'unavailable', reason: quarantine };
        const binding = bindingFor(record, context);
        const directory = bindingDirectory(context, true);
        const state = publishImmutable(directory, `${bindingKey(binding.workId)}.json`, canonicalBindingJson(binding));
        return { status: 'bound', state, binding };
    };
    return withPlanCritiquePersistenceLock({ root: evidenceRoot }, publish);
}
function loadBindings(context, workId) {
    const directory = bindingDirectory(context, false);
    if (!directory)
        return { bindings: [], candidates: 0, malformed: false };
    const names = workId === undefined ? listPrivateFiles(directory) : [`${bindingKey(workId)}.json`];
    const bindings = [];
    let candidates = 0;
    for (const name of names) {
        let raw;
        try {
            raw = readPrivateFileBounded(directory, name, MAX_BINDING_BYTES);
        }
        catch {
            return { bindings: [], candidates: candidates + 1, malformed: true };
        }
        if (!raw)
            continue;
        candidates += 1;
        const binding = parseBinding(raw, name);
        if (!binding || (workId !== undefined && binding.workId !== workId))
            return { bindings: [], candidates, malformed: true };
        bindings.push(binding);
    }
    return { bindings, candidates, malformed: false };
}
function selectBinding(context, workId) {
    let loaded;
    try {
        loaded = loadBindings(context, workId);
    }
    catch {
        return { status: 'unavailable', reason: 'malformed_binding', candidates: 0 };
    }
    const { bindings, candidates, malformed } = loaded;
    if (malformed)
        return { status: 'unavailable', reason: 'malformed_binding', candidates };
    if (bindings.length === 0)
        return { status: 'unavailable', reason: 'no_matching_binding', candidates: 0 };
    if (bindings.length !== 1)
        return { status: 'unavailable', reason: 'ambiguous_matching_bindings', candidates };
    return { status: 'selected', binding: bindings[0], candidates: 1 };
}
export function resolvePlanCritiqueBinding(options = {}) {
    const workId = options.workId;
    if (workId !== undefined && !validText(workId))
        return unavailable('malformed_binding', 0);
    const preflightRepository = getPlanCritiqueRepositoryContext(options.cwd);
    if (preflightRepository.status === 'unavailable')
        return { ...preflightRepository, candidates: 0 };
    const preflight = selectBinding(preflightRepository.context, workId);
    if (preflight.status === 'unavailable')
        return preflight;
    const { binding: preflightBinding, candidates: preflightCandidates } = preflight;
    const { context: preflightContext } = preflightRepository;
    if (preflightBinding.repository.fingerprint !== preflightContext.fingerprint ||
        preflightBinding.repository.fingerprintSource !== preflightContext.fingerprintSource)
        return unavailable('repository_mismatch', preflightCandidates);
    if (preflightBinding.repository.branch !== preflightContext.branch)
        return unavailable('branch_mismatch', preflightCandidates);
    let evidenceRoot;
    try {
        evidenceRoot = resolvePlanCritiqueEvidenceRoot(evidenceOptions(options.evidenceRoot), false);
    }
    catch {
        evidenceRoot = null;
    }
    if (!evidenceRoot)
        return unavailable('malformed_record', 1);
    const resolution = {
        state: 'not_started',
        result: undefined,
    };
    const resolveLocked = (evidenceRoot) => {
        const repository = getPlanCritiqueRepositoryContext(options.cwd);
        if (repository.status === 'unavailable')
            return { ...repository, candidates: 1 };
        if (differentRepository(preflightRepository.context, repository.context))
            return unavailable('repository_mismatch', 1);
        if (preflightRepository.context.branch !== repository.context.branch)
            return unavailable('branch_mismatch', 1);
        const selected = selectBinding(repository.context, workId);
        if (selected.status === 'unavailable')
            return selected;
        const { binding, candidates } = selected;
        const { context } = repository;
        if (binding.repository.fingerprint !== context.fingerprint ||
            binding.repository.fingerprintSource !== context.fingerprintSource)
            return unavailable('repository_mismatch', candidates);
        if (binding.repository.branch !== context.branch)
            return unavailable('branch_mismatch', candidates);
        if (!isPlanCritiqueAncestor(options.cwd ?? process.cwd(), binding.repository.head, context.head))
            return unavailable('ancestry_mismatch', candidates);
        let record;
        try {
            record = readPlanCritiqueRecord(binding.critiqueId, { root: evidenceRoot });
        }
        catch {
            record = null;
        }
        if (!record ||
            record.critiqueId !== binding.critiqueId ||
            record.workId !== binding.workId ||
            record.timestamps.capturedAt !== binding.recordCapturedAt ||
            record.repository.fingerprint !== binding.repository.fingerprint ||
            record.repository.fingerprintSource !== binding.repository.fingerprintSource ||
            record.repository.branch !== binding.repository.branch ||
            record.repository.head !== binding.repository.head)
            return unavailable('malformed_record', candidates);
        if (!record.contract.eligibility.eligible)
            return unavailable('ineligible_record', candidates);
        const revalidated = getPlanCritiqueRepositoryContext(options.cwd);
        if (revalidated.status === 'unavailable')
            return { ...revalidated, candidates };
        if (differentRepository(context, revalidated.context))
            return unavailable('repository_mismatch', candidates);
        if (revalidated.context.branch !== context.branch)
            return unavailable('branch_mismatch', candidates);
        if (revalidated.context.head !== context.head)
            return unavailable('ancestry_mismatch', candidates);
        const quarantine = quarantineReason(record, evidenceRoot);
        if (quarantine)
            return unavailable(quarantine, candidates);
        return { status: 'resolved', binding, record };
    };
    const resolve = (evidenceRoot) => {
        resolution.state = 'running';
        const result = resolveLocked(evidenceRoot);
        resolution.result = result;
        resolution.state = 'completed';
        return result;
    };
    try {
        const transaction = withExistingPlanCritiquePersistenceLock({ root: evidenceRoot }, resolve);
        if (transaction.status === 'absent')
            return unavailable('malformed_record', 1);
        return transaction.value;
    }
    catch (error) {
        if (resolution.state === 'running')
            throw error;
        if (resolution.state === 'completed' && resolution.result)
            return resolution.result;
        return unavailable('evidence_lock_unavailable', 1);
    }
}
