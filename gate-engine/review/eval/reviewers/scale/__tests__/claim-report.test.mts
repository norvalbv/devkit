import { describe, expect, it } from 'vitest';
import { buildClaimInventory, sha256, type ClaimInventory } from '../claim-inventory.mts';
import { judgmentTemplate, type ClaimJudgment } from '../claim-judgments.mts';
import { claimReport } from '../claim-report.mts';

function inventory(statuses: string[] = ['fail']) {
  const diffText = 'archived input';
  const expectedTaskKeys = statuses.map((_, i) => `task-${i}`);
  return buildClaimInventory([
    {
      namespace: '/private/bank',
      source: '/private/source',
      diffText,
      resultJson: JSON.stringify({
        diff: sha256(diffText),
        labels: [],
        rows: statuses.map((status, i) => ({
          key: expectedTaskKeys[i],
          identity: 'conditions',
          model: 'gpt-5.6-sol',
          at: '2026-09-05T12:00:00Z',
          status,
          scope: { lenses: ['state'], files: [] },
          parentReplay: { id: 'parent', expectedTaskKeys },
          capture: {
            version: 1,
            provenance: 'exact-checklist',
            items: [
              { itemIndex: 0, lens: 'state', status, issues: status === 'fail' ? ['claim'] : [] },
            ],
          },
        })),
      }),
    },
  ]);
}

function judgment(
  data: ClaimInventory,
  index = 0,
  overrides: Partial<ClaimJudgment> = {},
): ClaimJudgment {
  return {
    ...judgmentTemplate(data.occurrences[index]),
    truth: 'REAL',
    changeScope: 'INTRODUCED',
    charterScope: 'IN_CHARTER',
    knownLabelRelation: 'DISTINCT',
    labelComparison: { basis: 'FULL_DEFECT_EVIDENCE', labelIds: [], evidence: [] },
    contextBasis: 'PROVEN_ORIGINAL_INPUT',
    evidence: [{ reference: 'evaluated input', observation: 'Inspected the causal code path.' }],
    adjudicator: { id: 'reviewer', tier: 'AI', model: 'claude-sonnet-4-6' },
    at: '2026-09-05T12:01:00Z',
    ...overrides,
  };
}

