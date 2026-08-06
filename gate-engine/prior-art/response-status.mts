/**
 * Closed-world V1 vocabulary + status-combination rules for the prior-art response.
 *
 * Split from response-contract.mts (the parser) for the size cap, mirroring the critique
 * contract's response-status.mts. The verdict↔evidence↔legs coupling lives HERE, not in prose:
 * a verdict a dark leg cannot support fails validation — neither tool absence nor declaration
 * absence may launder into evidence of capability absence.
 */

export const PRIOR_ART_STATUSES = ['reviewed', 'wrong_phase', 'aborted'] as const;
export type PriorArtStatus = (typeof PRIOR_ART_STATUSES)[number];

export const PRIOR_ART_VERDICTS = [
  'SOLVED_ELSEWHERE',
  'DISSOLVE_FRAME',
  'GENUINE_NEW_WORK',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type PriorArtVerdict = (typeof PRIOR_ART_VERDICTS)[number];

export const PRIOR_ART_CONFIDENCES = ['high', 'medium', 'low'] as const;
export const PRIOR_ART_FRAMINGS = ['HOLDS', 'NARROWS', 'DISSOLVES'] as const;
export const PRIOR_ART_BOUNDARY_ANSWERS = ['yes', 'no', 'unknown'] as const;
export const PRIOR_ART_LEG_NAMES = ['local', 'github', 'web', 'deep-research'] as const;
export type PriorArtLegName = (typeof PRIOR_ART_LEG_NAMES)[number];
export const PRIOR_ART_LEG_STATUSES = ['reached', 'unavailable', 'failed'] as const;
export const PRIOR_ART_QUESTION_IDS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] as const;
export const PRIOR_ART_QUESTION_STATUSES = ['ANSWERED', 'NO_EVIDENCE', 'NOT_APPLICABLE'] as const;
export const PRIOR_ART_EVIDENCE_KINDS = ['local', 'github', 'web', 'upstream'] as const;
export const PRIOR_ART_NEXT_STEP_KINDS = [
  'adopt_existing',
  'reframe',
  'proceed_to_plan',
  'gather_evidence',
] as const;
export const PRIOR_ART_ROUTINGS = [
  'route_feature_critique',
  'route_implementation_reviewer',
] as const;

export const PRIOR_ART_RESPONSE_MAX_BYTES = 64 * 1024;
export const PRIOR_ART_STRING_MAX_BYTES = 8 * 1024;
export const PRIOR_ART_QUOTE_MAX_CHARS = 240;
export const PRIOR_ART_MAX_ITEMS = 30;

export interface PriorArtLeg {
  leg: PriorArtLegName;
  status: (typeof PRIOR_ART_LEG_STATUSES)[number];
  detail: string;
  /** local leg only: declared glob patterns and the existing directories they resolved to. */
  declaredCheckouts?: number;
  resolvedCheckouts?: number;
}

export interface PriorArtQuestion {
  id: (typeof PRIOR_ART_QUESTION_IDS)[number];
  status: (typeof PRIOR_ART_QUESTION_STATUSES)[number];
  finding: string;
}

export interface PriorArtEvidence {
  kind: (typeof PRIOR_ART_EVIDENCE_KINDS)[number];
  source: string;
  repoRoot: string | null;
  claim: string;
  quote: string;
}

export interface PriorArtResponseV1 {
  schemaVersion: 1;
  kind: 'prior_art';
  phase: 'problem';
  status: PriorArtStatus;
  problem: { statement: string; restatedFrame: string; assumedConstraints: string[] };
  verdict: PriorArtVerdict | null;
  confidence: (typeof PRIOR_ART_CONFIDENCES)[number] | null;
  legs: PriorArtLeg[];
  frameChallenge: {
    framing: (typeof PRIOR_ART_FRAMINGS)[number];
    upstreamChoice: string | null;
    boundaryMustExist: (typeof PRIOR_ART_BOUNDARY_ANSWERS)[number];
  } | null;
  questions: PriorArtQuestion[];
  evidence: PriorArtEvidence[];
  suggestedNextStep: {
    kind: (typeof PRIOR_ART_NEXT_STEP_KINDS)[number];
    detail: string;
  } | null;
  routing: (typeof PRIOR_ART_ROUTINGS)[number] | null;
  summary: string;
  researchReferences: { title: string; url: string }[];
}

export type PriorArtResponseErrorCode =
  | 'ROOT_NOT_OBJECT'
  | 'INVALID_TYPE'
  | 'INVALID_VALUE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'DUPLICATE_FIELD'
  | 'STRING_TOO_LONG'
  | 'ARRAY_TOO_LONG'
  | 'INPUT_TOO_LARGE'
  | 'FENCED_JSON'
  | 'INVALID_JSON'
  | 'INVALID_URL'
  | 'INVALID_STATUS_COMBINATION';

export interface PriorArtResponseError {
  code: PriorArtResponseErrorCode;
  path: string;
  message: string;
}

export type ParsePriorArtResponseResult =
  | { ok: true; value: PriorArtResponseV1 }
  | { ok: false; error: PriorArtResponseError };

// ─── Status-combination rules (the coupling that makes the verdict earnable) ──────

/**
 * Validate the verdict↔evidence↔legs coupling. `combo` reports one violation and never returns
 * (the parser supplies its ContractFailure thrower), so validation stops at the first breach.
 */
