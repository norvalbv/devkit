import { describe, expect, it } from 'vitest';
import { buildClaimInventory, sha256, type ClaimInventory } from '../claim-inventory.mts';
import { judgmentTemplate } from '../claim-judgments.mts';
import { claimReport } from '../claim-report.mts';

function sources(archivedDiff: string, copies: (string | null)[]) {
  const resultJson = JSON.stringify({
    diff: sha256(archivedDiff),
    labels: [],
    rows: [
      {
        key: 'task',
        identity: 'conditions',
        at: '2026-09-05T12:00:00Z',
        status: 'fail',
        capture: {
          version: 1,
          provenance: 'exact-checklist',
          items: [{ itemIndex: 0, lens: 'state', status: 'fail', issues: ['claim'] }],
        },
      },
    ],
  });
  return copies.map((diffText, i) => ({
    source: `/private/copy-${i}`,
    namespace: '/private/bank',
    resultJson,
    diffText,
  }));
}

function report(inventory: ClaimInventory) {
  return claimReport(
    inventory,
    JSON.stringify([
      {
        ...judgmentTemplate(inventory.occurrences[0]),
        truth: 'REAL',
        contextBasis: 'PROVEN_ORIGINAL_INPUT',
        evidence: [{ reference: 'evaluated input', observation: 'Inspected the causal path.' }],
        adjudicator: { id: 'human-reviewer', tier: 'HUMAN' },
        at: '2026-09-05T12:01:00Z',
      },
    ]),
  );
}

describe('archived evidence resolution across copied tasks', () => {
  it.each(['exact archived diff', ''])(
    'resolves missing evidence from another copy before task construction for %j',
    (diff) => {
      const missingFirst = buildClaimInventory(sources(diff, [null, diff]));
      const availableFirst = buildClaimInventory(sources(diff, [diff, null]));
      expect(missingFirst).toEqual(availableFirst);
      expect(missingFirst.tasks).toHaveLength(1);
      expect(missingFirst.occurrences).toHaveLength(1);
      expect(missingFirst.copiedTasks).toBe(1);
      expect(missingFirst.inputs[0].diffText).toBe(diff);
      expect(missingFirst.errors).toEqual([]);
      expect(report(missingFirst).factualPrecision.valid).toBe(1);
    },
  );
  it.each(['', 'nonempty expected diff'])(
    'rejects conflicting empty/nonempty bytes in either order for expected %j',
    (diff) => {
      const other = diff === '' ? 'wrong bytes' : '';
      for (const copies of [
        [diff, other],
        [other, diff],
      ])
        expect(() => buildClaimInventory(sources(diff, copies))).toThrow('Conflicting diff bytes');
    },
  );
  it('retains unresolved missing evidence and mismatched-byte errors when no valid copy exists', () => {
    const missing = buildClaimInventory(sources('expected', [null, null]));
    expect(missing.tasks[0].errors).toContain('missing-diff');
    expect(missing.errors.map((error) => error.code)).toContain('missing-diff');
    expect(report(missing).factualPrecision.unresolved).toBe(1);
    const mismatched = buildClaimInventory(sources('expected', [null, 'wrong bytes']));
    expect(mismatched.tasks[0].errors).toContain('diff-hash-mismatch');
    expect(mismatched.errors.map((error) => error.code)).toContain('diff-hash-mismatch');
    expect(report(mismatched).factualPrecision.unresolved).toBe(1);
  });
});
