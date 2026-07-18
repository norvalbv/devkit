import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { critiqueEligibility } from "./contract.mjs";
import { evidenceRoot, isPlanCritiqueBlobPath, isPlanCritiqueId, isSha256, sha256Text, withEvidenceLock, writeContentBlob, } from "./evidence-files.mjs";
import { atomicWrite } from "./immutable-file.mjs";
export { evidenceRoot, isPlanCritiqueBlobPath, isPlanCritiqueId, isSha256, persistImmutableJson, sha256Text, withEvidenceLock, writeContentBlob, } from "./evidence-files.mjs";
const RECORD_VERSION = 1;
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[^\s,;]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const EXACT_RESPONSE_RAW = Symbol('planCritiqueExactResponseRaw');
function sanitizeString(value) {
    const withoutControls = [...value]
        .filter((character) => {
        const code = character.charCodeAt(0);
        return !(code <= 8 ||
            code === 11 ||
            code === 12 ||
            (code >= 14 && code <= 31) ||
            code === 127);
    })
        .join('');
    return withoutControls
        .replace(SECRET_VALUE, '[REDACTED]')
        .replace(URL_CREDENTIALS, '$1[REDACTED]@')
        .trim();
}
export function sanitizeEvidenceValue(value, key = '') {
    if (SECRET_KEY.test(key))
        return '[REDACTED]';
    if (typeof value === 'string')
        return sanitizeString(value);
    if (Array.isArray(value))
        return value.map((item) => sanitizeEvidenceValue(item));
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
            childKey,
            sanitizeEvidenceValue(child, childKey),
        ]));
    }
    return value;
}
function fitProjection(projection, maxBytes) {
    const size = () => Buffer.byteLength(JSON.stringify(projection), 'utf8');
    while (size() > maxBytes && projection.actions.length > 0) {
        projection.actions.pop();
        projection.truncated = true;
    }
    if (size() > maxBytes && projection.summary.length > 0) {
        projection.summary = '';
        projection.truncated = true;
    }
    while (size() > maxBytes && projection.edgeCases.length > 0) {
        projection.edgeCases.pop();
        projection.truncated = true;
    }
    while (size() > maxBytes && projection.findings.length > 0) {
        projection.findings.pop();
        projection.truncated = true;
    }
    return projection;
}
/** Allowlisted, control-character-free context. It never contains evidence prose or transcripts. */
export function buildProjection(critiqueId, value, maxItems = 25, maxBytes = 8 * 1024) {
    let remaining = maxItems;
    const findings = value.findings.slice(0, remaining).map((finding) => ({
        severity: sanitizeString(finding.severity),
        lens: sanitizeString(finding.lens),
        claim: sanitizeString(finding.claim),
        impact: sanitizeString(finding.impact),
        recommendation: sanitizeString(finding.recommendation),
    }));
    remaining -= findings.length;
    const edgeCases = value.edgeCases.slice(0, remaining).map((edgeCase) => ({
        risk: sanitizeString(edgeCase.risk),
        scenario: sanitizeString(edgeCase.scenario),
        expectedBehavior: sanitizeString(edgeCase.expectedBehavior),
        testType: sanitizeString(edgeCase.testType),
    }));
    remaining -= edgeCases.length;
    const actions = value.actions.slice(0, remaining).map(sanitizeString);
    const truncated = findings.length < value.findings.length ||
        edgeCases.length < value.edgeCases.length ||
        actions.length < value.actions.length;
    return fitProjection({
        schemaVersion: 1,
        kind: 'plan_critique_projection',
        critiqueId,
        verdict: value.verdict,
        summary: sanitizeString(value.summary),
        findings,
        edgeCases,
        actions,
        truncated,
    }, maxBytes);
}
/** Commit-shadow context excludes summaries, actions, raw evidence, prompts, and transcripts. */
export function buildCommitProjection(projection) {
    return {
        schemaVersion: 1,
        kind: 'plan_critique_commit_projection',
        critiqueId: projection.critiqueId,
        verdict: projection.verdict,
        findings: projection.findings,
        edgeCases: projection.edgeCases,
        truncated: projection.truncated,
    };
}
export function recordPath(critiqueId) {
    if (!isPlanCritiqueId(critiqueId))
        throw new Error('invalid plan critique id');
    return join(evidenceRoot(), 'records', `${critiqueId}.json`);
}
export function readRecord(critiqueId) {
    if (!isPlanCritiqueId(critiqueId))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(recordPath(critiqueId), 'utf8'));
        return parsed.schemaVersion === 1 && parsed.kind === 'plan_critique_record' ? parsed : null;
    }
    catch {
        return null;
    }
}
export function persistRecord(record) {
    return withEvidenceLock(() => {
        const prepared = record;
        const exactRaw = prepared[EXACT_RESPONSE_RAW];
        if (!isPlanCritiqueId(record.critiqueId))
            throw new Error('invalid plan critique id');
        if (!isSha256(record.responseHash))
            throw new Error('invalid plan critique response hash');
        const expectedExactBlob = `blobs/${record.responseHash}.json`;
        if (record.exactResponseBlob !== expectedExactBlob)
            throw new Error('exact response blob does not match the response hash');
        const exactPath = join(evidenceRoot(), record.exactResponseBlob);
        if (!existsSync(exactPath)) {
            if (typeof exactRaw !== 'string' || sha256Text(exactRaw) !== record.responseHash)
                throw new Error('exact response blob is unavailable for this record');
            writeContentBlob(exactRaw, 'json');
        }
        if (record.transcriptBlob) {
            if (!isPlanCritiqueBlobPath(record.transcriptBlob))
                throw new Error('transcript blob path is invalid for this record');
            if (!existsSync(join(evidenceRoot(), record.transcriptBlob)))
                throw new Error('transcript blob is unavailable for this record');
        }
        const path = recordPath(record.critiqueId);
        atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
        return path;
    });
}
export function makeRecord(input) {
    const critiqueId = randomUUID();
    const eligibility = critiqueEligibility(input.contract);
    const pass = input.pass ?? 1;
    const retryLimitExceeded = pass > 2;
    const record = {
        schemaVersion: RECORD_VERSION,
        kind: 'plan_critique_record',
        critiqueId,
        workId: input.workId,
        lineage: {
            pass,
            parentCritiqueId: input.parentCritiqueId ?? null,
        },
        provider: input.provider,
        model: input.model ?? null,
        modelHash: input.model ? sha256Text(input.model) : null,
        promptHash: input.prompt ? sha256Text(input.prompt) : null,
        responseHash: sha256Text(input.contract.exactRaw),
        exactResponseBlob: `blobs/${sha256Text(input.contract.exactRaw)}.json`,
        transcriptBlob: input.transcriptBlob ?? null,
        transcriptExpiresAt: input.transcriptExpiresAt ?? null,
        repositoryFingerprint: input.context.repositoryFingerprint,
        repositoryLocator: input.context.repositoryLocator,
        branch: input.context.branch,
        head: input.context.head,
        capturedAt: new Date().toISOString(),
        completedAt: input.completedAt ?? null,
        contract: {
            state: input.contract.state,
            errors: input.contract.errors,
            eligible: eligibility.eligible && !retryLimitExceeded,
            eligibilityReason: retryLimitExceeded ? 'retry_limit_exceeded' : eligibility.reason,
            criticalCount: eligibility.criticalCount,
        },
        // The exact parsed response is retained for reproducibility. Consumers must use only the
        // allowlisted sanitizedProjection below; exactResponse is never injected into another prompt.
        exactResponse: input.contract.exactResponse,
        sanitizedProjection: input.contract.value && input.contract.state === 'valid'
            ? buildProjection(critiqueId, input.contract.value)
            : null,
    };
    // The non-enumerable symbol is omitted from JSON and structural comparisons, so persistRecord
    // can publish the exact-response blob and record in one lock without storing a second raw body.
    Object.defineProperty(record, EXACT_RESPONSE_RAW, { value: input.contract.exactRaw });
    return record;
}
function evidenceFiles(path) {
    try {
        return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
            if (entry.name === '.operation-lock')
                return [];
            const child = join(path, entry.name);
            if (entry.isDirectory())
                return evidenceFiles(child);
            return entry.isFile() ? [child] : [];
        });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
