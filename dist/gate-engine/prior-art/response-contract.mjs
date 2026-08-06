import { firstDuplicateJsonKey } from "../critique/json-duplicate-keys.mjs";
import { PRIOR_ART_BOUNDARY_ANSWERS, PRIOR_ART_CONFIDENCES, PRIOR_ART_EVIDENCE_KINDS, PRIOR_ART_FRAMINGS, PRIOR_ART_LEG_NAMES, PRIOR_ART_LEG_STATUSES, PRIOR_ART_MAX_ITEMS, PRIOR_ART_NEXT_STEP_KINDS, PRIOR_ART_QUESTION_IDS, PRIOR_ART_QUESTION_STATUSES, PRIOR_ART_QUOTE_MAX_CHARS, PRIOR_ART_RESPONSE_MAX_BYTES, PRIOR_ART_ROUTINGS, PRIOR_ART_STATUSES, PRIOR_ART_STRING_MAX_BYTES, PRIOR_ART_VERDICTS, validatePriorArtCoupling, } from "./response-status.mjs";
export * from "./response-status.mjs";
/**
 * Closed-world V1 response parser for the step-0 prior-art agent.
 *
 * Model output is untrusted: parsing is size-bounded, rejects Markdown fences and extensions,
 * validates every nested field, and always returns a discriminated result. The vocabulary and the
 * verdict↔evidence↔legs coupling live in response-status.mts.
 */
