import { describe, expect, it } from 'vitest';
import {
  blindClaimPackets,
  buildClaimInventory as buildJsonInventory,
  sha256,
  type ClaimInventory,
  type JsonValue,
  type CensusError,
} from '../claim-inventory.mts';
import {
  validateClaimJudgments as validateJudgmentJson,
  type ClaimJudgment,
} from '../claim-judgments.mts';
import { claimReport as reportJson } from '../claim-report.mts';

interface TestSource<Value> {
  source: string;
  namespace: string;
  result: Value;
  diffText: string | null;
}
function buildClaimInventory<Value>(sources: TestSource<Value>[], errors: CensusError[] = []) {
  return buildJsonInventory(
    sources.map(({ result, ...source }) => ({ ...source, resultJson: JSON.stringify(result) })),
    errors,
  );
}
function claimReport<Value>(inventory: ClaimInventory, judgments: Value) {
  return reportJson(inventory, JSON.stringify(judgments));
}
function validateClaimJudgments<Value>(judgments: Value, inventory: ClaimInventory) {
  return validateJudgmentJson(JSON.stringify(judgments), inventory);
}

const DIFF =
  'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
const SHA = sha256(DIFF);
const EVIDENCE = [
  { reference: 'evaluated src/x.ts:1', observation: 'Concrete trigger and code path inspected.' },
];
function row(overrides: Record<string, JsonValue | undefined> = {}) {
  return {
    key: 'task-1',
    identity: 'run-conditions',
    at: '2026-09-05T12:00:00.000Z',
    diff: SHA,
    base: 'base-commit',
    status: 'fail',
    model: 'gpt-5.6-sol',
    arm: 'secret-arm',
    issues: [{ lens: 'state', text: 'wire stub' }],
    scope: { lenses: ['state'], files: ['src/x.ts'] },
    capture: {
      version: 1,
      provenance: 'exact-checklist',
      artifact: 'items',
      items: [
        {
          itemIndex: 0,
          lens: 'state',
          status: 'fail',
          issues: ['src/x.ts:10 Wrong state transition'],
        },
      ],
    },
    ...overrides,
  };
}
function census<Row, Label>(rows: Row[], labels: Label[] = [], diffText: string | null = DIFF) {
  return buildClaimInventory([
    {
      source: '/private/results.json',
      namespace: '/private/bank',
      result: { diff: SHA, rows, labels },
      diffText,
    },
  ]);
}
function judgment(
  inventory: ClaimInventory,
  index = 0,
  overrides: Partial<ClaimJudgment> = {},
): ClaimJudgment {
  const claim = inventory.occurrences[index];
  return {
    schemaVersion: 1,
    occurrenceId: claim.occurrenceId,
    textSha256: claim.textSha256,
    truth: 'REAL',
    changeScope: 'INTRODUCED',
    charterScope: 'IN_CHARTER',
    knownLabelRelation: 'NOT_COMPARED',
    knownLabelIds: [],
    duplicateGroup: null,
    contextBasis: 'PROVEN_ORIGINAL_INPUT',
    evidence: EVIDENCE,
    limitations: [],
    adjudicator: { id: 'reviewer', tier: 'AI', model: 'claude-sonnet-4-6' },
    at: '2026-09-05T13:00:00.000Z',
    ...overrides,
  };
}
function extra(inventory: ClaimInventory, index = 0, overrides: Partial<ClaimJudgment> = {}) {
  const ids = inventory.inputs[0].labels.map((label) => label.id);
  return judgment(inventory, index, {
    knownLabelRelation: 'DISTINCT',
    knownLabelIds: ids,
    labelComparison: { basis: 'FULL_DEFECT_EVIDENCE', labelIds: ids, evidence: EVIDENCE },
    ...overrides,
  });
}
function capture(texts: string[], extraItems: JsonValue[] = []) {
  return {
    version: 1,
    provenance: 'exact-checklist',
    artifact: 'items',
    items: [{ itemIndex: 7, lens: 'state', status: 'fail', issues: texts }, ...extraItems],
  };
}

