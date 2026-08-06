import { describe, expect, it } from 'vitest';
import { type PriorArtResponseV1, parsePriorArtResponse } from '../response-contract.mts';

const raw = (value: unknown): string => JSON.stringify(value);

const LEGS_ALL_REACHED = [
  {
    leg: 'local',
    status: 'reached',
    detail: 'searched 2 resolved checkouts',
    declaredCheckouts: 1,
    resolvedCheckouts: 2,
  },
  { leg: 'github', status: 'reached', detail: 'gh code search over the SDK' },
  { leg: 'web', status: 'reached', detail: 'docs + changelog' },
  { leg: 'deep-research', status: 'unavailable', detail: 'MCP not configured' },
] as const;

const QUESTIONS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((id) => ({
  id,
  status: id === 'Q4' ? 'ANSWERED' : 'NO_EVIDENCE',
  finding: `${id} finding`,
}));

const EVIDENCE_LOCAL = {
  kind: 'local',
  source: 'cloned-projects/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts',
  repoRoot: 'cloned-projects/t3code',
  claim: 'Same SDK consumed for the session lifetime; no per-turn stand-down exists.',
  quote: 'Stream.takeWhile(() => !context.stopped)',
} as const;

const reviewed = (overrides: Partial<PriorArtResponseV1> = {}): unknown => ({
  schemaVersion: 1,
  kind: 'prior_art',
  phase: 'problem',
  status: 'reviewed',
  problem: {
    statement: 'Final message lost when background work outlives the turn.',
    restatedFrame: 'Assumes a per-turn consumer must guess when the stream is done.',
    assumedConstraints: ['the turn boundary exists'],
  },
  verdict: 'SOLVED_ELSEWHERE',
  confidence: 'high',
  legs: LEGS_ALL_REACHED,
  frameChallenge: { framing: 'NARROWS', upstreamChoice: null, boundaryMustExist: 'unknown' },
  questions: QUESTIONS,
  evidence: [EVIDENCE_LOCAL],
  suggestedNextStep: { kind: 'adopt_existing', detail: 'Adopt the session-lifetime consumer.' },
  routing: null,
  summary: 'A peer consumer of the same SDK dissolves the guess.',
  researchReferences: [],
  ...overrides,
});

const errorCodeOf = (value: unknown): string => {
  const result = parsePriorArtResponse(raw(value));
  if (result.ok) throw new Error('expected a contract failure');
  return result.error.code;
};