describe('context-qualified claim reporting', () => {
  it.each([
    {
      source: 'gpt-5.6-sol',
      model: 'anthropic/claude-opus-4-5-20251101',
      basis: 'CROSS_FAMILY',
      valid: 1,
    },
    { source: 'openai/gpt-5.6-sol', model: 'claude-sonnet-4-6', basis: 'CROSS_FAMILY', valid: 1 },
    {
      source: 'claude-sonnet-4-6',
      model: 'anthropic/claude-opus-4-5-20251101',
      basis: 'SAME_FAMILY',
      valid: 0,
    },
    { source: 'gpt-5.6-sol', model: 'openai/gpt-6-astra', basis: 'SAME_FAMILY', valid: 0 },
    {
      source: 'gpt-5.6-sol',
      model: 'unknown/claude-sonnet-4-6',
      basis: 'UNKNOWN_FAMILY',
      valid: 0,
    },
    { source: 'gpt-5.6-sol', model: 'anthropic/gpt-6-astra', basis: 'UNKNOWN_FAMILY', valid: 0 },
    { source: 'gpt-5.6-sol', model: 'openai/claude-sonnet-4-6', basis: 'UNKNOWN_FAMILY', valid: 0 },
    { source: 'openai/claude-sonnet-4-6', model: 'gpt-6-astra', basis: 'UNKNOWN_FAMILY', valid: 0 },
  ])(
    'classifies $source against $model using its explicit provider family',
    ({ source, model, basis, valid }) => {
      const data = inventory();
      data.tasks[0].model = source;
      const report = claimReport(
        data,
        JSON.stringify([
          judgment(data, 0, {
            adjudicator: { id: 'reviewer', tier: 'AI', model },
          }),
        ]),
      );
      expect(report.factualPrecision.valid).toBe(valid);
      expect(report.adjudication.primaryTerminalBasisCounts[basis]).toBe(1);
    },
  );

  it.each(['UNVERIFIED', 'PATCH_APPLICATION_ONLY'] as const)(
    'keeps REAL and NOT judgments unresolved with %s context',
    (contextBasis) => {
      const data = inventory();
      for (const truth of ['REAL', 'NOT'] as const) {
        const report = claimReport(
          data,
          JSON.stringify([judgment(data, 0, { truth, contextBasis })]),
        );
        for (const counts of [report.factualPrecision, report.introducedInCharterPrecision])
          expect(counts).toEqual({
            valid: 0,
            invalid: 0,
            unresolved: 1,
            captured: 1,
            resolvedPrecision: null,
            resolvedCoverage: 0,
            bounds: [0, 1],
          });
        expect(report.recordedDimensionCounts.truth[truth]).toBe(1);
        expect(report.recordedDimensionCounts.contextBasis[contextBasis]).toBe(1);
        expect(report.parents.results[0]).toMatchObject({
          status: 'fail',
          category: 'unresolved',
          removingExtrasClearsParent: null,
          invalidOnly: null,
        });
        expect(report.repeatedInvalidBurden.invalidOccurrences).toBe(0);
      }
    },
  );
  it.each(['PROVEN_ORIGINAL_INPUT', 'RECONSTRUCTED_FROM_VERIFIED_BASE'] as const)(
    'allows supported %s context to qualify precision and attribution',
    (contextBasis) => {
      const data = inventory();
      const report = claimReport(data, JSON.stringify([judgment(data, 0, { contextBasis })]));
      expect(report.factualPrecision.valid).toBe(1);
      expect(report.introducedInCharterPrecision.valid).toBe(1);
      expect(report.parents.results[0]).toMatchObject({
        category: 'extra-only',
        removingExtrasClearsParent: true,
        invalidOnly: false,
      });
    },
  );
  it('keeps recorded scope and context counts separate from eligibility and missing judgments', () => {
    const data = inventory(['fail', 'fail', 'fail']);
    const report = claimReport(
      data,
      JSON.stringify([
        judgment(data, 0, {
          changeScope: 'PRE_EXISTING',
          charterScope: 'OUT_OF_CHARTER',
          contextBasis: 'PATCH_APPLICATION_ONLY',
        }),
        judgment(data, 1, {
          truth: 'NOT',
          changeScope: 'NOT_APPLICABLE',
          charterScope: 'NOT_APPLICABLE',
          contextBasis: 'UNVERIFIED',
        }),
      ]),
    );
    expect(report.recordedDimensionCounts).toEqual({
      population: 'primary-terminal-captured-occurrences',
      truth: { REAL: 1, NOT: 1, UNSURE: 0, UNADJUDICATED: 1 },
      changeScope: {
        INTRODUCED: 0,
        PRE_EXISTING: 1,
        NOT_APPLICABLE: 1,
        UNSURE: 0,
        UNADJUDICATED: 1,
      },
      charterScope: {
        IN_CHARTER: 0,
        OUT_OF_CHARTER: 1,
        NOT_APPLICABLE: 1,
        UNSURE: 0,
        UNADJUDICATED: 1,
      },
      contextBasis: {
        PROVEN_ORIGINAL_INPUT: 0,
        RECONSTRUCTED_FROM_VERIFIED_BASE: 0,
        PATCH_APPLICATION_ONLY: 1,
        UNVERIFIED: 1,
        UNADJUDICATED: 1,
      },
    });
    expect(report.factualPrecision.unresolved).toBe(3);
    expect(report.introducedInCharterPrecision.resolvedCoverage).toBe(0);
    expect(report.adjudication.primaryTerminalTiers.AI).toBe(2);
  });
  it.each([
    ['private malformed status', 'pass'],
    ['pass', 'private malformed status'],
  ])('keeps unknown and PASS parent siblings unresolved in input order %j', (...statuses) => {
    const report = claimReport(inventory(statuses), '[]');
    expect(report.parents.results[0]).toMatchObject({
      status: 'unknown',
      category: 'unresolved',
      removingExtrasClearsParent: null,
      invalidOnly: null,
      completeRoster: true,
    });
    expect(JSON.stringify(report)).not.toContain('private malformed status');
  });
});

interface RetryAttempt {
  at?: string;
  status: string;
}

function parentSource(attempts: RetryAttempt[], namespace = '/private/bank', parentId = 'parent') {
  const diffText = 'archived input';
  return {
    namespace,
    source: '/private/source',
    diffText,
    resultJson: JSON.stringify({
      diff: sha256(diffText),
      labels: [],
      rows: attempts.map((attempt) => ({
        ...attempt,
        key: 'task',
        identity: 'conditions',
        parentReplay: { id: parentId, expectedTaskKeys: ['task'] },
        capture: {
          version: 1,
          provenance: 'exact-checklist',
          items: [{ itemIndex: 0, lens: 'state', status: attempt.status, issues: [] }],
        },
      })),
    }),
  };
}