describe('all-occurrence claim census', () => {
  it('keeps same-location distinct claims, nearby wrong claims, no locations, and every location', () => {
    const inventory = census(
      [
        row({
          capture: capture([
            'src/x.ts:10 first',
            'src/x.ts:10 different',
            'No location and no loss',
            'src/x.ts:10 calls src/y.ts:20',
          ]),
        }),
      ],
      [{ file: 'src/x.ts', line: 10 }],
    );
    expect(inventory.occurrences).toHaveLength(4);
    expect(new Set(inventory.occurrences.map((c) => c.occurrenceId)).size).toBe(4);
    expect(inventory.occurrences[2].locations).toEqual([]);
    expect(inventory.occurrences[3].locations).toHaveLength(2);
    expect(inventory.occurrences[0].itemIndex).toBe(7);
    expect(claimReport(inventory, []).semanticRelationCounts.SAME_DEFECT).toBe(0);
  });
  it('retains repeated issues and attempts, but collapses exact file copies once', () => {
    const first = row({ capture: capture(['same', 'same']) });
    const later = row({ capture: capture(['same', 'same']), at: '2026-09-05T12:01:00.000Z' });
    const inventory = census([first, first, later]);
    expect(inventory.occurrences).toHaveLength(4);
    expect(inventory.copiedTasks).toBe(1);
    expect(new Set(inventory.occurrences.map((c) => c.occurrenceId)).size).toBe(4);
  });
  it('fails closed on conflicting copies with the same task attempt identity', () => {
    expect(() => census([row(), row({ capture: capture(['changed text']) })])).toThrow(
      'Conflicting task identity',
    );
  });
  it('makes label order irrelevant and rejects conflicting label sets for one diff', () => {
    const source = {
      source: 'one',
      namespace: '/private/bank',
      diffText: DIFF,
      result: { diff: SHA, rows: [row()], labels: [{ text: 'a' }, { text: 'b' }] },
    };
    const reordered = {
      ...source,
      source: 'two',
      result: { ...source.result, labels: [...source.result.labels].reverse() },
    };
    expect(buildClaimInventory([source, reordered]).copiedTasks).toBe(1);
    expect(() =>
      buildClaimInventory([
        source,
        { ...reordered, result: { ...reordered.result, labels: [{ text: 'changed' }] } },
      ]),
    ).toThrow('Conflicting label sets');
  });
  it('distinguishes FAIL with pending siblings from incomplete text capture', () => {
    const inventory = census([
      row({
        scope: { lenses: ['state', 'reader'], files: ['src/x.ts'] },
        capture: capture(
          ['real bug'],
          [{ itemIndex: 8, lens: 'reader', status: 'pending', issues: [] }],
        ),
      }),
    ]);
    expect(inventory.tasks[0]).toMatchObject({
      captureExact: true,
      coverage: 'incomplete',
      missingClaims: false,
    });
    expect(claimReport(inventory, [judgment(inventory)]).introducedInCharterPrecision.valid).toBe(
      1,
    );
  });
  it('accepts a completed masked singleton without requiring other catalog lenses', () => {
    expect(census([row()]).tasks[0].coverage).toBe('complete');
  });
  it.each(['pass', 'fail'])(
    'retains inconsistent pass-item text but withholds precision and parent-clear credit on %s',
    (status) => {
      // checkItem/checkFile clear issues on pass; an unchanged stale trail is invalid evidence.
      const fullText = `src/x.ts:10 ${'complete recorded claim '.repeat(30)}EXACT-TAIL`;
      const items = [{ itemIndex: 2, lens: 'state', status: 'pass', issues: [fullText] }];
      if (status === 'fail')
        items.push({ itemIndex: 5, lens: 'reader', status: 'fail', issues: ['extra blocker'] });
      const inventory = census([
        row({
          status,
          scope: { lenses: items.map((item) => item.lens), files: ['src/x.ts'] },
          capture: { version: 1, provenance: 'exact-checklist', items },
          parentReplay: { id: 'parent', expectedTaskKeys: ['task-1'] },
        }),
      ]);
      expect(inventory.tasks[0]).toMatchObject({ captureExact: true, items });
      expect(inventory.tasks[0].errors).toEqual(['invalid-capture']);
      expect(inventory.occurrences[0]).toMatchObject({
        itemIndex: 2,
        issueIndex: 0,
        itemStatus: 'pass',
        text: fullText,
        textSha256: sha256(fullText),
      });
      const report = claimReport(
        inventory,
        inventory.occurrences.map((_, index) => extra(inventory, index)),
      );
      for (const precision of [report.factualPrecision, report.introducedInCharterPrecision])
        expect(precision).toMatchObject({
          valid: 0,
          invalid: 0,
          unresolved: items.length,
          bounds: [0, 1],
        });
      expect(report.parents.removingExtrasClears).toBe(0);
      if (status === 'fail') {
        expect(report.parents.categories.unresolved).toBe(1);
        expect(report.parents.results[0].removingExtrasClearsParent).toBeNull();
      }
    },
  );
  it('preserves waived and dropped claims on terminal PASS for factual review', () => {
    const inventory = census([
      row({
        status: 'pass',
        capture: {
          version: 1,
          provenance: 'exact-checklist',
          items: [
            {
              itemIndex: 0,
              lens: 'state',
              status: 'fail',
              disposition: 'waived',
              issues: ['waived claim'],
            },
            {
              itemIndex: 1,
              lens: 'other',
              status: 'fail',
              disposition: 'dropped_out_of_charter',
              issues: ['dropped claim'],
            },
          ],
        },
      }),
    ]);
    expect(inventory.occurrences.map((c) => c.disposition)).toEqual([
      'waived',
      'dropped_out_of_charter',
    ]);
    expect(inventory.tasks[0].errors).toEqual([]);
    expect(inventory.tasks[0].captureExact).toBe(true);
    const report = claimReport(inventory, [judgment(inventory, 0), judgment(inventory, 1)]);
    expect(report.counts.primaryTerminalOccurrences).toBe(2);
    expect(report.factualPrecision.valid).toBe(2);
  });
  it('reports legacy, missing artifacts, and unattributed FAIL as unknown task denominators', () => {
    const inventory = census([
      row({ capture: undefined }),
      row({
        key: 'missing',
        capture: { version: 1, provenance: 'missing-invalid', items: [] },
        issues: [],
      }),
      row({ key: 'unattributed', capture: capture([]) }),
    ]);
    expect(inventory.tasks.map((t) => t.missingClaims)).toEqual([true, true, true]);
    expect(inventory.tasks[0].captureProvenance).toBe('legacy-unknown');
    expect(claimReport(inventory, []).counts.terminalMissingUnknownClaimTasks).toBe(3);
  });
  it('includes inexact captured text as unresolved, separate from missing claim counts', () => {
    const inventory = census([
      row({ capture: { ...capture(['capped text']), provenance: 'capped-fallback' } }),
    ]);
    const report = claimReport(inventory, [judgment(inventory)]);
    expect(report.factualPrecision).toMatchObject({ valid: 0, unresolved: 1, bounds: [0, 1] });
    expect(report.counts.missingUnknownClaimTasks).toBe(1);
  });
  it('reports absent/mismatched diff evidence without treating claims as resolved', () => {
    for (const diff of [null, 'not the captured diff']) {
      const inventory = census([row()], [], diff);
      expect(inventory.errors.length).toBeGreaterThan(0);
      expect(claimReport(inventory, [judgment(inventory)]).factualPrecision.unresolved).toBe(1);
    }
  });
  it('preserves legacy claim text when lens metadata is malformed', () => {
    const inventory = census([
      row({ capture: undefined, issues: [{ text: 'retained legacy claim', lens: 42 }] }),
    ]);
    expect(inventory.occurrences[0]).toMatchObject({ text: 'retained legacy claim', lens: '' });
    expect(inventory.tasks[0]).toMatchObject({
      captureProvenance: 'legacy-unknown',
      captureExact: false,
    });
    expect(claimReport(inventory, [judgment(inventory)]).factualPrecision.unresolved).toBe(1);
  });
  it('keeps malformed inputs inspectable as completeness failures', () => {
    const inventory = buildClaimInventory(
      [{ source: 'broken', namespace: '/private', result: {}, diffText: null }],
      [{ source: 'unreadable', code: 'unreadable-results-file' }],
    );
    expect(claimReport(inventory, []).completenessErrors).toEqual({
      'invalid-results-file': 1,
      'unreadable-results-file': 1,
    });
  });
  it('blinds provenance, dispositions, repetitions, judgments, and candidate labels', () => {
    const inventory = census(
      [row()],
      [{ file: 'secret-label.ts', line: 10, text: 'secret known label' }],
    );
    const packets = JSON.stringify(blindClaimPackets(inventory));
    expect(packets).toContain('Wrong state transition');
    for (const secret of [
      'gpt-5.6-sol',
      'secret-arm',
      'secret-label',
      'private/bank',
      'disposition',
      'knownLabel',
      'duplicateGroup',
    ])
      expect(packets).not.toContain(secret);
  });
  it('identifies archival input and marks legacy text exactness honestly in blind packets', () => {
    const packets = JSON.stringify(blindClaimPackets(census([row({ capture: undefined })])));
    expect(packets).toContain('archivedInput');
    expect(packets).not.toContain('evaluatedInput');
    expect(packets).toContain('legacy-unknown');
    expect(packets).toContain('"exact":false');
  });
});