function collectBlobReferences(value, key = '', output = new Set()) {
    if (key.endsWith('Blob') && isPlanCritiqueBlobPath(value))
        output.add(value);
    else if (Array.isArray(value))
        for (const item of value)
            collectBlobReferences(item, key, output);
    else if (typeof value === 'object' && value !== null)
        for (const [childKey, child] of Object.entries(value))
            collectBlobReferences(child, childKey, output);
    return output;
}
function storedTimestamp(value, fallback) {
    if (typeof value !== 'object' || value === null)
        return fallback;
    const item = value;
    for (const key of ['capturedAt', 'observedAt', 'createdAt', 'completedAt']) {
        const timestamp = typeof item[key] === 'string' ? Date.parse(item[key]) : Number.NaN;
        if (Number.isFinite(timestamp))
            return timestamp;
    }
    return fallback;
}
export function purgePlanCritiqueEvidence(options = {}) {
    return withEvidenceLock(() => {
        const root = evidenceRoot();
        if (!existsSync(root))
            return { files: 0, bytes: 0 };
        const paths = evidenceFiles(root);
        if (options.olderThanMs === undefined) {
            const stats = paths.flatMap((path) => {
                try {
                    return [statSync(path)];
                }
                catch {
                    return [];
                }
            });
            if (!options.dryRun)
                rmSync(root, { recursive: true, force: true });
            return { files: stats.length, bytes: stats.reduce((sum, stat) => sum + stat.size, 0) };
        }
        const cutoff = Date.now() - options.olderThanMs;
        const expired = new Set();
        const protectedBlobs = new Set();
        let protectAllBlobs = false;
        for (const path of paths) {
            let stat;
            try {
                stat = statSync(path);
            }
            catch {
                continue;
            }
            const rel = relative(root, path);
            let timestamp = stat.mtimeMs;
            if (rel.endsWith('.json') && !rel.startsWith('blobs/')) {
                try {
                    const document = JSON.parse(readFileSync(path, 'utf8'));
                    timestamp = storedTimestamp(document, timestamp);
                    if (timestamp > cutoff)
                        for (const blob of collectBlobReferences(document))
                            protectedBlobs.add(blob);
                }
                catch {
                    if (timestamp > cutoff)
                        protectAllBlobs = true;
                }
            }
            if (timestamp <= cutoff)
                expired.add(path);
        }
        let files = 0;
        let bytes = 0;
        for (const path of expired) {
            const rel = relative(root, path);
            if (rel.startsWith('blobs/') && (protectAllBlobs || protectedBlobs.has(rel)))
                continue;
            let size;
            try {
                size = statSync(path).size;
                if (!options.dryRun)
                    unlinkSync(path);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    continue;
                throw error;
            }
            files++;
            bytes += size;
        }
        return { files, bytes };
    });
}
/** Remove expired optional transcript blobs while retaining immutable record metadata. */
export function pruneExpiredTranscriptBlobs(now = Date.now()) {
    return withEvidenceLock(() => {
        const recordsDir = join(evidenceRoot(), 'records');
        if (!existsSync(recordsDir))
            return { files: 0, bytes: 0 };
        const expired = new Set();
        const active = new Set();
        for (const entry of readdirSync(recordsDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json'))
                continue;
            let record;
            try {
                record = JSON.parse(readFileSync(join(recordsDir, entry.name), 'utf8'));
            }
            catch {
                continue;
            }
            if (!isPlanCritiqueBlobPath(record.transcriptBlob))
                continue;
            const expiry = Date.parse(record.transcriptExpiresAt ?? '');
            if (Number.isFinite(expiry) && expiry <= now)
                expired.add(record.transcriptBlob);
            else
                active.add(record.transcriptBlob);
        }
        let files = 0;
        let bytes = 0;
        for (const relativePath of expired) {
            if (active.has(relativePath))
                continue;
            const path = resolve(evidenceRoot(), relativePath);
            if (!path.startsWith(`${resolve(evidenceRoot())}/`))
                continue;
            let size;
            try {
                const stat = statSync(path);
                if (!stat.isFile())
                    continue;
                size = stat.size;
                unlinkSync(path);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    continue;
                throw error;
            }
            files++;
            bytes += size;
        }
        return { files, bytes };
    });
}
