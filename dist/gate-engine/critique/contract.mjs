/**
 * Versioned response contract for the pre-implementation plan critic.
 *
 * The critic returns one JSON value. Capture deliberately does not recover JSON from markdown
 * fences or prose: a response that is not exactly JSON is benchmark evidence, but it cannot become
 * an eligible receipt.
 */
export const PLAN_CRITIQUE_SCHEMA_VERSION = 1;
export const PLAN_CRITIQUE_KIND = 'plan_critique';
export const PLAN_CRITIQUE_PHASE = 'plan';
export const PLAN_CRITIQUE_STATUSES = ['reviewed', 'aborted', 'wrong_phase'];
export const PLAN_CRITIQUE_VERDICTS = [
    'PROCEED',
    'PROCEED_WITH_CHANGES',
    'RETHINK',
    'REJECT',
];
export const PLAN_CRITIQUE_SEVERITIES = ['critical', 'warning', 'info'];
export const PLAN_CRITIQUE_FRAME_META = ['SOUND', 'NOTABUG', 'BANDAID', 'UXHARM', 'SKIP'];
export const PLAN_CRITIQUE_TEST_TYPES = ['unit', 'integration', 'e2e', 'manual'];
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
function requireOnlyKeys(value, allowed, label, errors) {
    const extras = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extras.length > 0)
        errors.push(`${label} has unsupported fields: ${extras.sort().join(', ')}`);
}
function requireString(value, key, errors) {
    const item = value[key];
    if (!isString(item) || item.trim().length === 0) {
        errors.push(`${key} must be a non-empty string`);
        return null;
    }
    return item;
}
function parseFindings(value, errors) {
    if (!Array.isArray(value)) {
        errors.push('findings must be an array');
        return [];
    }
    return value.flatMap((item, index) => {
        if (!isObject(item)) {
            errors.push(`findings[${index}] must be an object`);
            return [];
        }
        requireOnlyKeys(item, ['severity', 'lens', 'claim', 'evidence', 'impact', 'recommendation'], `findings[${index}]`, errors);
        const severity = item.severity;
        if (!PLAN_CRITIQUE_SEVERITIES.includes(severity)) {
            errors.push(`findings[${index}].severity is invalid`);
        }
        const lens = requireString(item, 'lens', errors);
        const claim = requireString(item, 'claim', errors);
        const evidence = requireString(item, 'evidence', errors);
        const impact = requireString(item, 'impact', errors);
        const recommendation = requireString(item, 'recommendation', errors);
        if (!PLAN_CRITIQUE_SEVERITIES.includes(severity) ||
            !lens ||
            !claim ||
            !evidence ||
            !impact ||
            !recommendation) {
            return [];
        }
        return [{ severity, lens, claim, evidence, impact, recommendation }];
    });
}
function parseEdgeCases(value, errors) {
    if (!Array.isArray(value)) {
        errors.push('edgeCases must be an array');
        return [];
    }
    return value.flatMap((item, index) => {
        if (!isObject(item)) {
            errors.push(`edgeCases[${index}] must be an object`);
            return [];
        }
        requireOnlyKeys(item, ['risk', 'scenario', 'expectedBehavior', 'testType'], `edgeCases[${index}]`, errors);
        const risk = requireString(item, 'risk', errors);
        const scenario = requireString(item, 'scenario', errors);
        const expectedBehavior = requireString(item, 'expectedBehavior', errors);
        const testType = item.testType;
        if (!PLAN_CRITIQUE_TEST_TYPES.includes(testType)) {
            errors.push(`edgeCases[${index}].testType is invalid`);
        }
        if (!risk ||
            !scenario ||
            !expectedBehavior ||
            !PLAN_CRITIQUE_TEST_TYPES.includes(testType)) {
            return [];
        }
        return [{ risk, scenario, expectedBehavior, testType }];
    });
}
/** Strictly parse one JSON response. Fenced or prose-wrapped JSON remains invalid evidence. */
export function parsePlanCritiqueResponse(raw) {
    let exactResponse;
    try {
        exactResponse = JSON.parse(raw.trim());
    }
    catch (error) {
        return {
            state: 'invalid',
            errors: [
                `response is not exact JSON: ${error instanceof Error ? error.message : String(error)}`,
            ],
            value: null,
            exactResponse: raw,
            exactRaw: raw,
        };
    }
    if (!isObject(exactResponse)) {
        return {
            state: 'invalid',
            errors: ['response must be a JSON object'],
            value: null,
            exactResponse,
            exactRaw: raw,
        };
    }
    const errors = [];
    requireOnlyKeys(exactResponse, [
        'schemaVersion',
        'kind',
        'phase',
        'status',
        'verdict',
        'feasibility',
        'frameMeta',
        'summary',
        'findings',
        'edgeCases',
        'actions',
    ], 'response', errors);
    if (exactResponse.schemaVersion !== PLAN_CRITIQUE_SCHEMA_VERSION)
        errors.push(`schemaVersion must be ${PLAN_CRITIQUE_SCHEMA_VERSION}`);
    if (exactResponse.kind !== PLAN_CRITIQUE_KIND)
        errors.push(`kind must be ${PLAN_CRITIQUE_KIND}`);
    if (exactResponse.phase !== PLAN_CRITIQUE_PHASE)
        errors.push(`phase must be ${PLAN_CRITIQUE_PHASE}`);
    const status = exactResponse.status;
    if (!PLAN_CRITIQUE_STATUSES.includes(status))
        errors.push('status is invalid');
    const verdict = exactResponse.verdict;
    if (verdict !== null && !PLAN_CRITIQUE_VERDICTS.includes(verdict))
        errors.push('verdict is invalid');
    const feasibility = requireString(exactResponse, 'feasibility', errors);
    const frameMeta = exactResponse.frameMeta;
    if (!PLAN_CRITIQUE_FRAME_META.includes(frameMeta))
        errors.push('frameMeta is invalid');
    const summary = requireString(exactResponse, 'summary', errors);
    const findings = parseFindings(exactResponse.findings, errors);
    const edgeCases = parseEdgeCases(exactResponse.edgeCases, errors);
    const actionValue = exactResponse.actions;
    const actions = Array.isArray(actionValue) ? actionValue.filter(isString) : [];
    if (!Array.isArray(actionValue) || actions.length !== actionValue.length)
        errors.push('actions must be an array of strings');
    if (status === 'reviewed' && verdict === null)
        errors.push('reviewed responses require a verdict');
    if (status !== 'reviewed' && verdict !== null)
        errors.push('non-reviewed responses must use verdict: null');
    const valid = errors.length === 0;
    return {
        state: valid ? 'valid' : 'invalid',
        errors,
        value: valid
            ? {
                schemaVersion: PLAN_CRITIQUE_SCHEMA_VERSION,
                kind: PLAN_CRITIQUE_KIND,
                phase: PLAN_CRITIQUE_PHASE,
                status: status,
                verdict: verdict,
                feasibility: feasibility,
                frameMeta: frameMeta,
                summary: summary,
                findings,
                edgeCases,
                actions,
            }
            : null,
        exactResponse,
        exactRaw: raw,
    };
}
export function critiqueEligibility(contract) {
    if (contract.state !== 'valid' || !contract.value)
        return { eligible: false, reason: 'invalid_contract', criticalCount: 0 };
    const criticalCount = contract.value.findings.filter((f) => f.severity === 'critical').length;
    if (contract.value.status !== 'reviewed')
        return { eligible: false, reason: contract.value.status, criticalCount };
    if (!['PROCEED', 'PROCEED_WITH_CHANGES'].includes(contract.value.verdict ?? ''))
        return {
            eligible: false,
            reason: `verdict_${contract.value.verdict?.toLowerCase()}`,
            criticalCount,
        };
    if (criticalCount > 0)
        return { eligible: false, reason: 'critical_findings', criticalCount };
    return { eligible: true, reason: 'eligible', criticalCount };
}
