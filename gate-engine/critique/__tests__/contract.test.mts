import { describe, expect, it } from 'vitest';
import { critiqueEligibility, parsePlanCritiqueResponse } from '../contract.mts';

const response = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: 'plan_critique',
  phase: 'plan',
  status: 'reviewed',
  verdict: 'PROCEED',
  feasibility: 'confirmed',
  frameMeta: 'SOUND',
  summary: 'The plan is decision-complete.',
  findings: [],
  edgeCases: [
    {
      risk: 'concurrent capture',
      scenario: 'two critics finish together',
      expectedBehavior: 'both immutable records survive',
      testType: 'integration',
    },
  ],
  actions: ['Proceed with the finalized plan.'],
  ...overrides,
});

describe('plan critique contract', () => {
  it('accepts exact JSON and makes a clean proceed review eligible', () => {
    const contract = parsePlanCritiqueResponse(JSON.stringify(response()));
    expect(contract.state).toBe('valid');
    expect(critiqueEligibility(contract)).toEqual({
      eligible: true,
      reason: 'eligible',
      criticalCount: 0,
    });
  });

  it('keeps blocking and wrong-phase results as valid but ineligible evidence', () => {
    const blocked = parsePlanCritiqueResponse(
      JSON.stringify(
        response({
          verdict: 'RETHINK',
          findings: [
            {
              severity: 'critical',
              lens: 'alignment',
              claim: 'The plan reverses a target.',
              evidence: 'Target x says the opposite.',
              impact: 'The decision gate will block.',
              recommendation: 'Revise the plan.',
            },
          ],
        }),
      ),
    );
    expect(critiqueEligibility(blocked)).toMatchObject({
      eligible: false,
      reason: 'verdict_rethink',
      criticalCount: 1,
    });

    const wrongPhase = parsePlanCritiqueResponse(
      JSON.stringify(response({ status: 'wrong_phase', verdict: null })),
    );
    expect(wrongPhase.state).toBe('valid');
    expect(critiqueEligibility(wrongPhase).reason).toBe('wrong_phase');
  });

  it('rejects fenced, malformed, and inconsistent responses', () => {
    expect(
      parsePlanCritiqueResponse(`\`\`\`json\n${JSON.stringify(response())}\n\`\`\``).state,
    ).toBe('invalid');
    expect(parsePlanCritiqueResponse('{"kind":').state).toBe('invalid');
    expect(
      parsePlanCritiqueResponse(JSON.stringify(response({ status: 'aborted', verdict: 'PROCEED' })))
        .state,
    ).toBe('invalid');
    expect(parsePlanCritiqueResponse(JSON.stringify(response({ flowId: 'legacy' }))).state).toBe(
      'invalid',
    );
  });
});
