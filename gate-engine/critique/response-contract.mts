import { firstDuplicateJsonKey } from './json-duplicate-keys.mts';
import {
  type ParsePlanCritiqueResponseResult,
  PLAN_CRITIQUE_ACTION_KINDS,
  PLAN_CRITIQUE_EDGE_CASE_CATEGORIES,
  PLAN_CRITIQUE_FEASIBILITY_STATUSES,
  PLAN_CRITIQUE_FRAME_METAS,
  PLAN_CRITIQUE_LENSES,
  PLAN_CRITIQUE_STATUSES,
  PLAN_CRITIQUE_VERDICTS,
  type PlanCritiqueAction,
  type PlanCritiqueAnalysis,
  type PlanCritiqueConfigurationRow,
  type PlanCritiqueDecisionLogAlignment,
  type PlanCritiqueEdgeCase,
  type PlanCritiqueFeasibility,
  type PlanCritiqueFinding,
  type PlanCritiqueResearchReference,
  type PlanCritiqueResponseError,
  type PlanCritiqueResponseErrorCode,
  type PlanCritiqueResponseV1,
  type PlanCritiqueRisk,
  type PlanCritiqueScope,
  validatePlanCritiqueStatus,
} from './response-status.mts';

export * from './response-status.mts';

/**
 * Closed-world V1 response contract for plan critique.
 *
 * Model output is untrusted: parsing is size-bounded, rejects Markdown fences and extensions,
 * validates every nested field, and always returns a discriminated result.
 */

export const PLAN_CRITIQUE_RESPONSE_MAX_BYTES = 128 * 1024;
export const PLAN_CRITIQUE_STRING_MAX_BYTES = 16 * 1024;
export const PLAN_CRITIQUE_MAX_FINDINGS = 50;
export const PLAN_CRITIQUE_MAX_EDGE_CASES = 100;
export const PLAN_CRITIQUE_MAX_STRINGS = 50;
const URL_WHITESPACE_RE = /\s/u;

class ContractFailure extends Error {
  readonly contractError: PlanCritiqueResponseError;

  constructor(contractError: PlanCritiqueResponseError) {
    super(contractError.message);
    this.contractError = contractError;
  }
}

