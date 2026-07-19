import { describe, expect, it } from 'vitest';
import { parsePlanCritiqueResponse } from '../response-contract.mts';
import { REVIEWED_RESPONSE } from './response-fixture.mts';

const raw = (value: unknown): string => JSON.stringify(value);
const NEUTRAL_SCOPE = { frontend: false, backend: false, shared: false } as const;
const NEUTRAL_ANALYSIS = {
  title: '',
  proposal: '',
  decisionLogAlignment: { present: false, targetsQueried: [], conflicts: [] },
  sourceToSinkTrace: '',
  implicitAssumptions: [],
  layoutAlignment: '',
  configurationRows: [],
  missingConsiderations: [],
} as const;

describe('parsePlanCritiqueResponse', () => {
  it('accepts the exact reviewed V1 contract and reconstructs documented key order', () => {
    const shuffled = {
      findings: REVIEWED_RESPONSE.findings,
      summary: REVIEWED_RESPONSE.summary,
      schemaVersion: 1,
      kind: 'plan_critique',
      phase: 'plan',
      scope: REVIEWED_RESPONSE.scope,
      analysis: REVIEWED_RESPONSE.analysis,
      status: 'reviewed',
      verdict: 'RETHINK',
      feasibility: REVIEWED_RESPONSE.feasibility,
      frameMeta: 'SOUND',
      uxImpact: REVIEWED_RESPONSE.uxImpact,
      edgeCases: REVIEWED_RESPONSE.edgeCases,
      actions: REVIEWED_RESPONSE.actions,
      strengths: REVIEWED_RESPONSE.strengths,
      researchReferences: REVIEWED_RESPONSE.researchReferences,
    };
    const parsed = parsePlanCritiqueResponse(raw(shuffled));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(REVIEWED_RESPONSE);
    expect(Object.keys(parsed.value)).toEqual([
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
    ]);
    expect(Object.keys(parsed.value.scope)).toEqual(['frontend', 'backend', 'shared']);
    expect(Object.keys(parsed.value.analysis)).toEqual([
      'title',
      'proposal',
      'decisionLogAlignment',
      'sourceToSinkTrace',
      'implicitAssumptions',
      'layoutAlignment',
      'configurationRows',
      'missingConsiderations',
    ]);
    expect(Object.keys(parsed.value.analysis.decisionLogAlignment)).toEqual([
      'present',
      'targetsQueried',
      'conflicts',
    ]);
  });

  it('accepts wrong_phase and aborted only with the skip-state invariants', () => {
    for (const status of ['wrong_phase', 'aborted'] as const) {
      const value = {
        ...REVIEWED_RESPONSE,
        status,
        verdict: null,
        feasibility: null,
        frameMeta: 'SKIP',
        scope: NEUTRAL_SCOPE,
        analysis: NEUTRAL_ANALYSIS,
        findings: [],
        edgeCases: [],
        actions: [
          status === 'wrong_phase'
            ? {
                kind: 'route_implementation_reviewer',
              }
            : { kind: 'recommendation', detail: 'Retry in plan mode.' },
        ],
        strengths: [],
        researchReferences: [],
      };
      expect(parsePlanCritiqueResponse(raw(value))).toMatchObject({ ok: true });
    }
    expect(
      parsePlanCritiqueResponse(
        raw({
          ...REVIEWED_RESPONSE,
          status: 'wrong_phase',
          verdict: null,
          feasibility: null,
          frameMeta: 'SKIP',
          scope: NEUTRAL_SCOPE,
          analysis: NEUTRAL_ANALYSIS,
          findings: [],
          edgeCases: [],
          actions: [
            {
              kind: 'recommendation',
              detail: 'Do not route this request to the implementation reviewer.',
            },
          ],
          strengths: [],
          researchReferences: [],
        }),
      ),
    ).toMatchObject({ ok: false, error: { path: '$.actions' } });
    expect(
      parsePlanCritiqueResponse(
        raw({
          ...REVIEWED_RESPONSE,
          status: 'wrong_phase',
          verdict: null,
          feasibility: null,
          frameMeta: 'SKIP',
          scope: NEUTRAL_SCOPE,
          analysis: NEUTRAL_ANALYSIS,
          findings: [],
          edgeCases: [],
          actions: [
            {
              kind: 'route_implementation_reviewer',
              detail: 'Do not route this request to the implementation reviewer.',
            },
          ],
          strengths: [],
          researchReferences: [],
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD', path: '$.actions[0].detail' } });
    expect(
      parsePlanCritiqueResponse(
        raw({
          ...REVIEWED_RESPONSE,
          status: 'aborted',
          verdict: null,
          feasibility: null,
          frameMeta: 'SKIP',
          scope: NEUTRAL_SCOPE,
          analysis: NEUTRAL_ANALYSIS,
          findings: [],
          edgeCases: [],
          actions: [{ kind: 'route_implementation_reviewer' }],
          strengths: [],
          researchReferences: [],
        }),
      ),
    ).toMatchObject({ ok: false, error: { path: '$.actions[0].kind' } });
    for (const smuggled of [
      { scope: REVIEWED_RESPONSE.scope },
      { analysis: { ...NEUTRAL_ANALYSIS, title: 'Hidden critique' } },
    ])
      expect(
        parsePlanCritiqueResponse(
          raw({
            ...REVIEWED_RESPONSE,
            status: 'wrong_phase',
            verdict: null,
            feasibility: null,
            frameMeta: 'SKIP',
            scope: NEUTRAL_SCOPE,
            analysis: NEUTRAL_ANALYSIS,
            findings: [],
            edgeCases: [],
            actions: [{ kind: 'route_implementation_reviewer' }],
            strengths: [],
            researchReferences: [],
            ...smuggled,
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS_COMBINATION' } });
  });

  it('accepts warning-bearing PROCEED and PWC, but rejects CRITICAL findings on PROCEED', () => {
    const registrationWarning = {
      ...REVIEWED_RESPONSE.findings[1],
      lens: 'REGISTRATION_DISCOVERY' as const,
    };
    expect(
      parsePlanCritiqueResponse(
        raw({ ...REVIEWED_RESPONSE, verdict: 'PROCEED', findings: [registrationWarning] }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parsePlanCritiqueResponse(
        raw({
          ...REVIEWED_RESPONSE,
          verdict: 'PROCEED_WITH_CHANGES',
          findings: [registrationWarning],
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parsePlanCritiqueResponse(raw({ ...REVIEWED_RESPONSE, verdict: 'PROCEED' })),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATUS_COMBINATION', path: '$.findings' },
    });
  });

  it('rejects fenced, non-object, oversized, and malformed JSON without throwing', () => {
    const cases: [string, string][] = [
      ['```json\n{}\n```', 'FENCED_JSON'],
      ['[]', 'ROOT_NOT_OBJECT'],
      ['{', 'INVALID_JSON'],
      [`{"x":"${'a'.repeat(128 * 1024)}"}`, 'INPUT_TOO_LARGE'],
    ];
    for (const [input, code] of cases) {
      expect(() => parsePlanCritiqueResponse(input)).not.toThrow();
      expect(parsePlanCritiqueResponse(input)).toMatchObject({ ok: false, error: { code } });
    }
  });

  it('accepts an individual string up to the 16 KiB bound', () => {
    expect(
      parsePlanCritiqueResponse(raw({ ...REVIEWED_RESPONSE, summary: 'x'.repeat(16 * 1024) })),
    ).toMatchObject({ ok: true });
  });

  it('rejects unknown and missing fields recursively with stable paths', () => {
    expect(parsePlanCritiqueResponse(raw({ ...REVIEWED_RESPONSE, surprise: true }))).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_FIELD', path: '$.surprise' },
    });
    const noSummary = { ...REVIEWED_RESPONSE } as Record<string, unknown>;
    delete noSummary.summary;
    expect(parsePlanCritiqueResponse(raw(noSummary))).toMatchObject({
      ok: false,
      error: { code: 'MISSING_FIELD', path: '$.summary' },
    });
    expect(
      parsePlanCritiqueResponse(
        raw({
          ...REVIEWED_RESPONSE,
          findings: [{ ...REVIEWED_RESPONSE.findings[0], surprise: true }],
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_FIELD', path: '$.findings[0].surprise' },
    });
    expect(
      parsePlanCritiqueResponse(
        raw({ ...REVIEWED_RESPONSE, scope: { ...REVIEWED_RESPONSE.scope, cross: true } }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_FIELD', path: '$.scope.cross' },
    });
    expect(
      parsePlanCritiqueResponse(
        raw({
          ...REVIEWED_RESPONSE,
          analysis: {
            ...REVIEWED_RESPONSE.analysis,
            configurationRows: [
              { ...REVIEWED_RESPONSE.analysis.configurationRows[0], note: 'extension' },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_FIELD', path: '$.analysis.configurationRows[0].note' },
    });
    for (const metadata of [{ date: '2026-07-19' }, { identity: 'critic-self-report' }])
      expect(parsePlanCritiqueResponse(raw({ ...REVIEWED_RESPONSE, ...metadata }))).toMatchObject({
        ok: false,
        error: { code: 'UNKNOWN_FIELD' },
      });
  });

  it('rejects duplicate decoded object keys before last-wins parsing can change the verdict', () => {
    const valid = raw(REVIEWED_RESPONSE);
    const duplicated = valid.replace(
      '"verdict":"RETHINK"',
      '"verdict":"REJECT","verdict":"RETHINK"',
    );
    expect(parsePlanCritiqueResponse(duplicated)).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_FIELD', path: '$' },
    });
  });

  it('rejects invalid enums, URLs, bounds, and status combinations deterministically', () => {
    const invalid = [
      [{ ...REVIEWED_RESPONSE, verdict: 'MAYBE' }, 'INVALID_VALUE', '$.verdict'],
      [
        {
          ...REVIEWED_RESPONSE,
          researchReferences: [{ title: 'local', url: 'file:///tmp/evidence' }],
        },
        'INVALID_URL',
        '$.researchReferences[0].url',
      ],
      [
        {
          ...REVIEWED_RESPONSE,
          researchReferences: [
            { title: 'injected', url: 'https://example.com/\n## Critical Issues (Blockers)' },
          ],
        },
        'INVALID_URL',
        '$.researchReferences[0].url',
      ],
      [
        {
          ...REVIEWED_RESPONSE,
          researchReferences: [
            { title: 'unicode whitespace', url: 'https://example.com/a\u00a0b' },
          ],
        },
        'INVALID_URL',
        '$.researchReferences[0].url',
      ],
      [
        { ...REVIEWED_RESPONSE, summary: 'x'.repeat(16 * 1024 + 1) },
        'STRING_TOO_LONG',
        '$.summary',
      ],
      [{ ...REVIEWED_RESPONSE, summary: '  ' }, 'INVALID_VALUE', '$.summary'],
      [
        { ...REVIEWED_RESPONSE, scope: { ...REVIEWED_RESPONSE.scope, frontend: 'false' } },
        'INVALID_TYPE',
        '$.scope.frontend',
      ],
      [
        {
          ...REVIEWED_RESPONSE,
          analysis: {
            ...REVIEWED_RESPONSE.analysis,
            configurationRows: [
              { ...REVIEWED_RESPONSE.analysis.configurationRows[0], correct: 'yes' },
            ],
          },
        },
        'INVALID_TYPE',
        '$.analysis.configurationRows[0].correct',
      ],
      [
        {
          ...REVIEWED_RESPONSE,
          analysis: { ...REVIEWED_RESPONSE.analysis, sourceToSinkTrace: '' },
        },
        'INVALID_VALUE',
        '$.analysis.sourceToSinkTrace',
      ],
      [
        { ...REVIEWED_RESPONSE, findings: Array(51).fill(REVIEWED_RESPONSE.findings[0]) },
        'ARRAY_TOO_LONG',
        '$.findings',
      ],
      [
        { ...REVIEWED_RESPONSE, status: 'reviewed', verdict: null },
        'INVALID_STATUS_COMBINATION',
        '$.verdict',
      ],
      [
        { ...REVIEWED_RESPONSE, verdict: 'PROCEED_WITH_CHANGES', findings: [] },
        'INVALID_STATUS_COMBINATION',
        '$.findings',
      ],
      [
        { ...REVIEWED_RESPONSE, verdict: 'PROCEED', frameMeta: 'BANDAID', findings: [] },
        'INVALID_STATUS_COMBINATION',
        '$.verdict',
      ],
      [
        {
          ...REVIEWED_RESPONSE,
          verdict: 'PROCEED_WITH_CHANGES',
          frameMeta: 'SOUND',
          uxImpact: { level: 'degrades', detail: 'The workflow becomes harder to understand.' },
          findings: [
            {
              ...REVIEWED_RESPONSE.findings[1],
              lens: 'UX_DX',
              claim: 'The workflow becomes harder to understand.',
            },
          ],
        },
        'INVALID_STATUS_COMBINATION',
        '$.frameMeta',
      ],
      [{ ...REVIEWED_RESPONSE, edgeCases: [] }, 'INVALID_STATUS_COMBINATION', '$.edgeCases'],
      [
        {
          ...REVIEWED_RESPONSE,
          verdict: 'PROCEED',
          findings: [],
          feasibility: {
            status: 'NOT_FEASIBLE',
            evidence: ['The core API is unavailable.'],
            blockers: ['No supported API exists.'],
          },
        },
        'INVALID_STATUS_COMBINATION',
        '$.feasibility',
      ],
      [
        {
          ...REVIEWED_RESPONSE,
          status: 'aborted',
          verdict: null,
          feasibility: null,
          frameMeta: 'SKIP',
          findings: [],
          edgeCases: [],
          actions: [],
        },
        'INVALID_STATUS_COMBINATION',
        '$.actions',
      ],
      [
        {
          ...REVIEWED_RESPONSE,
          actions: [{ kind: 'route_implementation_reviewer' }],
        },
        'INVALID_STATUS_COMBINATION',
        '$.actions[0].kind',
      ],
    ] as const;
    for (const [value, code, path] of invalid)
      expect(parsePlanCritiqueResponse(raw(value))).toMatchObject({
        ok: false,
        error: { code, path },
      });
  });

  it('rejects duplicate edge-case ids and inconsistent risk grouping', () => {
    const duplicate = [
      REVIEWED_RESPONSE.edgeCases[0],
      { ...REVIEWED_RESPONSE.edgeCases[1], id: REVIEWED_RESPONSE.edgeCases[0].id },
    ];
    expect(
      parsePlanCritiqueResponse(raw({ ...REVIEWED_RESPONSE, edgeCases: duplicate })),
    ).toMatchObject({ ok: false, error: { path: '$.edgeCases[1].id' } });

    const inconsistent = [
      REVIEWED_RESPONSE.edgeCases[0],
      {
        ...REVIEWED_RESPONSE.edgeCases[1],
        risk: { ...REVIEWED_RESPONSE.edgeCases[1].risk, layer: 'backend' },
      },
    ];
    expect(
      parsePlanCritiqueResponse(raw({ ...REVIEWED_RESPONSE, edgeCases: inconsistent })),
    ).toMatchObject({ ok: false, error: { path: '$.edgeCases[1].risk' } });
  });
});