describe('parent retry and namespace identity', () => {
  it.each([false, true])(
    'selects the latest valid timestamp with reversed input %s',
    (reversed) => {
      const attempts = [
        { status: 'error' },
        { at: 'unknown-date', status: 'error' },
        { at: '2026-09-05T13:00:00+02:00', status: 'error' },
        { at: '2026-09-05T12:00:00Z', status: 'pass' },
      ];
      const data = buildClaimInventory([parentSource(reversed ? attempts.reverse() : attempts)]);
      const result = claimReport(data, '[]').parents.results[0];
      expect(result).toMatchObject({
        status: 'pass',
        category: 'not-blocked',
        removingExtrasClearsParent: false,
        supersededTasks: 3,
        ambiguousRetryTasks: 0,
      });
    },
  );
  it.each([false, true])(
    'retains ambiguous timestamp ties and absent ordering with reversed input %s',
    (reversed) => {
      const cases = [
        [{ status: 'fail' }, { at: 'unknown-date', status: 'pass' }],
        [
          { at: '2026-09-05T12:00:00Z', status: 'fail' },
          { at: '2026-09-05T13:00:00+01:00', status: 'pass' },
        ],
      ];
      for (const attempts of cases) {
        const data = buildClaimInventory([parentSource(reversed ? attempts.reverse() : attempts)]);
        expect(claimReport(data, '[]').parents.results[0]).toMatchObject({
          status: 'unknown',
          category: 'unresolved',
          removingExtrasClearsParent: null,
          invalidOnly: null,
          supersededTasks: 0,
          ambiguousRetryTasks: 1,
        });
      }
    },
  );
  it('keeps parents with colliding delimiter strings separate', () => {
    const attempts = [{ at: '2026-09-05T12:00:00Z', status: 'pass' }];
    const data = buildClaimInventory([
      parentSource(attempts, 'a:b', 'c'),
      parentSource(attempts, 'a', 'b:c'),
    ]);
    const report = claimReport(data, '[]');
    expect(report.parents.total).toBe(2);
    expect(report.parents.categories['not-blocked']).toBe(2);
    expect(report.parents.results.every((parent) => parent.completeRoster)).toBe(true);
  });
});

describe('adjudicator independence', () => {
  const cases: Array<{
    source: string | null;
    model: string;
    tier: ClaimJudgment['adjudicator']['tier'];
    basis: string;
    eligible: boolean;
  }> = [
    {
      source: 'gpt-5.6-sol',
      model: 'gpt-6-astra',
      tier: 'AI',
      basis: 'SAME_FAMILY',
      eligible: false,
    },
    {
      source: 'claude-sonnet-4-6',
      model: 'claude-opus-4-6',
      tier: 'AI',
      basis: 'SAME_FAMILY',
      eligible: false,
    },
    {
      source: 'gpt-5.6-sol',
      model: 'claude-sonnet-4-6',
      tier: 'AI',
      basis: 'CROSS_FAMILY',
      eligible: true,
    },
    {
      source: 'sonnet@high',
      model: 'gpt-6-astra',
      tier: 'AI',
      basis: 'CROSS_FAMILY',
      eligible: true,
    },
    {
      source: 'unidentified',
      model: 'claude-sonnet-4-6',
      tier: 'AI',
      basis: 'UNKNOWN_FAMILY',
      eligible: false,
    },
    {
      source: 'gpt-5.6-sol',
      model: 'unidentified',
      tier: 'AI',
      basis: 'UNKNOWN_FAMILY',
      eligible: false,
    },
    {
      source: null,
      model: 'claude-sonnet-4-6',
      tier: 'AI',
      basis: 'UNKNOWN_FAMILY',
      eligible: false,
    },
    {
      source: 'gpt-5.6-sol',
      model: 'gpt-6-astra',
      tier: 'HUMAN_WITH_AI',
      basis: 'SAME_FAMILY',
      eligible: false,
    },
    { source: null, model: 'gpt-6-astra', tier: 'HUMAN', basis: 'HUMAN', eligible: true },
  ];
  it.each(cases)(
    '$source / $model / $tier reports $basis without losing raw judgments',
    ({ source, model, tier, basis, eligible }) => {
      const data = inventory();
      data.tasks[0].model = source;
      for (const truth of ['REAL', 'NOT'] as const) {
        const report = claimReport(
          data,
          JSON.stringify([
            judgment(data, 0, {
              truth,
              adjudicator: { id: 'fixture-adjudicator', tier, model },
            }),
          ]),
        );
        expect(report.adjudication.primaryTerminalBasisCounts[basis]).toBe(1);
        expect(report.recordedDimensionCounts.truth[truth]).toBe(1);
        expect(report.factualPrecision.unresolved).toBe(eligible ? 0 : 1);
        expect(report.introducedInCharterPrecision.unresolved).toBe(eligible ? 0 : 1);
        expect(report.parents.results[0].removingExtrasClearsParent).toBe(eligible ? true : null);
        if (!eligible) expect(report.repeatedInvalidBurden.invalidOccurrences).toBe(0);
      }
    },
  );
});
