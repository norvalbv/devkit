import { describe, expect, it } from 'vitest';
import {
  capturePlanCritiqueCompletedCallback,
  PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES,
  type PlanCritiqueCompletedCallbackV1,
} from '../capture-normalizer.mts';
import { sha256Bytes } from '../evidence-record.mts';
import { readPlanCritiqueExactResponse, readPlanCritiqueTranscript } from '../evidence-store.mts';
import { temporaryRoot } from './evidence-store-fixture.mts';
import { REVIEWED_RESPONSE } from './response-fixture.mts';

const bytes = (value: string): Buffer => Buffer.from(value, 'utf8');

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
    expect(captured.record.sanitizedProjection).toBeNull();
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
    const captured = capturePlanCritiqueCompletedCallback(callback(bytes(skipResponse(status))), {
      root: temporaryRoot(),
    });
    expect(captured.record.contract).toMatchObject({
      state: 'valid',
      error: null,
      status,
      verdict: null,
      criticalCount: null,
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
    }
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