export function validatePriorArtCoupling(
  response: PriorArtResponseV1,
  combo: (path: string, requirement: string) => never,
): void {
  if (response.status !== 'reviewed') {
    if (response.verdict !== null) combo('$.verdict', 'non-reviewed responses carry no verdict');
    if (response.confidence !== null)
      combo('$.confidence', 'non-reviewed responses carry no confidence');
    if (response.frameChallenge !== null)
      combo('$.frameChallenge', 'non-reviewed responses carry no frameChallenge');
    if (response.suggestedNextStep !== null)
      combo('$.suggestedNextStep', 'non-reviewed responses carry no suggestedNextStep');
    if (
      response.legs.length !== 0 ||
      response.questions.length !== 0 ||
      response.evidence.length !== 0
    )
      combo('$.legs', 'non-reviewed responses carry empty legs, questions, and evidence');
    if (response.status === 'wrong_phase' && response.routing === null)
      combo('$.routing', 'wrong_phase requires a routing');
    if (response.status === 'aborted' && response.routing !== null)
      combo('$.routing', 'aborted carries no routing');
    return;
  }
  if (response.routing !== null) combo('$.routing', 'reviewed responses carry no routing');
  const { verdict, confidence, frameChallenge, suggestedNextStep } = response;
  if (
    verdict === null ||
    confidence === null ||
    frameChallenge === null ||
    suggestedNextStep === null
  ) {
    combo(
      '$.verdict',
      'reviewed requires verdict, confidence, frameChallenge, and suggestedNextStep',
    );
    return; // combo always throws; the return is for control-flow narrowing only
  }
  if (response.legs.length !== PRIOR_ART_LEG_NAMES.length)
    combo('$.legs', 'reviewed requires all four legs attested');
  if (response.questions.length !== PRIOR_ART_QUESTION_IDS.length)
    combo('$.questions', 'reviewed requires all seven questions');
  const local = response.legs[0];
  const externalReached = response.legs.slice(1).some((entry) => entry.status === 'reached');
  // Evidence must name a source some leg could actually deliver — otherwise an all-dark response
  // with fabricated github/web citations earns a positive verdict (caught by the correctness
  // reviewer executing exactly that). Kind→leg mapping follows the agent md's taxonomy:
  // `local` with a null repoRoot is the consumer repo's OWN record — always readable, leg-
  // independent — while a non-null repoRoot claims a reference-checkout read and therefore
  // requires the local leg reached (the checkout counts additionally guard GENUINE_NEW_WORK);
  // `github` is the gh-CLI leg's shape specifically; `web` arrives via the web leg OR the
  // deep-research MCP (the md groups deep-research under web research); `upstream` facts
  // (issues, changelogs, docs) arrive via gh, the web, or deep-research, so any of the three.
  const reached = (index: number) => response.legs[index]?.status === 'reached';
  response.evidence.forEach((item, index) => {
    const supported =
      item.kind === 'local'
        ? item.repoRoot === null || reached(0)
        : item.kind === 'github'
          ? reached(1)
          : item.kind === 'web'
            ? reached(2) || reached(3)
            : reached(1) || reached(2) || reached(3);
    if (!supported)
      combo(
        `$.evidence[${index}].kind`,
        `${item.kind} evidence requires its research leg attested reached`,
      );
  });
  const nonWebEvidence = response.evidence.some((item) => item.kind !== 'web');
  const step = suggestedNextStep.kind;
  switch (verdict) {
    case 'SOLVED_ELSEWHERE':
      if (!nonWebEvidence)
        combo(
          '$.evidence',
          'SOLVED_ELSEWHERE requires local/github/upstream evidence actually read',
        );
      if (step !== 'adopt_existing')
        combo('$.suggestedNextStep.kind', 'SOLVED_ELSEWHERE requires next step adopt_existing');
      break;
    case 'DISSOLVE_FRAME':
      if (frameChallenge.framing !== 'DISSOLVES')
        combo('$.frameChallenge.framing', 'DISSOLVE_FRAME requires framing DISSOLVES');
      if (frameChallenge.upstreamChoice === null)
        combo(
          '$.frameChallenge.upstreamChoice',
          'DISSOLVE_FRAME requires the upstream choice named',
        );
      if (response.evidence.length === 0)
        combo('$.evidence', 'DISSOLVE_FRAME requires at least one evidence item');
      if (step !== 'reframe')
        combo('$.suggestedNextStep.kind', 'DISSOLVE_FRAME requires next step reframe');
      break;
    case 'GENUINE_NEW_WORK': {
      const q4 = response.questions.find((question) => question.id === 'Q4');
      if (q4?.status !== 'ANSWERED')
        combo(
          '$.questions',
          'GENUINE_NEW_WORK requires Q4 answered with positive absence evidence',
        );
      // `declaredCheckouts >= 1` is redundant with the parser (which rejects resolved-without-
      // declared outright) and deliberately restated: this validator is exported, so a caller
      // holding a hand-built response must not be able to earn the verdict off an undeclared scan.
      if (
        local.status !== 'reached' ||
        (local.resolvedCheckouts ?? 0) < 1 ||
        (local.declaredCheckouts ?? 0) < 1
      )
        combo(
          '$.legs[0]',
          'GENUINE_NEW_WORK requires the local leg reached over at least one declared, resolved checkout',
        );
      if (!externalReached)
        combo('$.legs', 'GENUINE_NEW_WORK requires at least one external leg reached');
      if (response.evidence.length === 0)
        combo('$.evidence', 'GENUINE_NEW_WORK requires the absence-search evidence listed');
      if (step !== 'proceed_to_plan')
        combo('$.suggestedNextStep.kind', 'GENUINE_NEW_WORK requires next step proceed_to_plan');
      break;
    }
    case 'INSUFFICIENT_EVIDENCE':
      if (step !== 'gather_evidence')
        combo(
          '$.suggestedNextStep.kind',
          'INSUFFICIENT_EVIDENCE requires next step gather_evidence',
        );
      if (response.confidence === 'high')
        combo('$.confidence', 'INSUFFICIENT_EVIDENCE confidence is never high');
      break;
  }
}
