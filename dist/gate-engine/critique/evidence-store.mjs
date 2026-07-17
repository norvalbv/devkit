import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { critiqueEligibility } from "./contract.mjs";
import { atomicWrite } from "./immutable-file.mjs";
const RECORD_VERSION = 1;
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[^\s,;]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function evidenceRoot() {
    return (process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR ??
        join(homedir(), '.devkit', 'evidence', 'plan-critiques', 'v1'));
}
export const sha256Text = (value) => createHash('sha256').update(value).digest('hex');
export function persistImmutableJson(relativePath, value) {
    const path = join(evidenceRoot(), relativePath);
    atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
}
export function writeContentBlob(content, extension = 'txt') {
    const hash = sha256Text(content);
    const rel = `blobs/${hash}.${extension}`;
    const path = join(evidenceRoot(), rel);
    if (existsSync(path))
        return rel;
    try {
        atomicWrite(path, content);
    }
    catch (error) {
        if (!existsSync(path))
            throw error;
    }
    return rel;
}
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
    return join(evidenceRoot(), 'records', `${critiqueId}.json`);
}
export function readRecord(critiqueId) {
    if (!UUID.test(critiqueId))
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
    const path = recordPath(record.critiqueId);
    atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
}
export function makeRecord(input) {
    const critiqueId = randomUUID();
    const eligibility = critiqueEligibility(input.contract);
    const pass = input.pass ?? 1;
    const retryLimitExceeded = pass > 2;
    return {
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
        exactResponseBlob: writeContentBlob(input.contract.exactRaw, 'json'),
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
}
export function purgePlanCritiqueEvidence(options = {}) {
    const root = evidenceRoot();
    if (!existsSync(root))
        return { files: 0, bytes: 0 };
    const cutoff = options.olderThanMs ? Date.now() - options.olderThanMs : Number.POSITIVE_INFINITY;
    let files = 0;
    let bytes = 0;
    const walk = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if (entry.isDirectory())
                walk(child);
            else if (entry.isFile() && statSync(child).mtimeMs <= cutoff) {
                files++;
                bytes += statSync(child).size;
                if (!options.dryRun)
                    rmSync(child, { force: true });
            }
        }
    };
    walk(root);
    if (!options.dryRun && !options.olderThanMs)
        rmSync(root, { recursive: true, force: true });
    return { files, bytes };
}
/** Remove expired optional transcript blobs while retaining immutable record metadata. */
export function pruneExpiredTranscriptBlobs(now = Date.now()) {
    const recordsDir = join(evidenceRoot(), 'records');
    if (!existsSync(recordsDir))
        return { files: 0, bytes: 0 };
    const expired = new Set();
    const active = new Set();
    for (const entry of readdirSync(recordsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json'))
            continue;
        try {
            const record = JSON.parse(readFileSync(join(recordsDir, entry.name), 'utf8'));
            if (!record.transcriptBlob)
                continue;
            const expiry = Date.parse(record.transcriptExpiresAt ?? '');
            if (Number.isFinite(expiry) && expiry <= now)
                expired.add(record.transcriptBlob);
            else
                active.add(record.transcriptBlob);
        }
        catch {
            // Malformed records are preserved and do not authorize deleting any referenced blob.
        }
    }
    let files = 0;
    let bytes = 0;
    for (const relativePath of expired) {
        if (active.has(relativePath))
            continue;
        const path = resolve(evidenceRoot(), relativePath);
        if (!path.startsWith(`${resolve(evidenceRoot())}/`) || !existsSync(path))
            continue;
        const stat = statSync(path);
        if (!stat.isFile())
            continue;
        files++;
        bytes += stat.size;
        rmSync(path, { force: true });
    }
    return { files, bytes };
}
