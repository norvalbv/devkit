import { describe, expect, it } from 'vitest';
import {
  capturePlanCritiqueCompletedCallback,
  PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES,
  PLAN_CRITIQUE_PROJECTION_MAX_ITEMS,
  type PlanCritiqueCompletedCallbackV1,
} from '../capture-normalizer.mts';
import { PLAN_CRITIQUE_PROJECTION_MAX_BYTES, sha256Bytes } from '../evidence-record.mts';
import {
  readPlanCritiqueExactResponse,
  readPlanCritiqueProjection,
  readPlanCritiqueTranscript,
} from '../evidence-store.mts';
import type { PlanCritiqueResponseV1 } from '../response-contract.mts';
import { temporaryRoot } from './evidence-store-fixture.mts';
import { REVIEWED_RESPONSE } from './response-fixture.mts';

const bytes = (value: string): Buffer => Buffer.from(value, 'utf8');
type Captured = ReturnType<typeof capturePlanCritiqueCompletedCallback>;

interface StoredProjection {
  schemaVersion: number;
  kind: string;
  phase: string;
  status: string;
  verdict: string | null;
  feasibilityStatus: string | null;
  frameMeta: string;
  summary: string;
  findings: Array<{
    severity: string;
    lens: string;
    claim: string;
    impact: string;
    recommendation: string;
  }>;
  edgeCases: Array<{
    risk: { layer: string; category: string };
    scenario: string;
    expectedBehavior: string;
    testType: string;
  }>;
  actions: Array<{ kind: string; detail?: string }>;
  contentTrust: string;
  redacted: boolean;
  truncated: boolean;
}

function storedProjection(
  captured: Captured,
  root: string,
): {
  bytes: Buffer;
  value: StoredProjection;
} {
  const projection = readPlanCritiqueProjection(captured.record.critiqueId, { root });
  if (!projection) throw new Error('expected a stored projection');
  return { bytes: projection, value: JSON.parse(projection.toString('utf8')) as StoredProjection };
}

function reviewedResponse(): PlanCritiqueResponseV1 {
  return structuredClone(REVIEWED_RESPONSE);
}

function callback(exactResponse: Uint8Array): PlanCritiqueCompletedCallbackV1 {
  return {
    provider: 'codex',
    callbackIdentity: 'turn-1:agent-1',
    workId: 'work-1',
    repository: {
      fingerprint: sha256Bytes(bytes('repo')),
      fingerprintSource: 'canonical_remote',
      branch: 'codex/example',
      head: 'a'.repeat(40),
    },
    model: 'gpt-5.6',
    promptHash: sha256Bytes(bytes('prompt')),
    providerCompletedAt: '2026-07-21T12:00:00.000Z',
    exactResponse,
  };
}

function skipResponse(status: 'wrong_phase' | 'aborted'): string {
  return JSON.stringify({
    ...REVIEWED_RESPONSE,
    scope: { frontend: false, backend: false, shared: false },
    analysis: {
      title: '',
      proposal: '',
      decisionLogAlignment: { present: false, targetsQueried: [], conflicts: [] },
      sourceToSinkTrace: '',
      implicitAssumptions: [],
      layoutAlignment: '',
      configurationRows: [],
      missingConsiderations: [],
    },
    status,
    verdict: null,
    feasibility: null,
    frameMeta: 'SKIP',
    uxImpact: { level: 'none', detail: 'No plan critique was performed.' },
    findings: [],
    edgeCases: [],
    actions:
      status === 'wrong_phase'
        ? [{ kind: 'route_implementation_reviewer' }]
        : [{ kind: 'recommendation', detail: 'Retry the plan critique.' }],
    strengths: [],
    researchReferences: [],
  });
}

