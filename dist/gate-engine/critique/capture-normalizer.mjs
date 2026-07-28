import { TextDecoder } from 'node:util';
import { capturePlanCritiqueRecord } from "./evidence-capture-store.mjs";
import { PLAN_CRITIQUE_PROJECTION_MAX_BYTES, PLAN_CRITIQUE_PROVIDERS, sha256Bytes, snapshotPlanCritiquePayloads, } from "./evidence-record.mjs";
import { parsePlanCritiqueResponse, } from "./response-contract.mjs";
export const PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES = 4 * 1024;
export const PLAN_CRITIQUE_PROJECTION_MAX_ITEMS = 25;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const PLAN_CRITIQUE_PROJECTION_SUMMARY_MAX_BYTES = 1024;
const HIDDEN_FORMAT_CHARACTER = /\p{Cf}/u;
const REDACTION_START = '\u0000';
const REDACTION_END = '\u0001';
const REDACTION_PATTERNS = [
    {
        kind: 'private-key',
        pattern: /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
    },
    {
        kind: 'credentialed-url',
        pattern: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/g,
    },
    {
        kind: 'provider-token',
        pattern: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
    },
    { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    {
        kind: 'authorization',
        pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi,
    },
    {
        kind: 'secret-assignment',
        pattern: /(["']?)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|github[_-]?token|aws[_-]?secret[_-]?access[_-]?key|database[_-]?url|authorization|cookie|secret|token)\b\1\s*[=:]\s*(?:"[^"]{8,}"|'[^']{8,}'|[^\s,;]{8,})/gi,
    },
    {
        kind: 'sensitive-query',
        pattern: /[?&](?:access_token|api_key|token|secret|signature|x-amz-signature|x-amz-security-token)=[^&#\s]+/gi,
    },
];
function callbackHash(provider, identity) {
    const containsControl = typeof identity === 'string' &&
        [...identity].some((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        });
    if (!PLAN_CRITIQUE_PROVIDERS.includes(provider) ||
        typeof identity !== 'string' ||
        identity.trim().length === 0 ||
        Buffer.byteLength(identity, 'utf8') > PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES ||
        containsControl)
        throw new Error('invalid plan critique callback identity');
    return sha256Bytes(Buffer.from(JSON.stringify(['plan_critique_callback', 1, provider, identity]), 'utf8'));
}
function invalidContract(code = 'INVALID_JSON', path = '$') {
    return {
        state: 'invalid',
        error: { code, path },
        status: null,
        verdict: null,
        criticalCount: null,
    };
}
function normalizeDisplayText(value) {
    const normalized = Buffer.from(value, 'utf8').toString('utf8').normalize('NFKC');
    let out = '';
    let replacingControlRun = false;
    for (const character of normalized) {
        const code = character.codePointAt(0) ?? 0;
        const spacingControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
        if (spacingControl) {
            if (!replacingControlRun)
                out += ' ';
            replacingControlRun = true;
            continue;
        }
        if (HIDDEN_FORMAT_CHARACTER.test(character))
            continue;
        out += character;
        replacingControlRun = false;
    }
    return out.trim();
}
function clean(value) {
    let out = normalizeDisplayText(value);
    for (const { kind, pattern } of REDACTION_PATTERNS) {
        out = out.replace(pattern, () => `${REDACTION_START}[REDACTED:${kind}]${REDACTION_END}`);
    }
    const segments = [];
    let cursor = 0;
    while (cursor < out.length) {
        const start = out.indexOf(REDACTION_START, cursor);
        if (start === -1) {
            segments.push({ value: out.slice(cursor), redacted: false });
            break;
        }
        if (start > cursor)
            segments.push({ value: out.slice(cursor, start), redacted: false });
        const end = out.indexOf(REDACTION_END, start + REDACTION_START.length);
        if (end === -1)
            throw new Error('plan critique redaction marker is incomplete');
        segments.push({
            value: out.slice(start + REDACTION_START.length, end),
            redacted: true,
        });
        cursor = end + REDACTION_END.length;
    }
    return {
        value: segments.map((segment) => segment.value).join(''),
        redacted: segments.some((segment) => segment.redacted),
        segments,
    };
}
function projectFinding(finding) {
    const claim = clean(finding.claim);
    const impact = clean(finding.impact);
    const recommendation = clean(finding.recommendation);
    return {
        value: {
            severity: finding.severity,
            lens: finding.lens,
            claim: claim.value,
            impact: impact.value,
            recommendation: recommendation.value,
        },
        redacted: claim.redacted || impact.redacted || recommendation.redacted,
    };
}
function projectEdgeCase(edgeCase) {
    const scenario = clean(edgeCase.scenario);
    const expectedBehavior = clean(edgeCase.expectedBehavior);
    return {
        value: {
            risk: {
                layer: edgeCase.risk.layer,
                category: edgeCase.risk.category,
            },
            scenario: scenario.value,
            expectedBehavior: expectedBehavior.value,
            testType: edgeCase.testType,
        },
        redacted: scenario.redacted || expectedBehavior.redacted,
    };
}
function projectAction(action) {
    if (action.kind === 'route_implementation_reviewer') {
        return { value: { kind: action.kind }, redacted: false };
    }
    const detail = clean(action.detail);
    return {
        value: { kind: action.kind, detail: detail.value },
        redacted: detail.redacted,
    };
}
function truncateSanitizedText(value, maxBytes) {
    if (Buffer.byteLength(value.value, 'utf8') <= maxBytes)
        return { value: value.value, redacted: value.redacted, truncated: false };
    const characters = [];
    let bytes = 0;
    let redacted = false;
    outer: for (const segment of value.segments) {
        for (const character of segment.value) {
            const next = Buffer.byteLength(character, 'utf8');
            if (bytes + next > maxBytes)
                break outer;
            characters.push(character);
            bytes += next;
            if (segment.redacted)
                redacted = true;
        }
    }
    return { value: characters.join(''), redacted, truncated: true };
}
function serializeProjection(response) {
    const summary = clean(response.summary);
    const boundedSummary = truncateSanitizedText(summary, PLAN_CRITIQUE_PROJECTION_SUMMARY_MAX_BYTES);
    const findings = response.findings.map(projectFinding);
    const edgeCases = response.edgeCases.map(projectEdgeCase);
    const items = [
        ...findings.map(({ value, redacted }) => ({
            kind: 'finding',
            value,
            redacted,
        })),
        ...edgeCases.map(({ value, redacted }) => ({
            kind: 'edge_case',
            value,
            redacted,
        })),
    ];
    const selectedItems = items.slice(0, PLAN_CRITIQUE_PROJECTION_MAX_ITEMS);
    const selectedActions = response.actions.map(projectAction);
    let truncated = boundedSummary.truncated || selectedItems.length < items.length;
    for (;;) {
        const projection = {
            schemaVersion: 1,
            kind: 'plan_critique_projection',
            phase: 'plan',
            status: response.status,
            verdict: response.verdict,
            feasibilityStatus: response.feasibility?.status ?? null,
            frameMeta: response.frameMeta,
            summary: boundedSummary.value,
            findings: selectedItems
                .filter((item) => item.kind === 'finding')
                .map((item) => item.value),
            edgeCases: selectedItems
                .filter((item) => item.kind === 'edge_case')
                .map((item) => item.value),
            actions: selectedActions.map((action) => action.value),
            contentTrust: 'untrusted',
            redacted: boundedSummary.redacted ||
                selectedItems.some((item) => item.redacted) ||
                selectedActions.some((action) => action.redacted),
            truncated,
        };
        const serialized = Buffer.from(JSON.stringify(projection), 'utf8');
        if (serialized.byteLength <= PLAN_CRITIQUE_PROJECTION_MAX_BYTES)
            return serialized;
        if (selectedActions.length > 0)
            selectedActions.pop();
        else if (selectedItems.length > 0)
            selectedItems.pop();
        else
            throw new Error('plan critique projection envelope exceeds its byte limit');
        truncated = true;
    }
}
function deriveResponseEvidence(exactResponse) {
    let raw;
    try {
        raw = UTF8.decode(exactResponse);
    }
    catch {
        return { contract: invalidContract() };
    }
    const parsed = parsePlanCritiqueResponse(raw);
    if (!parsed.ok)
        return { contract: invalidContract(parsed.error.code, parsed.error.path) };
    return {
        contract: {
            state: 'valid',
            error: null,
            status: parsed.value.status,
            verdict: parsed.value.verdict,
            criticalCount: parsed.value.status === 'reviewed'
                ? parsed.value.findings.filter((finding) => finding.severity === 'CRITICAL').length
                : null,
        },
        sanitizedProjection: serializeProjection(parsed.value),
    };
}
function normalizePlanCritiqueCompletedCallback(input) {
    const derivedCallbackHash = callbackHash(input.provider, input.callbackIdentity);
    const transcript = input.opaqueTranscript;
    const snapshots = snapshotPlanCritiquePayloads({
        exactResponse: input.exactResponse,
        opaqueTranscript: transcript?.bytes,
    });
    const responseEvidence = deriveResponseEvidence(snapshots.exactResponse);
    return {
        workId: input.workId,
        execution: {
            provider: input.provider,
            callbackHash: derivedCallbackHash,
            model: input.model,
            promptHash: input.promptHash,
        },
        repository: input.repository,
        providerCompletedAt: input.providerCompletedAt,
        contract: responseEvidence.contract,
        exactResponse: snapshots.exactResponse,
        sanitizedProjection: responseEvidence.sanitizedProjection,
        opaqueTranscript: snapshots.opaqueTranscript
            ? { bytes: snapshots.opaqueTranscript, expiresAt: transcript?.expiresAt }
            : undefined,
    };
}
/** Normalize trusted provider-adapter fields and persist them without exposing mutable bytes. */
export function capturePlanCritiqueCompletedCallback(input, options = {}) {
    return capturePlanCritiqueRecord(normalizePlanCritiqueCompletedCallback(input), options);
}
