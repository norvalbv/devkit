import { describe, expect, it } from 'vitest';
import {
  buildClaimInventory,
  sha256,
  type ClaimInventory,
  type JsonValue,
} from '../claim-inventory.mts';
import { judgmentTemplate } from '../claim-judgments.mts';
import { claimReport as reportJson } from '../claim-report.mts';
function claimReport<Value>(inventory: ClaimInventory, judgments: Value) {
  return reportJson(inventory, JSON.stringify(judgments));
}

function inventory(captures?: JsonValue[]) {
  const diffText = 'exact archived diff';
  return buildClaimInventory([
    {
      source: '/private/source',
      namespace: '/private/bank',
      diffText,
      resultJson: JSON.stringify({
        diff: sha256(diffText),
        labels: [],
        rows: (
          captures ?? [
            {
              version: 1,
              provenance: 'exact-checklist',
              items: [{ itemIndex: 0, lens: 'state', status: 'fail', issues: ['claim'] }],
            },
          ]
        ).map((capture, i) => ({
          key: `task-${i}`,
          identity: 'conditions',
          model: 'gpt-5.6-sol',
          at: '2026-09-05T12:00:00Z',
          status: captures ? 'pass' : 'fail',
          capture,
          scope: { lenses: ['state'], files: [] },
          issues: [],
        })),
      }),
    },
  ]);
}
function judgments(data: ReturnType<typeof inventory>) {
  return data.occurrences.map((claim) => ({
    ...judgmentTemplate(claim),
    truth: 'NOT',
    evidence: [{ reference: 'diff', observation: 'The claimed path cannot execute.' }],
    at: '2026-09-05T12:01:00Z',
    adjudicator: { id: 'private-person-id', tier: 'AI', model: 'claude-sonnet-4-6' },
  }));
}

describe('closed adjudication fields and explicit skips', () => {
  it('rejects array-coerced truth/scope/relation/context fields instead of crediting them as REAL', () => {
    const data = inventory();
    const [judgment] = judgments(data);
    for (const [field, value] of Object.entries({
      truth: ['NOT'],
      changeScope: ['INTRODUCED'],
      charterScope: ['IN_CHARTER'],
      knownLabelRelation: ['NOT_COMPARED'],
      contextBasis: ['UNVERIFIED'],
    }))
      expect(() => claimReport(data, [{ ...judgment, [field]: value }])).toThrow(
        `Invalid judgment ${field}`,
      );
    expect(() => claimReport(data, [{ ...judgment, truth: ['UNSURE'] }])).toThrow(
      'Invalid judgment truth',
    );
    expect(() =>
      claimReport(data, [{ ...judgment, adjudicator: { ...judgment.adjudicator, tier: ['AI'] } }]),
    ).toThrow('Invalid adjudicator');
  });
  it('keeps named empty, unnamed empty, and missing artifacts distinguishable', () => {
    const data = inventory([
      {
        version: 1,
        provenance: 'exact-checklist',
        artifact: 'files',
        skipped: 'no in-scope files',
        items: [],
      },
      { version: 1, provenance: 'exact-checklist', artifact: 'files', items: [] },
      { version: 1, provenance: 'missing-invalid', items: [] },
    ]);
    expect(data.tasks[0]).toMatchObject({
      captureArtifact: 'files',
      skipReason: 'no in-scope files',
      coverage: 'skipped',
    });
    expect(data.tasks[1]).toMatchObject({ captureArtifact: 'files', coverage: 'incomplete' });
    expect(data.tasks[1].skipReason).toBeUndefined();
    expect(data.tasks[2]).toMatchObject({
      captureProvenance: 'missing-invalid',
      missingClaims: true,
    });
    const report = claimReport(data, []);
    expect(report.counts.coverageSkippedTasks).toBe(1);
    expect(JSON.stringify(report)).not.toContain('no in-scope files');
  });
  it('rejects malformed capture enums and skip metadata instead of treating them as exact', () => {
    for (const override of [
      { artifact: ['files'] },
      { provenance: ['exact-checklist'] },
      { skipped: ['reason'] },
    ]) {
      const data = inventory([
        { version: 1, provenance: 'exact-checklist', items: [], ...override },
      ]);
      expect(data.tasks[0].captureExact).toBe(false);
      expect(data.tasks[0].errors).toContain('invalid-capture');
    }
    const data = inventory([
      {
        version: 1,
        provenance: 'exact-checklist',
        items: [
          {
            itemIndex: 0,
            lens: 'state',
            status: 'fail',
            disposition: ['waived'],
            issues: ['claim'],
          },
        ],
      },
    ]);
    expect(data.tasks[0].errors).toContain('invalid-capture');
  });
  it('publishes adjudication tiers and a validated-set hash without human identifiers', () => {
    const data = inventory();
    const judged = judgments(data);
    const report = claimReport(data, judged);
    expect(report.adjudication.tiers).toEqual({ AI: 1, HUMAN: 0, HUMAN_WITH_AI: 0 });
    expect(report.adjudication.primaryTerminalTiers.AI).toBe(1);
    expect(report.adjudication.judgmentSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.adjudication.judgmentSetHash).not.toBe(
      claimReport(data, []).adjudication.judgmentSetHash,
    );
    expect(JSON.stringify(report)).not.toContain('private-person-id');
  });
});
