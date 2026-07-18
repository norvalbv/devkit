import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonicalJson } from "../deterministic/canonical-json.mjs";
import { evidenceRoot, isPlanCritiqueId, isSha256, readRecord, sha256Text, } from "./evidence-store.mjs";
import { isPlanCritiqueProviderStatus, } from "./provider-lifecycle.mjs";
export const textField = (input, ...keys) => {
    for (const key of keys) {
        const value = input[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return null;
};
export function cursorProviderStatus(provider, input) {
    if (provider !== 'cursor')
        return null;
    const status = textField(input, 'status');
    return status === 'completed' || status === 'aborted' || status === 'error' ? status : 'unknown';
}
function recordFiles() {
    const dir = join(evidenceRoot(), 'records');
    if (!existsSync(dir))
        return [];
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith('.json'))
            .map((name) => join(dir, name));
    }
    catch {
        return [];
    }
}
function lineageFor(workId, repositoryFingerprint) {
    const records = recordFiles()
        .flatMap((path) => {
        try {
            const record = readRecord(basename(path, '.json'));
            return record?.workId === workId && record.repositoryFingerprint === repositoryFingerprint
                ? [record]
                : [];
        }
        catch {
            return [];
        }
    })
        .sort((a, b) => a.lineage.pass - b.lineage.pass ||
        a.capturedAt.localeCompare(b.capturedAt) ||
        a.critiqueId.localeCompare(b.critiqueId));
    const parent = records.at(-1) ?? null;
    return { parentCritiqueId: parent?.critiqueId ?? null, pass: (parent?.lineage.pass ?? 0) + 1 };
}
function observationDocuments() {
    const dir = join(evidenceRoot(), 'observations');
    if (!existsSync(dir))
        return [];
    try {
        return readdirSync(dir).flatMap((name) => {
            if (!name.endsWith('.json'))
                return [];
            try {
                const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
                return typeof value === 'object' && value !== null && !Array.isArray(value)
                    ? [value]
                    : [];
            }
            catch {
                return [];
            }
        });
    }
    catch {
        return [];
    }
}
function captureObservation(document) {
    if (document.schemaVersion !== 1 ||
        document.kind !== 'plan_critique_capture_observation' ||
        !['claude', 'codex', 'cursor'].includes(document.provider) ||
        !isPlanCritiqueProviderStatus(document.providerStatus) ||
        !isPlanCritiqueId(document.observationId) ||
        !isPlanCritiqueId(document.critiqueId) ||
        !isSha256(document.workId) ||
        !isSha256(document.providerInvocationHash) ||
        !isSha256(document.repositoryFingerprint) ||
        !['explicit', 'turn', 'stop_bounded_session', 'invocation'].includes(document.identityCapability) ||
        !Number.isInteger(document.captureOrdinal) ||
        document.captureOrdinal < 1 ||
        !Number.isInteger(document.pass) ||
        document.pass < 1 ||
        (document.parentCritiqueId !== null && !isPlanCritiqueId(document.parentCritiqueId)) ||
        (document.providerSessionHash !== null && !isSha256(document.providerSessionHash)) ||
        (document.providerTurnHash !== null && !isSha256(document.providerTurnHash)) ||
        typeof document.capturedAt !== 'string' ||
        !Number.isFinite(Date.parse(document.capturedAt)))
        return null;
    return document;
}
export function providerSessionHash(provider, input) {
    const source = provider === 'cursor'
        ? textField(input, 'conversation_id', 'session_id')
        : textField(input, 'session_id');
    return source ? sha256Text(`${provider}:session:${source}`) : null;
}
export function reliableTurnHash(provider, input) {
    if (provider === 'codex') {
        const turn = textField(input, 'turn_id');
        return turn ? sha256Text(`codex:turn:${turn}`) : null;
    }
    if (provider !== 'cursor')
        return null;
    const generation = textField(input, 'generation_id');
    return generation ? sha256Text(`cursor:generation:${generation}`) : null;
}
function invocationHash(provider, input) {
    const source = textField(input, 'agent_id', 'subagent_id', 'tool_call_id', 'agent_transcript_path');
    const identity = source ? `provider-id:${source}` : `payload:${canonicalJson(input)}`;
    return sha256Text(`${provider}:invocation:${identity}`);
}
export function captureObservations(provider, input, repositoryFingerprint) {
    const sessionHash = providerSessionHash(provider, input);
    const turnHash = reliableTurnHash(provider, input);
    const explicitWork = process.env.DEVKIT_WORK_ID
        ? sha256Text(`explicit:${process.env.DEVKIT_WORK_ID}`)
        : null;
    if (!explicitWork && (provider === 'claude' ? !sessionHash : !turnHash))
        return [];
    const documents = observationDocuments();
    const consumed = new Set(documents.flatMap((document) => Array.isArray(document.consumedCaptureIds)
        ? document.consumedCaptureIds.filter(isPlanCritiqueId)
        : []));
    return documents
        .flatMap((document) => {
        const capture = captureObservation(document);
        if (!capture || capture.provider !== provider)
            return [];
        const sameScope = explicitWork
            ? capture.identityCapability === 'explicit' && capture.workId === explicitWork
            : turnHash
                ? capture.providerTurnHash === turnHash
                : capture.providerSessionHash === sessionHash;
        return sameScope &&
            capture.repositoryFingerprint === repositoryFingerprint &&
            !consumed.has(capture.observationId)
            ? [capture]
            : [];
    })
        .sort((a, b) => a.captureOrdinal - b.captureOrdinal || a.observationId.localeCompare(b.observationId));
}
export function captureByInvocation(provider, repositoryFingerprint, providerInvocationHash, providerSessionHash, providerTurnHash) {
    return (observationDocuments()
        .map(captureObservation)
        .filter((capture) => capture !== null &&
        capture.provider === provider &&
        capture.repositoryFingerprint === repositoryFingerprint &&
        capture.providerInvocationHash === providerInvocationHash &&
        capture.providerSessionHash === providerSessionHash &&
        capture.providerTurnHash === providerTurnHash)
        .sort((a, b) => a.captureOrdinal - b.captureOrdinal || a.observationId.localeCompare(b.observationId))
        .at(-1) ?? null);
}
/** Lock-assigned monotonic ordering avoids timestamp/UUID tie ambiguity. */
export function nextCaptureOrdinal() {
    return (observationDocuments().reduce((maximum, document) => {
        if (document.kind !== 'plan_critique_capture_observation' ||
            !Number.isInteger(document.captureOrdinal))
            return maximum;
        return Math.max(maximum, document.captureOrdinal);
    }, 0) + 1);
}
function continuesReviewChain(critiqueId) {
    const record = readRecord(critiqueId);
    if (!record)
        return false;
    if (record.lineage.pass >= 2)
        return true;
    const response = record.exactResponse;
    const verdict = typeof response === 'object' && response !== null && !Array.isArray(response)
        ? response.verdict
        : null;
    return record.contract.criticalCount > 0 || verdict === 'RETHINK' || verdict === 'REJECT';
}
export function workIdentity(provider, input, repositoryFingerprint) {
    const sessionHash = providerSessionHash(provider, input);
    const turnHash = reliableTurnHash(provider, input);
    const invocation = invocationHash(provider, input);
    const explicit = process.env.DEVKIT_WORK_ID;
    let capability;
    let workId;
    if (explicit) {
        capability = 'explicit';
        workId = sha256Text(`explicit:${explicit}`);
    }
    else if (turnHash) {
        capability = 'turn';
        workId = turnHash;
    }
    else if (provider === 'claude' && sessionHash) {
        const latest = captureObservations(provider, input, repositoryFingerprint).at(-1);
        if (latest && continuesReviewChain(latest.critiqueId)) {
            capability = 'stop_bounded_session';
            workId = latest.workId;
        }
        else {
            capability = 'invocation';
            workId = invocation;
        }
    }
    else {
        capability = 'invocation';
        workId = invocation;
    }
    let lineage = lineageFor(workId, repositoryFingerprint);
    if (lineage.parentCritiqueId && !continuesReviewChain(lineage.parentCritiqueId)) {
        capability = 'invocation';
        workId = invocation;
        lineage = lineageFor(workId, repositoryFingerprint);
    }
    return {
        workId,
        providerSessionHash: sessionHash,
        providerTurnHash: turnHash,
        providerInvocationHash: invocation,
        identityCapability: capability,
        ...lineage,
    };
}
