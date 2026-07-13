/**
 * Pins the sc-1119 denominators to the corpus snapshot they were pre-registered against.
 * If the corpus grows (finalize --append), these numbers change DELIBERATELY: update them in the
 * same commit as the corpus change, alongside a PREREGISTRATION.md note — a silent drift between
 * the registered denominators and the data is exactly the ambiguity class the methodology audit
 * (docs/benchmarks/benchmark-methodology.md) calls fatal.
 *
 * Skips when no corpus is present (public checkout without the private working copy) — same
 * posture as cases.test.mts.
 */

import { describe, expect, it } from 'vitest';
import { computeCounts, readCases } from '../eval/counts.mts';

const cases = readCases();

describe.skipIf(!cases.length)('edge-cases sc-1119 denominators (counts.mts)', () => {
  const counts = computeCounts(cases);

  it('matches the pre-registered snapshot (2026-07-13, corpus v2)', () => {
    expect(counts).toEqual({
      totalRows: 139,
      noResponseRows: 37,
      judgedRows: 102,
      diffRows: 23,
      diffBearingRows: 19,
      diffGuardRows: 4,
      diffOrganicZeroRows: 0,
      summaryRows: 79,
      summaryBearingRows: 74,
      summaryGuardRows: 5,
      anchoredWS: 79,
      anchoredNoise: 1,
      anchoredReceipts: 7,
      unanchoredDiffFindings: 45,
      totalFindings: 575,
      perBearingRowAnchoredWS: [1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4, 5, 7, 7, 7, 8, 8, 9, 10],
    });
  });

  it('internal consistency: judged splits and finding accounting hold', () => {
    expect(counts.judgedRows).toBe(counts.diffRows + counts.summaryRows);
    expect(counts.diffRows).toBe(
      counts.diffBearingRows + counts.diffGuardRows + counts.diffOrganicZeroRows,
    );
    expect(counts.totalRows).toBe(counts.judgedRows + counts.noResponseRows);
    // every diff-bearing-row finding is anchored (WS or noise) or unanchored — nothing dropped
    expect(counts.anchoredWS + counts.anchoredNoise + counts.unanchoredDiffFindings).toBe(
      cases
        .filter((c) => c.anchor.kind === 'diff' && c.findings.length > 0 && !c.degenerate)
        .reduce((n, c) => n + c.findings.length, 0),
    );
  });
});