class ContractFailure extends Error {
    contractError;
    constructor(contractError) {
        super(contractError.message);
        this.contractError = contractError;
    }
}
const fail = (code, path, message) => {
    throw new ContractFailure({ code, path, message });
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function exactObject(value, path, fields, optional = [], root = false) {
    const object = isRecord(value)
        ? value
        : fail(root ? 'ROOT_NOT_OBJECT' : 'INVALID_TYPE', path, root ? 'response must be a JSON object' : 'expected an object');
    const known = [...fields, ...optional];
    const unknown = Object.keys(object)
        .filter((key) => !known.includes(key))
        .sort()[0];
    if (unknown !== undefined)
        fail('UNKNOWN_FIELD', `${path}.${unknown}`, `unknown field ${unknown}`);
    for (const field of fields)
        if (!Object.hasOwn(object, field))
            fail('MISSING_FIELD', `${path}.${field}`, `missing required field ${field}`);
    return object;
}
function boundedString(value, path, allowBlank = false) {
    const text = typeof value === 'string' ? value : fail('INVALID_TYPE', path, 'expected a string');
    if (Buffer.byteLength(text, 'utf8') > PRIOR_ART_STRING_MAX_BYTES)
        fail('STRING_TOO_LONG', path, `string exceeds ${PRIOR_ART_STRING_MAX_BYTES} UTF-8 bytes`);
    if (!allowBlank && text.trim().length === 0)
        fail('INVALID_VALUE', path, 'string must not be blank');
    return text;
}
function oneOf(value, path, allowed) {
    const text = typeof value === 'string' ? value : fail('INVALID_TYPE', path, 'expected a string');
    if (!allowed.includes(text))
        fail('INVALID_VALUE', path, `expected one of ${allowed.join(', ')}`);
    return text;
}
function boundedArray(value, path, max) {
    const items = Array.isArray(value) ? value : fail('INVALID_TYPE', path, 'expected an array');
    if (items.length > max)
        fail('ARRAY_TOO_LONG', path, `array exceeds ${max} items`);
    return items;
}
function countValue(value, path) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        fail('INVALID_TYPE', path, 'expected a non-negative integer');
    return value;
}
function parseLeg(value, path, expected) {
    // Models reliably mirror the count fields onto every leg (measured on the first K=1 bank:
    // 3 of 4 invalid rows failed ONLY on `legs[1].declaredCheckouts`). Counts are REQUIRED on
    // local, tolerated-and-ignored elsewhere — the coupling rules only ever read legs[0]'s counts,
    // so a stray count on an external leg can launder nothing.
    const object = expected === 'local'
        ? exactObject(value, path, [
            'leg',
            'status',
            'detail',
            'declaredCheckouts',
            'resolvedCheckouts',
        ])
        : exactObject(value, path, ['leg', 'status', 'detail'], ['declaredCheckouts', 'resolvedCheckouts']);
    const leg = oneOf(object.leg, `${path}.leg`, PRIOR_ART_LEG_NAMES);
    if (leg !== expected)
        fail('INVALID_VALUE', `${path}.leg`, `legs must appear in order; expected ${expected}`);
    const parsed = {
        leg,
        status: oneOf(object.status, `${path}.status`, PRIOR_ART_LEG_STATUSES),
        detail: boundedString(object.detail, `${path}.detail`),
    };
    if (expected === 'local') {
        parsed.declaredCheckouts = countValue(object.declaredCheckouts, `${path}.declaredCheckouts`);
        parsed.resolvedCheckouts = countValue(object.resolvedCheckouts, `${path}.resolvedCheckouts`);
        // The declaration-laundering guard: "nothing declared/resolved" must never read as a
        // searched corpus. Zero resolved checkouts cannot attest `reached`.
        if (parsed.resolvedCheckouts === 0 && parsed.status === 'reached')
            fail('INVALID_STATUS_COMBINATION', `${path}.status`, 'local leg with zero resolved checkouts must attest unavailable or failed, never reached');
    }
    return parsed;
}
function parseQuestion(value, path, expected) {
    const object = exactObject(value, path, ['id', 'status', 'finding']);
    const id = oneOf(object.id, `${path}.id`, PRIOR_ART_QUESTION_IDS);
    if (id !== expected)
        fail('INVALID_VALUE', `${path}.id`, `questions must appear in order; expected ${expected}`);
    return {
        id,
        status: oneOf(object.status, `${path}.status`, PRIOR_ART_QUESTION_STATUSES),
        finding: boundedString(object.finding, `${path}.finding`),
    };
}
function parseEvidence(value, path) {
    const object = exactObject(value, path, ['kind', 'source', 'repoRoot', 'claim', 'quote']);
    // Quotes are display evidence, not coupling input: an overlong quote is TRUNCATED to the cap
    // rather than failing the response (a 241-char quote nuking an otherwise-valid verdict is the
    // parser being stricter than the field's job warrants). The byte bound still applies first.
    const quote = [...boundedString(object.quote, `${path}.quote`, true)]
        .slice(0, PRIOR_ART_QUOTE_MAX_CHARS)
        .join('');
    return {
        kind: oneOf(object.kind, `${path}.kind`, PRIOR_ART_EVIDENCE_KINDS),
        source: boundedString(object.source, `${path}.source`),
        repoRoot: object.repoRoot === null ? null : boundedString(object.repoRoot, `${path}.repoRoot`),
        claim: boundedString(object.claim, `${path}.claim`),
        quote,
    };
}
const URL_WHITESPACE_RE = /\s/u;
function parseReference(value, path) {
    const object = exactObject(value, path, ['title', 'url']);
    const url = boundedString(object.url, `${path}.url`);
    if ([...url].some((character) => {
        const code = character.charCodeAt(0);
        return URL_WHITESPACE_RE.test(character) || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }))
        fail('INVALID_URL', `${path}.url`, 'URL must not contain whitespace or control characters');
    const parsed = (() => {
        try {
            return new URL(url);
        }
        catch {
            return fail('INVALID_URL', `${path}.url`, 'expected an absolute http/https URL');
        }
    })();
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname)
        fail('INVALID_URL', `${path}.url`, 'expected an absolute http/https URL');
    return { title: boundedString(object.title, `${path}.title`), url };
}
function parseObject(value) {
    const object = exactObject(value, '$', [
        'schemaVersion',
        'kind',
        'phase',
        'status',
        'problem',
        'verdict',
        'confidence',
        'legs',
        'frameChallenge',
        'questions',
        'evidence',
        'suggestedNextStep',
        'routing',
        'summary',
    ], 
    // The one tolerated elision: models reliably drop researchReferences when there are no
    // web/github findings (measured at >60% of dark-leg rows on the first K=3 run). Absent
    // parses as [] — still fully validated whenever present.
    ['researchReferences'], true);
    if (object.schemaVersion !== 1)
        fail('INVALID_VALUE', '$.schemaVersion', 'schemaVersion must be 1');
    if (object.kind !== 'prior_art')
        fail('INVALID_VALUE', '$.kind', 'kind must be prior_art');
    if (object.phase !== 'problem')
        fail('INVALID_VALUE', '$.phase', 'phase must be problem');
    const status = oneOf(object.status, '$.status', PRIOR_ART_STATUSES);
    const neutral = status !== 'reviewed';
    const problem = exactObject(object.problem, '$.problem', [
        'statement',
        'restatedFrame',
        'assumedConstraints',
    ]);
    const frame = object.frameChallenge === null
        ? null
        : exactObject(object.frameChallenge, '$.frameChallenge', [
            'framing',
            'upstreamChoice',
            'boundaryMustExist',
        ]);
    const step = object.suggestedNextStep === null
        ? null
        : exactObject(object.suggestedNextStep, '$.suggestedNextStep', ['kind', 'detail']);
    const response = {
        schemaVersion: 1,
        kind: 'prior_art',
        phase: 'problem',
        status,
        problem: {
            statement: boundedString(problem.statement, '$.problem.statement'),
            restatedFrame: boundedString(problem.restatedFrame, '$.problem.restatedFrame', neutral),
            assumedConstraints: boundedArray(problem.assumedConstraints, '$.problem.assumedConstraints', PRIOR_ART_MAX_ITEMS).map((item, index) => boundedString(item, `$.problem.assumedConstraints[${index}]`)),
        },
        verdict: object.verdict === null ? null : oneOf(object.verdict, '$.verdict', PRIOR_ART_VERDICTS),
        confidence: object.confidence === null
            ? null
            : oneOf(object.confidence, '$.confidence', PRIOR_ART_CONFIDENCES),
        legs: boundedArray(object.legs, '$.legs', PRIOR_ART_LEG_NAMES.length).map((leg, index) => parseLeg(leg, `$.legs[${index}]`, PRIOR_ART_LEG_NAMES[index])),
        frameChallenge: frame === null
            ? null
            : {
                framing: oneOf(frame.framing, '$.frameChallenge.framing', PRIOR_ART_FRAMINGS),
                upstreamChoice: frame.upstreamChoice === null
                    ? null
                    : boundedString(frame.upstreamChoice, '$.frameChallenge.upstreamChoice'),
                boundaryMustExist: oneOf(frame.boundaryMustExist, '$.frameChallenge.boundaryMustExist', PRIOR_ART_BOUNDARY_ANSWERS),
            },
        questions: boundedArray(object.questions, '$.questions', PRIOR_ART_QUESTION_IDS.length).map((question, index) => parseQuestion(question, `$.questions[${index}]`, PRIOR_ART_QUESTION_IDS[index])),
        evidence: boundedArray(object.evidence, '$.evidence', PRIOR_ART_MAX_ITEMS).map((item, index) => parseEvidence(item, `$.evidence[${index}]`)),
        suggestedNextStep: step === null
            ? null
            : {
                kind: oneOf(step.kind, '$.suggestedNextStep.kind', PRIOR_ART_NEXT_STEP_KINDS),
                detail: boundedString(step.detail, '$.suggestedNextStep.detail'),
            },
        routing: object.routing === null ? null : oneOf(object.routing, '$.routing', PRIOR_ART_ROUTINGS),
        summary: boundedString(object.summary, '$.summary'),
        researchReferences: object.researchReferences === undefined
            ? []
            : boundedArray(object.researchReferences, '$.researchReferences', PRIOR_ART_MAX_ITEMS).map((reference, index) => parseReference(reference, `$.researchReferences[${index}]`)),
    };
    validatePriorArtCoupling(response, (path, requirement) => fail('INVALID_STATUS_COMBINATION', path, requirement));
    return response;
}
/** Parse untrusted model output. Every malformed-input path returns an error and never escapes. */
export function parsePriorArtResponse(raw) {
    if (typeof raw !== 'string')
        return {
            ok: false,
            error: { code: 'INVALID_TYPE', path: '$', message: 'response must be a string' },
        };
    if (Buffer.byteLength(raw, 'utf8') > PRIOR_ART_RESPONSE_MAX_BYTES)
        return {
            ok: false,
            error: {
                code: 'INPUT_TOO_LARGE',
                path: '$',
                message: `response exceeds ${PRIOR_ART_RESPONSE_MAX_BYTES} UTF-8 bytes`,
            },
        };
    if (raw.trimStart().startsWith('```'))
        return {
            ok: false,
            error: { code: 'FENCED_JSON', path: '$', message: 'response must not use a Markdown fence' },
        };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {
            ok: false,
            error: { code: 'INVALID_JSON', path: '$', message: 'response is not valid JSON' },
        };
    }
    const duplicate = firstDuplicateJsonKey(raw);
    if (duplicate !== null)
        return {
            ok: false,
            error: {
                code: 'DUPLICATE_FIELD',
                path: '$',
                message: `duplicate object field ${JSON.stringify(duplicate)}`,
            },
        };
    try {
        return { ok: true, value: parseObject(parsed) };
    }
    catch (error) {
        if (error instanceof ContractFailure)
            return { ok: false, error: error.contractError };
        return {
            ok: false,
            error: { code: 'INVALID_VALUE', path: '$', message: 'response failed validation' },
        };
    }
}