describe('normalizePlanCritiqueCompletedCallback', () => {
  it('derives reviewed contract facts and snapshots exact and optional transcript bytes', () => {
    const exact = bytes(JSON.stringify(REVIEWED_RESPONSE));
    const transcript = bytes('opaque transcript');
    const input = callback(exact);
    input.opaqueTranscript = {
      bytes: transcript,
      expiresAt: '2030-01-01T00:00:00.000Z',
    };

    const root = temporaryRoot();
    const captured = capturePlanCritiqueCompletedCallback(input, { root });
    exact.fill(0);
    transcript.fill(0);

    expect(captured.record.contract).toMatchObject({
      state: 'valid',
      error: null,
      status: 'reviewed',
      verdict: 'RETHINK',
      criticalCount: 1,
    });
    expect(
      readPlanCritiqueExactResponse(captured.record.critiqueId, { root })?.toString('utf8'),
    ).toBe(JSON.stringify(REVIEWED_RESPONSE));
    expect(readPlanCritiqueTranscript(captured.record.critiqueId, { root })?.toString('utf8')).toBe(
      'opaque transcript',
    );
    const projection = storedProjection(captured, root);
    expect(captured.record.sanitizedProjection).toMatchObject({
      byteLength: projection.bytes.byteLength,
      projectionSchemaVersion: 1,
    });
    expect(projection.value).toMatchObject({
      schemaVersion: 1,
      kind: 'plan_critique_projection',
      phase: 'plan',
      status: 'reviewed',
      verdict: 'RETHINK',
      feasibilityStatus: 'PARTIALLY_FEASIBLE',
      frameMeta: 'SOUND',
      summary: REVIEWED_RESPONSE.summary,
      actions: REVIEWED_RESPONSE.actions,
      contentTrust: 'untrusted',
      redacted: false,
      truncated: false,
    });
    expect(captured.record.execution).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6',
      promptHash: sha256Bytes(bytes('prompt')),
    });
  });

  it.each([
    'wrong_phase',
    'aborted',
  ] as const)('preserves valid %s status without inventing reviewed facts', (status) => {
    const root = temporaryRoot();
    const captured = capturePlanCritiqueCompletedCallback(callback(bytes(skipResponse(status))), {
      root,
    });
    expect(captured.record.contract).toMatchObject({
      state: 'valid',
      error: null,
      status,
      verdict: null,
      criticalCount: null,
    });
    expect(storedProjection(captured, root).value).toMatchObject({
      status,
      verdict: null,
      feasibilityStatus: null,
      frameMeta: 'SKIP',
      contentTrust: 'untrusted',
      redacted: false,
      truncated: false,
    });
  });

  it('records malformed, fenced, and non-UTF-8 exact responses as invalid contract evidence', () => {
    const cases = [
      { raw: bytes('{'), code: 'INVALID_JSON' },
      { raw: bytes('```json\n{}\n```'), code: 'FENCED_JSON' },
      { raw: Uint8Array.from([0xc3, 0x28]), code: 'INVALID_JSON' },
    ];
    for (const { raw, code } of cases) {
      const root = temporaryRoot();
      const captured = capturePlanCritiqueCompletedCallback(callback(raw), { root });
      expect(captured.record.contract).toMatchObject({
        state: 'invalid',
        error: { code, path: '$' },
        status: null,
        verdict: null,
        criticalCount: null,
      });
      expect(readPlanCritiqueExactResponse(captured.record.critiqueId, { root })).toEqual(
        Buffer.from(raw),
      );
      expect(captured.record.sanitizedProjection).toBeNull();
    }
  });

  it('allowlists projection fields and removes control characters from untrusted prose', () => {
    const response = reviewedResponse();
    const firstFinding = response.findings[0];
    const firstEdgeCase = response.edgeCases[0];
    if (!firstFinding || !firstEdgeCase) throw new Error('reviewed fixture is incomplete');
    response.findings[0] = {
      ...firstFinding,
      claim: 'claim\nwith\u0085\u202econtrols\u2066\u200b\u200e\u2028done',
      evidence: 'private evidence must not be projected',
      impact: 'impact\ttext',
      recommendation: 'recommendation\0text',
    };
    response.edgeCases[0] = {
      ...firstEdgeCase,
      id: 'private-edge-id',
      risk: {
        ...firstEdgeCase.risk,
        id: 'private-risk-id',
        triggers: ['trigger\r\ntext'],
      },
      scenario: 'scenario\u007ftext',
      expectedBehavior: 'expected\u001btext',
      coveredBy: ['private-test-path'],
      notes: 'private notes',
    };

    const root = temporaryRoot();
    const projected = storedProjection(
      capturePlanCritiqueCompletedCallback(callback(bytes(JSON.stringify(response))), { root }),
      root,
    );
    const projectedFinding = projected.value.findings[0];
    const projectedEdgeCase = projected.value.edgeCases[0];
    if (!projectedFinding || !projectedEdgeCase)
      throw new Error('expected projected finding and edge case');

    expect(Object.keys(projectedFinding)).toEqual([
      'severity',
      'lens',
      'claim',
      'impact',
      'recommendation',
    ]);
    expect(projectedFinding).toMatchObject({
      claim: 'claim with controls done',
      impact: 'impact text',
      recommendation: 'recommendation text',
    });
    expect(Object.keys(projectedEdgeCase)).toEqual([
      'risk',
      'scenario',
      'expectedBehavior',
      'testType',
    ]);
    expect(Object.keys(projectedEdgeCase.risk)).toEqual(['layer', 'category']);
    expect(projectedEdgeCase).toMatchObject({
      scenario: 'scenario text',
      expectedBehavior: 'expected text',
    });
    expect(projected.value.summary).toBe(response.summary);
    expect(projected.value.actions).toEqual(response.actions);
    expect(projected.value.redacted).toBe(false);
    const serialized = projected.bytes.toString('utf8');
    for (const excluded of [
      'private evidence',
      'private-edge-id',
      'private-risk-id',
      'trigger text',
      'private-test-path',
      'private notes',
    ]) {
      expect(serialized).not.toContain(excluded);
    }
  });

  it('redacts modeled credentials after Unicode normalization without changing exact evidence', () => {
    const response = reviewedResponse();
    const firstFinding = response.findings[0];
    const firstEdgeCase = response.edgeCases[0];
    if (!firstFinding || !firstEdgeCase) throw new Error('reviewed fixture is incomplete');
    const github = `github_pat_${'A'.repeat(24)}`;
    const splitOpenAi = `s\u200bk-${'b'.repeat(24)}`;
    const normalizedOpenAi = `sk-${'b'.repeat(24)}`;
    const slack = `xoxb-${'c'.repeat(20)}`;
    const aws = `AKIA${'D'.repeat(16)}`;
    const jwt = `eyJ${'e'.repeat(20)}.${'f'.repeat(10)}.${'g'.repeat(10)}`;
    const bearer = `Bearer ${'h'.repeat(24)}`;
    const basic = `Basic ${'i'.repeat(24)}`;
    const password = 'correct-horse-battery-staple';
    const querySecret = 'query-secret-value-1234567890';
    const awsSignature = 'aws-signature-value-1234567890';
    const awsSecurityToken = 'aws-security-token-value-1234567890';
    const jsonToken = 'json-token-value-1234567890';
    const yamlKey = 'yaml-key-value-1234567890';
    const databaseValue = 'database-value-1234567890';
    const privateKey =
      '-----BEGIN PRIVATE KEY-----\nFAKEKEYMATERIAL1234567890\n-----END PRIVATE KEY-----';
    const truncatedPrivateKey = '-----BEGIN PRIVATE KEY-----\nTRUNCATEDKEYMATERIAL1234567890';
    response.summary = `${github} ${splitOpenAi} ${slack} ${aws}`;
    response.findings[0] = {
      ...firstFinding,
      claim: jwt,
      impact: bearer,
      recommendation:
        'https://user:password@example.test/path postgresql://dbuser:dbpass@example.test/db',
    };
    response.edgeCases[0] = {
      ...firstEdgeCase,
      risk: { ...firstEdgeCase.risk, triggers: [`token=${'j'.repeat(24)}`] },
      scenario: `${privateKey} ${truncatedPrivateKey}`,
      expectedBehavior: `ｐａｓｓｗｏｒｄ="${password}" https://example.test/callback?signature=${querySecret}&X-Amz-Signature=${awsSignature}&X-Amz-Security-Token=${awsSecurityToken}`,
    };
    response.actions = [
      {
        kind: 'recommendation',
        detail: `${basic} authorization=${'k'.repeat(24)} "token":"${jsonToken}" 'api_key': '${yamlKey}' DATABASE_URL=${databaseValue}`,
      },
    ];

    const exact = bytes(JSON.stringify(response));
    const root = temporaryRoot();
    const captured = capturePlanCritiqueCompletedCallback(callback(exact), { root });
    const projected = storedProjection(captured, root);
    const repeated = capturePlanCritiqueCompletedCallback(callback(exact), {
      root: temporaryRoot(),
    });
    const serialized = projected.bytes.toString('utf8');

    expect(
      readPlanCritiqueExactResponse(captured.record.critiqueId, { root })?.toString('utf8'),
    ).toBe(JSON.stringify(response));
    for (const secret of [
      github,
      splitOpenAi,
      normalizedOpenAi,
      slack,
      aws,
      jwt,
      'h'.repeat(24),
      'i'.repeat(24),
      password,
      querySecret,
      awsSignature,
      awsSecurityToken,
      jsonToken,
      yamlKey,
      databaseValue,
      'FAKEKEYMATERIAL1234567890',
      'TRUNCATEDKEYMATERIAL1234567890',
      'j'.repeat(24),
      'k'.repeat(24),
      'user:password',
      'dbuser:dbpass',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(projected.value.redacted).toBe(true);
    expect(repeated.record.sanitizedProjection?.sha256).toBe(
      captured.record.sanitizedProjection?.sha256,
    );
    for (const kind of [
      'provider-token',
      'jwt',
      'authorization',
      'credentialed-url',
      'private-key',
      'secret-assignment',
      'sensitive-query',
    ]) {
      expect(serialized).toContain(`[REDACTED:${kind}]`);
    }
  });

  it('tracks actual retained summary redactions across the byte boundary', () => {
    const token = `github_pat_${'Q'.repeat(24)}`;
    const boundary = reviewedResponse();
    boundary.summary = `${'x'.repeat(1017)} ${token}`;
    const boundaryRoot = temporaryRoot();
    const boundaryProjection = storedProjection(
      capturePlanCritiqueCompletedCallback(callback(bytes(JSON.stringify(boundary))), {
        root: boundaryRoot,
      }),
      boundaryRoot,
    ).value;

    expect(boundaryProjection.summary.endsWith('[REDAC')).toBe(true);
    expect(boundaryProjection.redacted).toBe(true);
    expect(boundaryProjection.truncated).toBe(true);

    const forged = reviewedResponse();
    forged.summary = `[REDACTED:forged]${'x'.repeat(1100)} ${token}`;
    const forgedRoot = temporaryRoot();
    const forgedProjection = storedProjection(
      capturePlanCritiqueCompletedCallback(callback(bytes(JSON.stringify(forged))), {
        root: forgedRoot,
      }),
      forgedRoot,
    ).value;

    expect(forgedProjection.summary).toContain('[REDACTED:forged]');
    expect(forgedProjection.redacted).toBe(false);
    expect(forgedProjection.truncated).toBe(true);
  });

  it('keeps at most 25 whole items in findings-then-edge-case source order', () => {
    const response = reviewedResponse();
    response.findings = Array.from({ length: 10 }, (_, index) => ({
      severity: index === 0 ? ('CRITICAL' as const) : ('WARNING' as const),
      lens: 'DATA_FLOW' as const,
      claim: `finding-${index}`,
      evidence: 'e',
      impact: 'i',
      recommendation: 'r',
    }));
    response.edgeCases = Array.from({ length: 20 }, (_, index) => ({
      id: `EC-${index}`,
      risk: {
        id: `R-${index}`,
        layer: 'shared' as const,
        category: 'Contract & Boundary Handling' as const,
        triggers: ['t'],
      },
      scenario: `scenario-${index}`,
      expectedBehavior: 'b',
      testType: 'unit' as const,
      coverageStatus: 'not-covered' as const,
      coveredBy: [],
      notes: '',
    }));

    const root = temporaryRoot();
    const projected = storedProjection(
      capturePlanCritiqueCompletedCallback(callback(bytes(JSON.stringify(response))), { root }),
      root,
    ).value;

    expect(projected.findings.map((finding) => finding.claim)).toEqual(
      Array.from({ length: 10 }, (_, index) => `finding-${index}`),
    );
    expect(projected.edgeCases.map((edgeCase) => edgeCase.scenario)).toEqual(
      Array.from({ length: 15 }, (_, index) => `scenario-${index}`),
    );
    expect(projected.findings.length + projected.edgeCases.length).toBe(
      PLAN_CRITIQUE_PROJECTION_MAX_ITEMS,
    );
    expect(projected.truncated).toBe(true);
  });

  it('drops whole trailing items until the projection is within the UTF-8 byte cap', () => {
    const response = reviewedResponse();
    const criticalFinding = response.findings[0];
    const warningFinding = response.findings[1];
    if (!criticalFinding || !warningFinding) throw new Error('reviewed fixture is incomplete');
    response.summary = `${'🙂'.repeat(3_000)} github_pat_${'Y'.repeat(24)}`;
    response.findings = Array.from({ length: 12 }, (_, index) => ({
      ...(index === 0 ? criticalFinding : warningFinding),
      severity: index === 0 ? ('CRITICAL' as const) : ('WARNING' as const),
      claim: `finding-${index}-${'🙂'.repeat(350)}`,
    }));
    const lastEdgeCase = response.edgeCases.at(-1);
    if (!lastEdgeCase) throw new Error('reviewed fixture is incomplete');
    response.edgeCases[response.edgeCases.length - 1] = {
      ...lastEdgeCase,
      scenario: `github_pat_${'Z'.repeat(24)}`,
    };

    const firstRoot = temporaryRoot();
    const first = capturePlanCritiqueCompletedCallback(callback(bytes(JSON.stringify(response))), {
      root: firstRoot,
    });
    const projected = storedProjection(first, firstRoot);
    const second = capturePlanCritiqueCompletedCallback(callback(bytes(JSON.stringify(response))), {
      root: temporaryRoot(),
    });

    expect(projected.bytes.byteLength).toBeLessThanOrEqual(PLAN_CRITIQUE_PROJECTION_MAX_BYTES);
    expect(Buffer.from(projected.bytes.toString('utf8'), 'utf8')).toEqual(projected.bytes);
    expect(Buffer.byteLength(projected.value.summary, 'utf8')).toBe(1024);
    expect(projected.value.truncated).toBe(true);
    expect(projected.value.edgeCases).toEqual([]);
    expect(projected.value.redacted).toBe(false);
    expect(projected.value.findings.length + projected.value.edgeCases.length).toBeLessThan(14);
    projected.value.findings.forEach((finding, index) => {
      expect(finding.claim).toBe(response.findings.at(index)?.claim);
    });
    expect(second.record.sanitizedProjection?.sha256).toBe(
      first.record.sanitizedProjection?.sha256,
    );
  });

  it('domain-separates stable callback identities by provider', () => {
    const exact = bytes(JSON.stringify(REVIEWED_RESPONSE));
    const codex = capturePlanCritiqueCompletedCallback(callback(exact), { root: temporaryRoot() });
    const claudeInput = callback(exact);
    claudeInput.provider = 'claude';
    const claude = capturePlanCritiqueCompletedCallback(claudeInput, { root: temporaryRoot() });

    expect(codex.record.execution.callbackHash).toMatch(/^[0-9a-f]{64}$/);
    expect(claude.record.execution.callbackHash).not.toBe(codex.record.execution.callbackHash);
    expect(
      capturePlanCritiqueCompletedCallback(callback(exact), { root: temporaryRoot() }).record
        .execution.callbackHash,
    ).toBe(codex.record.execution.callbackHash);
  });

  it.each([
    '',
    '  ',
    'line\nbreak',
    'x'.repeat(PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES + 1),
  ])('rejects an unsafe callback identity', (callbackIdentity) => {
    const input = callback(bytes(JSON.stringify(REVIEWED_RESPONSE)));
    input.callbackIdentity = callbackIdentity;
    expect(() => capturePlanCritiqueCompletedCallback(input, { root: temporaryRoot() })).toThrow(
      'invalid plan critique callback identity',
    );
  });

  it('rejects an unsupported runtime provider before returning a callback hash', () => {
    const input = callback(bytes(JSON.stringify(REVIEWED_RESPONSE)));
    (input as { provider: string }).provider = 'other';
    expect(() => capturePlanCritiqueCompletedCallback(input, { root: temporaryRoot() })).toThrow(
      'invalid plan critique callback identity',
    );
  });
});