const fail = (code: PlanCritiqueResponseErrorCode, path: string, message: string): never => {
  throw new ContractFailure({ code, path, message });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function exactObject(
  value: unknown,
  path: string,
  fields: readonly string[],
  root = false,
): Record<string, unknown> {
  const object = isRecord(value)
    ? value
    : fail(
        root ? 'ROOT_NOT_OBJECT' : 'INVALID_TYPE',
        path,
        root ? 'response must be a JSON object' : 'expected an object',
      );
  const unknown = Object.keys(object)
    .filter((key) => !fields.includes(key))
    .sort()[0];
  if (unknown !== undefined)
    fail('UNKNOWN_FIELD', `${path}.${unknown}`, `unknown field ${unknown}`);
  for (const field of fields)
    if (!Object.hasOwn(object, field))
      fail('MISSING_FIELD', `${path}.${field}`, `missing required field ${field}`);
  return object;
}

function boundedString(value: unknown, path: string, allowBlank = false): string {
  const text = typeof value === 'string' ? value : fail('INVALID_TYPE', path, 'expected a string');
  if (Buffer.byteLength(text, 'utf8') > PLAN_CRITIQUE_STRING_MAX_BYTES)
    fail('STRING_TOO_LONG', path, `string exceeds ${PLAN_CRITIQUE_STRING_MAX_BYTES} UTF-8 bytes`);
  if (!allowBlank && text.trim().length === 0)
    fail('INVALID_VALUE', path, 'string must not be blank');
  return text;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
): T[number] {
  const text = typeof value === 'string' ? value : fail('INVALID_TYPE', path, 'expected a string');
  if (!(allowed as readonly string[]).includes(text))
    fail('INVALID_VALUE', path, `expected one of ${allowed.join(', ')}`);
  return text as T[number];
}

function boundedArray(value: unknown, path: string, max: number): unknown[] {
  const items = Array.isArray(value) ? value : fail('INVALID_TYPE', path, 'expected an array');
  if (items.length > max) fail('ARRAY_TOO_LONG', path, `array exceeds ${max} items`);
  return items;
}

function stringArray(value: unknown, path: string): string[] {
  return boundedArray(value, path, PLAN_CRITIQUE_MAX_STRINGS).map((item, index) =>
    boundedString(item, `${path}[${index}]`),
  );
}

function booleanValue(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : fail('INVALID_TYPE', path, 'expected a boolean');
}

function parseScope(value: unknown, path: string): PlanCritiqueScope {
  const object = exactObject(value, path, ['frontend', 'backend', 'shared']);
  return {
    frontend: booleanValue(object.frontend, `${path}.frontend`),
    backend: booleanValue(object.backend, `${path}.backend`),
    shared: booleanValue(object.shared, `${path}.shared`),
  };
}

function parseDecisionLogAlignment(value: unknown, path: string): PlanCritiqueDecisionLogAlignment {
  const object = exactObject(value, path, ['present', 'targetsQueried', 'conflicts']);
  return {
    present: booleanValue(object.present, `${path}.present`),
    targetsQueried: stringArray(object.targetsQueried, `${path}.targetsQueried`),
    conflicts: stringArray(object.conflicts, `${path}.conflicts`),
  };
}

function parseConfigurationRow(value: unknown, path: string): PlanCritiqueConfigurationRow {
  const object = exactObject(value, path, [
    'configuration',
    'expected',
    'proposed',
    'correct',
    'evidence',
  ]);
  return {
    configuration: boundedString(object.configuration, `${path}.configuration`),
    expected: boundedString(object.expected, `${path}.expected`),
    proposed: boundedString(object.proposed, `${path}.proposed`),
    correct: booleanValue(object.correct, `${path}.correct`),
    evidence: boundedString(object.evidence, `${path}.evidence`),
  };
}

function parseAnalysis(value: unknown, path: string, allowBlank: boolean): PlanCritiqueAnalysis {
  const object = exactObject(value, path, [
    'title',
    'proposal',
    'decisionLogAlignment',
    'sourceToSinkTrace',
    'implicitAssumptions',
    'layoutAlignment',
    'configurationRows',
    'missingConsiderations',
  ]);
  return {
    title: boundedString(object.title, `${path}.title`, allowBlank),
    proposal: boundedString(object.proposal, `${path}.proposal`, allowBlank),
    decisionLogAlignment: parseDecisionLogAlignment(
      object.decisionLogAlignment,
      `${path}.decisionLogAlignment`,
    ),
    sourceToSinkTrace: boundedString(
      object.sourceToSinkTrace,
      `${path}.sourceToSinkTrace`,
      allowBlank,
    ),
    implicitAssumptions: stringArray(object.implicitAssumptions, `${path}.implicitAssumptions`),
    layoutAlignment: boundedString(object.layoutAlignment, `${path}.layoutAlignment`, allowBlank),
    configurationRows: boundedArray(
      object.configurationRows,
      `${path}.configurationRows`,
      PLAN_CRITIQUE_MAX_STRINGS,
    ).map((row, index) => parseConfigurationRow(row, `${path}.configurationRows[${index}]`)),
    missingConsiderations: stringArray(
      object.missingConsiderations,
      `${path}.missingConsiderations`,
    ),
  };
}

function parseFeasibility(value: unknown, path: string): PlanCritiqueFeasibility {
  const object = exactObject(value, path, ['status', 'evidence', 'blockers']);
  return {
    status: oneOf(object.status, `${path}.status`, PLAN_CRITIQUE_FEASIBILITY_STATUSES),
    evidence: stringArray(object.evidence, `${path}.evidence`),
    blockers: stringArray(object.blockers, `${path}.blockers`),
  };
}

function parseFinding(value: unknown, path: string): PlanCritiqueFinding {
  const object = exactObject(value, path, [
    'severity',
    'lens',
    'claim',
    'evidence',
    'impact',
    'recommendation',
  ]);
  return {
    severity: oneOf(object.severity, `${path}.severity`, ['CRITICAL', 'WARNING'] as const),
    lens: oneOf(object.lens, `${path}.lens`, PLAN_CRITIQUE_LENSES),
    claim: boundedString(object.claim, `${path}.claim`),
    evidence: boundedString(object.evidence, `${path}.evidence`),
    impact: boundedString(object.impact, `${path}.impact`),
    recommendation: boundedString(object.recommendation, `${path}.recommendation`),
  };
}

function parseRisk(value: unknown, path: string): PlanCritiqueRisk {
  const object = exactObject(value, path, ['id', 'layer', 'category', 'triggers']);
  return {
    id: boundedString(object.id, `${path}.id`),
    layer: oneOf(object.layer, `${path}.layer`, [
      'frontend',
      'backend',
      'shared',
      'cross',
    ] as const),
    category: oneOf(object.category, `${path}.category`, PLAN_CRITIQUE_EDGE_CASE_CATEGORIES),
    triggers: stringArray(object.triggers, `${path}.triggers`),
  };
}

function parseEdgeCase(value: unknown, path: string): PlanCritiqueEdgeCase {
  const object = exactObject(value, path, [
    'id',
    'risk',
    'scenario',
    'expectedBehavior',
    'testType',
    'coverageStatus',
    'coveredBy',
    'notes',
  ]);
  return {
    id: boundedString(object.id, `${path}.id`),
    risk: parseRisk(object.risk, `${path}.risk`),
    scenario: boundedString(object.scenario, `${path}.scenario`),
    expectedBehavior: boundedString(object.expectedBehavior, `${path}.expectedBehavior`),
    testType: oneOf(object.testType, `${path}.testType`, ['unit', 'integration', 'e2e'] as const),
    coverageStatus: oneOf(object.coverageStatus, `${path}.coverageStatus`, [
      'not-covered',
      'covered',
    ] as const),
    coveredBy: stringArray(object.coveredBy, `${path}.coveredBy`),
    notes: boundedString(object.notes, `${path}.notes`, true),
  };
}

function parseReference(value: unknown, path: string): PlanCritiqueResearchReference {
  const object = exactObject(value, path, ['title', 'url']);
  const url = boundedString(object.url, `${path}.url`);
  if (
    [...url].some((character) => {
      const code = character.charCodeAt(0);
      return URL_WHITESPACE_RE.test(character) || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  )
    fail('INVALID_URL', `${path}.url`, 'URL must not contain whitespace or control characters');
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return fail('INVALID_URL', `${path}.url`, 'expected an absolute http/https URL');
    }
  })();
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname)
    fail('INVALID_URL', `${path}.url`, 'expected an absolute http/https URL');
  return { title: boundedString(object.title, `${path}.title`), url };
}