describe('exact adjudication contracts', () => {
  it('rejects historical stubs, changed text, and duplicate judgment attachments', () => {
    const inventory = census([row()]);
    expect(() =>
      validateClaimJudgments([{ key: 'old-prefix', verdict: 'REAL' }], inventory),
    ).toThrow('Incompatible');
    expect(() =>
      validateClaimJudgments([judgment(inventory, 0, { textSha256: 'bad' })], inventory),
    ).toThrow('exact occurrence');
    const valid = judgment(inventory);
    expect(() => validateClaimJudgments([valid, valid], inventory)).toThrow('Multiple judgments');
    inventory.occurrences[0].text += ' modified';
    expect(() => validateClaimJudgments([valid], inventory)).toThrow('exact occurrence');
  });
  it('requires an actual model for AI adjudication and concrete evidence for resolved truth', () => {
    const inventory = census([row()]);
    expect(() =>
      validateClaimJudgments(
        [judgment(inventory, 0, { adjudicator: { id: 'bot', tier: 'AI' } })],
        inventory,
      ),
    ).toThrow('actual model');
    expect(() =>
      validateClaimJudgments([judgment(inventory, 0, { evidence: [] })], inventory),
    ).toThrow('requires evidence');
  });
  it('rejects DISTINCT from capped labels or an incomplete comparison set', () => {
    const inventory = census([row()], [{ text: 'label one' }, { text: 'label two' }]);
    const valid = extra(inventory);
    expect(validateClaimJudgments([valid], inventory)).toHaveLength(1);
    expect(() =>
      validateClaimJudgments(
        [{ ...valid, labelComparison: { ...valid.labelComparison!, basis: 'CAPPED_CONTEXT' } }],
        inventory,
      ),
    ).toThrow('DISTINCT');
    expect(() =>
      validateClaimJudgments(
        [{ ...valid, knownLabelIds: [inventory.inputs[0].labels[0].id] }],
        inventory,
      ),
    ).toThrow('DISTINCT');
  });
  it('permits DISTINCT against an explicitly empty available label set, not global completeness', () => {
    const inventory = census([row()]);
    expect(validateClaimJudgments([extra(inventory)], inventory)).toHaveLength(1);
  });
});