describe('parsePriorArtResponse — reviewed happy paths', () => {
  it('accepts a SOLVED_ELSEWHERE response with non-web evidence', () => {
    const result = parsePriorArtResponse(raw(reviewed()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verdict).toBe('SOLVED_ELSEWHERE');
  });

  it('accepts DISSOLVE_FRAME with a named upstream choice and reframe next step', () => {
    const result = parsePriorArtResponse(
      raw(
        reviewed({
          verdict: 'DISSOLVE_FRAME',
          frameChallenge: {
            framing: 'DISSOLVES',
            upstreamChoice: 'the per-turn consumer model',
            boundaryMustExist: 'no',
          },
          suggestedNextStep: { kind: 'reframe', detail: 'Consume per-session instead.' },
        }),
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts GENUINE_NEW_WORK when local resolved checkouts and an external leg are reached', () => {
    const result = parsePriorArtResponse(
      raw(
        reviewed({
          verdict: 'GENUINE_NEW_WORK',
          evidence: [
            {
              kind: 'upstream',
              source: 'upstream issue #482',
              repoRoot: null,
              claim: 'Maintainers declined the capability as wontfix.',
              quote: 'consumers should map their own findings',
            },
          ],
          suggestedNextStep: { kind: 'proceed_to_plan', detail: 'Build the mapping here.' },
        }),
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe('parsePriorArtResponse — absence-laundering guards', () => {
  it('rejects a local leg attesting reached with zero resolved checkouts', () => {
    const legs = [
      { ...LEGS_ALL_REACHED[0], declaredCheckouts: 0, resolvedCheckouts: 0 },
      ...LEGS_ALL_REACHED.slice(1),
    ];
    expect(errorCodeOf(reviewed({ legs: legs as never }))).toBe('INVALID_STATUS_COMBINATION');
  });

  it('rejects GENUINE_NEW_WORK when the local leg is unavailable (undeclared checkouts)', () => {
    const legs = [
      {
        leg: 'local',
        status: 'unavailable',
        detail: 'no referenceCheckouts declared',
        declaredCheckouts: 0,
        resolvedCheckouts: 0,
      },
      ...LEGS_ALL_REACHED.slice(1),
    ];
    expect(
      errorCodeOf(
        reviewed({
          verdict: 'GENUINE_NEW_WORK',
          legs: legs as never,
          suggestedNextStep: { kind: 'proceed_to_plan', detail: 'build it' },
        }),
      ),
    ).toBe('INVALID_STATUS_COMBINATION');
  });

  it('rejects GENUINE_NEW_WORK when no external leg was reached (gh failed, web dark)', () => {
    const legs = [
      LEGS_ALL_REACHED[0],
      { leg: 'github', status: 'failed', detail: 'gh unauthenticated (401)' },
      { leg: 'web', status: 'unavailable', detail: 'offline' },
      { leg: 'deep-research', status: 'unavailable', detail: 'MCP not configured' },
    ];
    expect(
      errorCodeOf(
        reviewed({
          verdict: 'GENUINE_NEW_WORK',
          legs: legs as never,
          suggestedNextStep: { kind: 'proceed_to_plan', detail: 'build it' },
        }),
      ),
    ).toBe('INVALID_STATUS_COMBINATION');
  });

  it('rejects GENUINE_NEW_WORK when Q4 was not answered', () => {
    const questions = QUESTIONS.map((question) =>
      question.id === 'Q4' ? { ...question, status: 'NO_EVIDENCE' } : question,
    );
    expect(
      errorCodeOf(
        reviewed({
          verdict: 'GENUINE_NEW_WORK',
          questions: questions as never,
          suggestedNextStep: { kind: 'proceed_to_plan', detail: 'build it' },
        }),
      ),
    ).toBe('INVALID_STATUS_COMBINATION');
  });

  it('rejects fabricated external evidence when its leg was never reached', () => {
    const darkLegs = [
      {
        leg: 'local',
        status: 'unavailable',
        detail: 'no checkouts declared',
        declaredCheckouts: 0,
        resolvedCheckouts: 0,
      },
      { leg: 'github', status: 'unavailable', detail: 'gh absent' },
      { leg: 'web', status: 'unavailable', detail: 'offline' },
      { leg: 'deep-research', status: 'unavailable', detail: 'MCP not configured' },
    ];
    expect(
      errorCodeOf(
        reviewed({
          legs: darkLegs as never,
          evidence: [{ ...EVIDENCE_LOCAL, kind: 'github', repoRoot: null }],
        }),
      ),
    ).toBe('INVALID_STATUS_COMBINATION');
  });

  it('rejects checkout-claiming local evidence (repoRoot set) when the local leg never reached', () => {
    const legs = [
      {
        leg: 'local',
        status: 'unavailable',
        detail: 'no checkouts declared',
        declaredCheckouts: 0,
        resolvedCheckouts: 0,
      },
      ...LEGS_ALL_REACHED.slice(1),
    ];
    expect(errorCodeOf(reviewed({ legs: legs as never }))).toBe('INVALID_STATUS_COMBINATION');
  });

  it('credits a reached deep-research leg for web and upstream evidence', () => {
    const legs = [
      LEGS_ALL_REACHED[0],
      { leg: 'github', status: 'failed', detail: 'gh unauthenticated' },
      { leg: 'web', status: 'unavailable', detail: 'offline fetch tool' },
      { leg: 'deep-research', status: 'reached', detail: 'deep-research MCP report' },
    ];
    const result = parsePriorArtResponse(
      raw(
        reviewed({
          legs: legs as never,
          evidence: [
            {
              kind: 'upstream',
              source: 'deep-research report: upstream changelog v2.4',
              repoRoot: null,
              claim: 'The capability shipped upstream in v2.4.',
              quote: 'Added session-lifetime consumption mode',
            },
          ],
        }),
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts leg-independent local evidence (own-repo record) even with zero checkouts', () => {
    const legs = [
      {
        leg: 'local',
        status: 'unavailable',
        detail: 'no checkouts declared; own decision log searched',
        declaredCheckouts: 0,
        resolvedCheckouts: 0,
      },
      ...LEGS_ALL_REACHED.slice(1),
    ];
    const result = parsePriorArtResponse(
      raw(
        reviewed({
          verdict: 'DISSOLVE_FRAME',
          legs: legs as never,
          frameChallenge: {
            framing: 'DISSOLVES',
            upstreamChoice: 'the unbuilt canonical-home Target',
            boundaryMustExist: 'no',
          },
          evidence: [
            {
              ...EVIDENCE_LOCAL,
              source: 'docs/decisions/provider-config-canonical-home.md',
              repoRoot: null,
            },
          ],
          suggestedNextStep: { kind: 'reframe', detail: 'Honour the recorded Target instead.' },
        }),
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects SOLVED_ELSEWHERE supported only by web evidence', () => {
    expect(
      errorCodeOf(
        reviewed({
          evidence: [{ ...EVIDENCE_LOCAL, kind: 'web', repoRoot: null }],
        }),
      ),
    ).toBe('INVALID_STATUS_COMBINATION');
  });

  it('rejects INSUFFICIENT_EVIDENCE with high confidence', () => {
    expect(
      errorCodeOf(
        reviewed({
          verdict: 'INSUFFICIENT_EVIDENCE',
          confidence: 'high',
          suggestedNextStep: { kind: 'gather_evidence', detail: 'file the vendor ticket' },
        }),
      ),
    ).toBe('INVALID_STATUS_COMBINATION');
  });

  it('rejects DISSOLVE_FRAME without a named upstream choice', () => {
    expect(
      errorCodeOf(
        reviewed({
          verdict: 'DISSOLVE_FRAME',
          frameChallenge: { framing: 'DISSOLVES', upstreamChoice: null, boundaryMustExist: 'no' },
          suggestedNextStep: { kind: 'reframe', detail: 'reframe it' },
        }),
      ),
    ).toBe('INVALID_STATUS_COMBINATION');
  });
});

describe('parsePriorArtResponse — verdict/next-step coupling', () => {
  it('rejects a verdict whose suggested next step does not couple', () => {
    expect(
      errorCodeOf(reviewed({ suggestedNextStep: { kind: 'reframe', detail: 'mismatch' } })),
    ).toBe('INVALID_STATUS_COMBINATION');
  });
});

describe('parsePriorArtResponse — non-reviewed shapes', () => {
  const neutral = (status: 'wrong_phase' | 'aborted', routing: string | null): unknown => ({
    schemaVersion: 1,
    kind: 'prior_art',
    phase: 'problem',
    status,
    problem: {
      statement: 'A drafted plan was handed over.',
      restatedFrame: '',
      assumedConstraints: [],
    },
    verdict: null,
    confidence: null,
    legs: [],
    frameChallenge: null,
    questions: [],
    evidence: [],
    suggestedNextStep: null,
    routing,
    summary: 'Routing to the plan critic.',
    researchReferences: [],
  });

  it('accepts wrong_phase with a routing and aborted without one', () => {
    expect(parsePriorArtResponse(raw(neutral('wrong_phase', 'route_feature_critique'))).ok).toBe(
      true,
    );
    expect(parsePriorArtResponse(raw(neutral('aborted', null))).ok).toBe(true);
  });

  it('rejects wrong_phase without routing and reviewed with routing', () => {
    expect(errorCodeOf(neutral('wrong_phase', null))).toBe('INVALID_STATUS_COMBINATION');
    expect(errorCodeOf(reviewed({ routing: 'route_feature_critique' as never }))).toBe(
      'INVALID_STATUS_COMBINATION',
    );
  });
});

describe('parsePriorArtResponse — tolerated elision', () => {
  it('tolerates count fields mirrored onto non-local legs (coupling reads only legs[0])', () => {
    const legs = [
      LEGS_ALL_REACHED[0],
      { ...LEGS_ALL_REACHED[1], declaredCheckouts: 1, resolvedCheckouts: 2 },
      ...LEGS_ALL_REACHED.slice(2),
    ];
    expect(parsePriorArtResponse(raw(reviewed({ legs: legs as never }))).ok).toBe(true);
  });

  it('parses an omitted researchReferences as the empty array, still validating when present', () => {
    const { researchReferences: _dropped, ...withoutRefs } = reviewed() as Record<string, unknown>;
    const result = parsePriorArtResponse(raw(withoutRefs));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.researchReferences).toEqual([]);
    expect(errorCodeOf(reviewed({ researchReferences: [{ title: 'x', url: 'not a url' }] }))).toBe(
      'INVALID_URL',
    );
  });
});

describe('parsePriorArtResponse — transport hygiene', () => {
  it('rejects fenced JSON, truncates oversized quotes, and rejects out-of-order legs', () => {
    expect(parsePriorArtResponse('```json\n{}\n```').ok).toBe(false);
    const truncated = parsePriorArtResponse(
      raw(reviewed({ evidence: [{ ...EVIDENCE_LOCAL, quote: 'x'.repeat(241) }] })),
    );
    expect(truncated.ok).toBe(true);
    if (truncated.ok) expect(truncated.value.evidence[0].quote).toHaveLength(240);
    // Legs out of order: slot 0 must be the local leg, whose required checkout counts the
    // github entry lacks — the shape check rejects before the name check ever runs.
    const shuffled = [LEGS_ALL_REACHED[1], LEGS_ALL_REACHED[0], ...LEGS_ALL_REACHED.slice(2)];
    expect(errorCodeOf(reviewed({ legs: shuffled as never }))).toBe('MISSING_FIELD');
  });
});