function parseAction(value: unknown, path: string): PlanCritiqueAction {
  const candidate = isRecord(value) ? value : fail('INVALID_TYPE', path, 'expected an object');
  if (!Object.hasOwn(candidate, 'kind'))
    fail('MISSING_FIELD', `${path}.kind`, 'missing required field kind');
  const kind = oneOf(candidate.kind, `${path}.kind`, PLAN_CRITIQUE_ACTION_KINDS);
  if (kind === 'route_implementation_reviewer') {
    exactObject(value, path, ['kind']);
    return { kind };
  }
  const object = exactObject(value, path, ['kind', 'detail']);
  return { kind, detail: boundedString(object.detail, `${path}.detail`) };
}

function parseObject(value: unknown): PlanCritiqueResponseV1 {
  const object = exactObject(
    value,
    '$',
    [
      'schemaVersion',
      'kind',
      'phase',
      'scope',
      'analysis',
      'status',
      'verdict',
      'feasibility',
      'frameMeta',
      'uxImpact',
      'summary',
      'findings',
      'edgeCases',
      'actions',
      'strengths',
      'researchReferences',
    ],
    true,
  );
  if (object.schemaVersion !== 1)
    fail('INVALID_VALUE', '$.schemaVersion', 'schemaVersion must be 1');
  if (object.kind !== 'plan_critique')
    fail('INVALID_VALUE', '$.kind', 'kind must be plan_critique');
  if (object.phase !== 'plan') fail('INVALID_VALUE', '$.phase', 'phase must be plan');
  const status = oneOf(object.status, '$.status', PLAN_CRITIQUE_STATUSES);
  const uxImpact = exactObject(object.uxImpact, '$.uxImpact', ['level', 'detail']);
  const response: PlanCritiqueResponseV1 = {
    schemaVersion: 1,
    kind: 'plan_critique',
    phase: 'plan',
    scope: parseScope(object.scope, '$.scope'),
    analysis: parseAnalysis(object.analysis, '$.analysis', status !== 'reviewed'),
    status,
    verdict:
      object.verdict === null ? null : oneOf(object.verdict, '$.verdict', PLAN_CRITIQUE_VERDICTS),
    feasibility:
      object.feasibility === null ? null : parseFeasibility(object.feasibility, '$.feasibility'),
    frameMeta: oneOf(object.frameMeta, '$.frameMeta', PLAN_CRITIQUE_FRAME_METAS),
    uxImpact: {
      level: oneOf(uxImpact.level, '$.uxImpact.level', ['none', 'degrades'] as const),
      detail: boundedString(uxImpact.detail, '$.uxImpact.detail'),
    },
    summary: boundedString(object.summary, '$.summary'),
    findings: boundedArray(object.findings, '$.findings', PLAN_CRITIQUE_MAX_FINDINGS).map(
      (finding, index) => parseFinding(finding, `$.findings[${index}]`),
    ),
    edgeCases: boundedArray(object.edgeCases, '$.edgeCases', PLAN_CRITIQUE_MAX_EDGE_CASES).map(
      (edgeCase, index) => parseEdgeCase(edgeCase, `$.edgeCases[${index}]`),
    ),
    actions: boundedArray(object.actions, '$.actions', PLAN_CRITIQUE_MAX_STRINGS).map(
      (action, index) => parseAction(action, `$.actions[${index}]`),
    ),
    strengths: stringArray(object.strengths, '$.strengths'),
    researchReferences: boundedArray(
      object.researchReferences,
      '$.researchReferences',
      PLAN_CRITIQUE_MAX_STRINGS,
    ).map((reference, index) => parseReference(reference, `$.researchReferences[${index}]`)),
  };
  validatePlanCritiqueStatus(response, (path, requirement) =>
    fail('INVALID_STATUS_COMBINATION', path, requirement),
  );
  return response;
}

/** Parse untrusted model output. Every malformed-input path returns an error and never escapes. */
export function parsePlanCritiqueResponse(raw: string): ParsePlanCritiqueResponseResult {
  if (typeof raw !== 'string')
    return {
      ok: false,
      error: { code: 'INVALID_TYPE', path: '$', message: 'response must be a string' },
    };
  if (Buffer.byteLength(raw, 'utf8') > PLAN_CRITIQUE_RESPONSE_MAX_BYTES)
    return {
      ok: false,
      error: {
        code: 'INPUT_TOO_LARGE',
        path: '$',
        message: `response exceeds ${PLAN_CRITIQUE_RESPONSE_MAX_BYTES} UTF-8 bytes`,
      },
    };
  if (raw.trimStart().startsWith('```'))
    return {
      ok: false,
      error: { code: 'FENCED_JSON', path: '$', message: 'response must not use a Markdown fence' },
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
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
  } catch (error) {
    if (error instanceof ContractFailure) return { ok: false, error: error.contractError };
    return {
      ok: false,
      error: { code: 'INVALID_VALUE', path: '$', message: 'response failed validation' },
    };
  }
}