describe('conditional precision and parent burden', () => {
  it('reports valid/invalid/unknown bounds and keeps nonterminal attempts outside primary precision', () => {
    const inventory = census([
      row({ capture: capture(['valid', 'invalid', 'unknown']) }),
      row({ key: 'error-task', status: 'error', capture: capture(['error claim']) }),
    ]);
    const report = claimReport(inventory, [
      judgment(inventory),
      judgment(inventory, 1, { truth: 'NOT' }),
    ]);
    expect(report.factualPrecision).toMatchObject({
      valid: 1,
      invalid: 1,
      unresolved: 1,
      resolvedPrecision: 0.5,
      resolvedCoverage: 2 / 3,
      bounds: [1 / 3, 2 / 3],
    });
    expect(report.counts).toMatchObject({
      primaryTerminalOccurrences: 3,
      nonterminalOccurrences: 1,
    });
    expect(report.interpretation).toContain('not production precision');
  });
  it('separates factual truth from introduced-in-charter validity and repeated invalid occurrences', () => {
    const inventory = census([row({ capture: capture(['a', 'a', 'b']) })]);
    const judgments = [
      judgment(inventory, 0, { changeScope: 'PRE_EXISTING', duplicateGroup: 'same-cause' }),
      judgment(inventory, 1, { changeScope: 'PRE_EXISTING', duplicateGroup: 'same-cause' }),
      judgment(inventory, 2, { charterScope: 'OUT_OF_CHARTER' }),
    ];
    const report = claimReport(inventory, judgments);
    expect(report.factualPrecision.valid).toBe(3);
    expect(report.introducedInCharterPrecision.invalid).toBe(3);
    expect(report.repeatedInvalidBurden).toEqual({
      invalidOccurrences: 3,
      adjudicatedSemanticGroups: 1,
      ungroupedInvalidOccurrences: 1,
      repeatedInvalidOccurrences: 1,
    });
    expect(JSON.stringify(report)).not.toContain('same-cause');
    expect(JSON.stringify(report)).not.toContain('src/x.ts');
  });
  it('retains contradictory terminal PASS evidence without assigning parent or precision credit', () => {
    const inventory = census([
      row({ status: 'pass', parentReplay: { id: 'parent', expectedTaskKeys: ['task-1'] } }),
    ]);
    expect(inventory.occurrences).toHaveLength(1);
    expect(inventory.tasks[0].captureExact).toBe(true);
    expect(inventory.tasks[0].errors).toContain('invalid-capture');
    const report = claimReport(inventory, [extra(inventory)]);
    expect(report.factualPrecision).toMatchObject({ valid: 0, unresolved: 1 });
    expect(report.parents.results[0]).toMatchObject({
      status: 'pass',
      category: 'unresolved',
      removingExtrasClearsParent: null,
    });
  });
  it.each(['SAME_DEFECT', 'PARTIAL_OVERLAP'] as const)(
    'requires relation-specific evidence for %s and preserves capped relations without parent credit',
    (knownLabelRelation) => {
      const inventory = census(
        [row({ parentReplay: { id: 'parent', expectedTaskKeys: ['task-1'] } })],
        [{ text: 'capped known cause' }],
      );
      const ids = inventory.inputs[0].labels.map((label) => label.id);
      const related = judgment(inventory, 0, { knownLabelRelation, knownLabelIds: ids });
      expect(() => validateClaimJudgments([related], inventory)).toThrow(/relation-specific/);
      for (const labelComparison of [
        { basis: 'FULL_DEFECT_EVIDENCE', labelIds: ids, evidence: [] },
        { basis: 'FULL_DEFECT_EVIDENCE', labelIds: [], evidence: EVIDENCE },
      ])
        expect(() => validateClaimJudgments([{ ...related, labelComparison }], inventory)).toThrow(
          /relation-specific/,
        );
      const capped = {
        ...related,
        labelComparison: { basis: 'CAPPED_CONTEXT', labelIds: ids, evidence: EVIDENCE },
      };
      const report = claimReport(inventory, [capped]);
      expect(report.factualPrecision.valid).toBe(1);
      expect(report.semanticRelationCounts[knownLabelRelation]).toBe(1);
      expect(report.parents.categories.unresolved).toBe(1);
      expect(report.parents.results[0].removingExtrasClearsParent).toBeNull();
    },
  );
  it('does not unblock a parent containing both known and extra blockers', () => {
    const inventory = census(
      [
        row({
          capture: capture(['known', 'extra']),
          parentReplay: { id: 'parent', expectedTaskKeys: ['task-1'] },
        }),
      ],
      [{ text: 'known actual cause' }],
    );
    const judgments = [
      judgment(inventory, 0, {
        knownLabelRelation: 'SAME_DEFECT',
        labelComparison: {
          basis: 'FULL_DEFECT_EVIDENCE',
          labelIds: [inventory.inputs[0].labels[0].id],
          evidence: EVIDENCE,
        },
        knownLabelIds: [inventory.inputs[0].labels[0].id],
      }),
      extra(inventory, 1),
    ];
    const report = claimReport(inventory, judgments);
    expect(report.parents.categories.both).toBe(1);
    expect(report.parents.removingExtrasClears).toBe(0);
  });
  it('can attribute an extra-only parent and independently count invalid-only blocking', () => {
    const inventory = census([
      row({ parentReplay: { id: 'parent', expectedTaskKeys: ['task-1'] } }),
    ]);
    const report = claimReport(inventory, [extra(inventory, 0, { truth: 'NOT' })]);
    expect(report.parents.categories['extra-only']).toBe(1);
    expect(report.parents.removingExtrasClears).toBe(1);
    expect(report.parents.invalidOnlyBlocks).toBe(1);
  });
  it('missing/error/inconclusive/unattributed siblings prevent a counterfactual clear', () => {
    for (const siblingStatus of [undefined, 'error', 'inconclusive', 'fail']) {
      const parentReplay = { id: 'parent', expectedTaskKeys: ['task-1', 'task-2'] };
      const rows = [row({ parentReplay })];
      if (siblingStatus)
        rows.push(
          row({ key: 'task-2', parentReplay, status: siblingStatus, capture: capture([]) }),
        );
      const inventory = census(rows);
      const report = claimReport(inventory, [extra(inventory)]);
      expect(report.parents.categories.unresolved).toBe(1);
      expect(report.parents.removingExtrasClears).toBe(0);
      expect(report.parents.results[0].status).toBe('fail');
    }
  });
  it('does not publish unknown status prose and treats an empty second blocker as unresolved', () => {
    const parentReplay = { id: 'parent', expectedTaskKeys: ['task-1'] };
    const malformed = census([row({ parentReplay, status: 'private source claim details' })]);
    expect(claimReport(malformed, []).parents.results[0].status).toBe('unknown');
    expect(JSON.stringify(claimReport(malformed, []))).not.toContain(
      'private source claim details',
    );
    const missing = census([
      row({
        parentReplay,
        capture: capture(['extra'], [{ itemIndex: 8, lens: 'reader', status: 'fail', issues: [] }]),
      }),
    ]);
    expect(claimReport(missing, [extra(missing)]).parents.categories.unresolved).toBe(1);
  });
  it('requires complete active scope while allowing pending items outside its lens mask', () => {
    const parentReplay = { id: 'parent', expectedTaskKeys: ['task-1', 'task-2'] };
    const inventory = census([
      row({ parentReplay }),
      row({
        key: 'task-2',
        status: 'pass',
        parentReplay: { id: 'parent', expectedTaskKeys: ['task-2'] },
      }),
    ]);
    expect(claimReport(inventory, [extra(inventory)]).parents.categories.unresolved).toBe(1);
    const pending = census([
      row({
        parentReplay: { id: 'p', expectedTaskKeys: ['task-1'] },
        capture: capture(
          ['extra'],
          [{ itemIndex: 8, lens: 'reader', status: 'pending', issues: [] }],
        ),
      }),
    ]);
    const report = claimReport(pending, [extra(pending)]);
    expect(report.factualPrecision.valid).toBe(1);
    expect(report.parents.categories['extra-only']).toBe(1);
    const scoped = census([
      row({
        scope: { lenses: ['state', 'reader'], files: ['src/x.ts'] },
        parentReplay: { id: 'parent', expectedTaskKeys: ['task-1'] },
        capture: capture(
          ['one exact claim'],
          [{ itemIndex: 8, lens: 'reader', status: 'pending', issues: [] }],
        ),
      }),
    ]);
    const scopedReport = claimReport(scoped, [extra(scoped)]);
    expect(scopedReport.factualPrecision.valid).toBe(1);
    expect(scopedReport.parents.categories.unresolved).toBe(1);
    expect(scopedReport.parents.results[0].removingExtrasClearsParent).toBeNull();
  });
});
