import { describe, expect, it } from 'vitest';
import {
  CORPUS,
  KNOWN_REAL_EXCEPTIONS,
  lintSaveCases,
  loadCases,
  runPerturbation,
  runRealCorpus,
} from '../eval/save-quality/bench.mts';
import {
  type CaseResult,
  FPR_CEILING,
  gatePassed,
  RECALL_FLOOR,
  type SaveQualityCase,
  scoreCase,
  summarize,
} from '../eval/save-quality/scoring.mts';
import { INTEGRITY_CHECK_IDS, type IntegrityFinding } from '../integrity/checks.mts';

const cleanCase = (id: string, baseSlug = 'x'): SaveQualityCase => ({
  id,
  provenance: 'adapted',
  baseSlug,
  mutation: 'none',
  expected: [],
  note: 'test',
});

const defectCase = (id: string, baseSlug: string, check: 'h1-slug-mismatch'): SaveQualityCase => ({
  id,
  provenance: 'adapted',
  baseSlug,
  mutation: check,
  expected: [check],
  note: 'test',
});

describe('scoreCase', () => {
  it('is a recall hit and not a false positive when exactly the expected finding fires', () => {
    const c = defectCase('d1', 'x', 'h1-slug-mismatch');
    const findings: IntegrityFinding[] = [{ slug: 'x', check: 'h1-slug-mismatch', detail: 'd' }];
    const r = scoreCase(c, findings);
    expect(r.recallHit).toBe(true);
    expect(r.falsePositive).toBe(false);
  });

  it('is a recall MISS when the expected finding does not fire', () => {
    const c = defectCase('d1', 'x', 'h1-slug-mismatch');
    const r = scoreCase(c, []);
    expect(r.recallHit).toBe(false);
    expect(r.falsePositive).toBe(false); // absence is a miss, not itself a false positive
  });

  it('is a false positive when an UNEXPECTED check fires on the same slug', () => {
    const c = cleanCase('clean1');
    const findings: IntegrityFinding[] = [{ slug: 'x', check: 'index-stale', detail: 'd' }];
    const r = scoreCase(c, findings);
    expect(r.recallHit).toBe(true); // vacuously — nothing was expected
    expect(r.falsePositive).toBe(true);
    expect(r.unexpected).toHaveLength(1);
  });

  it('is a false positive when a finding lands on a DIFFERENT slug (collateral damage)', () => {
    const c = defectCase('d1', 'x', 'h1-slug-mismatch');
    const findings: IntegrityFinding[] = [
      { slug: 'x', check: 'h1-slug-mismatch', detail: 'd' },
      { slug: 'y', check: 'index-stale', detail: 'collateral' },
    ];
    const r = scoreCase(c, findings);
    expect(r.recallHit).toBe(true);
    expect(r.falsePositive).toBe(true);
    expect(r.collateral).toHaveLength(1);
    expect(r.collateral[0].slug).toBe('y');
  });
});

describe('summarize / gatePassed', () => {
  it('gates PASS when recall clears the floor and FPR clears the ceiling', () => {
    const results: CaseResult[] = [
      {
        id: 'd1',
        expected: ['h1-slug-mismatch'],
        ownFindings: [{ slug: 'x', check: 'h1-slug-mismatch', detail: 'd' }],
        collateral: [],
        recallHit: true,
        falsePositive: false,
        unexpected: [],
      },
      {
        id: 'c1',
        expected: [],
        ownFindings: [],
        collateral: [],
        recallHit: true,
        falsePositive: false,
        unexpected: [],
      },
    ];
    const summary = summarize(results);
    expect(summary.recall).toEqual({ hit: 1, total: 1 });
    expect(summary.recallFloorMet).toBe(true);
    expect(summary.headlineFpr).toBe(0);
    expect(gatePassed(summary)).toBe(true);
  });

  it('never reports a headline FPR when the recall floor is not met — no passing on a technicality', () => {
    const results: CaseResult[] = [
      {
        id: 'd1',
        expected: ['h1-slug-mismatch'],
        ownFindings: [], // missed
        collateral: [],
        recallHit: false,
        falsePositive: false,
        unexpected: [],
      },
    ];
    const summary = summarize(results);
    expect(summary.recallFloorMet).toBe(false);
    expect(summary.headlineFpr).toBeNull();
    expect(gatePassed(summary)).toBe(false);
  });

  it('fails the gate when FPR exceeds the ceiling even with perfect recall', () => {
    const results: CaseResult[] = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      expected: ['h1-slug-mismatch' as const],
      ownFindings: [{ slug: 'x', check: 'h1-slug-mismatch' as const, detail: 'd' }],
      collateral: i < 2 ? [{ slug: 'y', check: 'index-stale' as const, detail: 'collateral' }] : [],
      recallHit: true,
      falsePositive: i < 2,
      unexpected: i < 2 ? [{ slug: 'y', check: 'index-stale' as const, detail: 'collateral' }] : [],
    }));
    const summary = summarize(results);
    expect(summary.recallFloorMet).toBe(true);
    expect(summary.headlineFpr).toBeCloseTo(0.2); // 2/10, above the 10% ceiling
    expect(gatePassed(summary)).toBe(false);
  });

  it('breaks recall out per check rather than pooling it away', () => {
    const results: CaseResult[] = [
      {
        id: 'd1',
        expected: ['h1-slug-mismatch'],
        ownFindings: [{ slug: 'x', check: 'h1-slug-mismatch', detail: 'd' }],
        collateral: [],
        recallHit: true,
        falsePositive: false,
        unexpected: [],
      },
      {
        id: 'd2',
        expected: ['index-stale'],
        ownFindings: [], // this one check is broken
        collateral: [],
        recallHit: false,
        falsePositive: false,
        unexpected: [],
      },
    ];
    const summary = summarize(results);
    expect(summary.perCheck['h1-slug-mismatch']).toEqual({ hit: 1, total: 1 });
    expect(summary.perCheck['index-stale']).toEqual({ hit: 0, total: 1 });
    // pooled recall (1/2 = 50%) would hide that ONE check is entirely broken — the per-check
    // breakdown is what makes that visible.
    expect(summary.recall).toEqual({ hit: 1, total: 2 });
    expect(summary.checksRegressed).toEqual(['index-stale']);
  });

  // The pooled floor is the wrong shape for deterministic rules: with the shipped corpus's per-check
  // case counts, killing two whole checks leaves recall at 10/12 = 83%, over the 80% floor. Recall
  // alone therefore CANNOT be what the gate rests on.
  it('fails the gate when a single check goes dead, even while pooled recall clears the floor', () => {
    const results: CaseResult[] = Array.from({ length: 12 }, (_, i) => {
      const dead = i === 0; // one of twelve — 11/12 = 91.7%, comfortably over the floor
      const check = (dead ? 'target-heading-depth' : 'h1-slug-mismatch') as const;
      return {
        id: `d${i}`,
        expected: [check],
        ownFindings: dead ? [] : [{ slug: 'x', check, detail: 'd' }],
        collateral: [],
        recallHit: !dead,
        falsePositive: false,
        unexpected: [],
      };
    });
    const summary = summarize(results);
    expect(summary.recallFloorMet).toBe(true); // the floor is met…
    expect(summary.headlineFpr).toBe(0); // …and nothing false-fired…
    expect(summary.checksRegressed).toEqual(['target-heading-depth']); // …but a check is dead.
    expect(gatePassed(summary)).toBe(false);
  });

  it('names every declared check that has no defect case, so an unexercised check cannot hide', () => {
    // Only h1-slug-mismatch is exercised here; the other six declared checks are uncovered.
    const summary = summarize([
      {
        id: 'd1',
        expected: ['h1-slug-mismatch'],
        ownFindings: [{ slug: 'x', check: 'h1-slug-mismatch', detail: 'd' }],
        collateral: [],
        recallHit: true,
        falsePositive: false,
        unexpected: [],
      },
    ]);
    expect(summary.checksUncovered).toContain('index-stale');
    expect(summary.checksUncovered).not.toContain('h1-slug-mismatch');
    // Corpus completeness is the bench's exit-code concern, not a performance verdict — gatePassed
    // stays true so a focused summary over one check is still readable as a pass.
    expect(gatePassed(summary)).toBe(true);
  });

  it('exports the floor/ceiling as named constants, not magic numbers scattered at call sites', () => {
    expect(RECALL_FLOOR).toBe(0.8);
    expect(FPR_CEILING).toBe(0.1);
  });
});

describe('lintSaveCases', () => {
  const base = {
    id: 'x',
    provenance: 'adapted' as const,
    baseSlug: 'webhook-retry-policy',
    mutation: 'none' as const,
    expected: [],
    note: 'n',
  };

  it('accepts a well-formed clean case', () => {
    expect(lintSaveCases([base])).toEqual([]);
  });

  it('accepts a well-formed mutated case', () => {
    const row = {
      ...base,
      id: 'y',
      mutation: 'h1-slug-mismatch' as const,
      expected: ['h1-slug-mismatch' as const],
    };
    expect(lintSaveCases([row])).toEqual([]);
  });

  it('rejects a duplicate id', () => {
    expect(lintSaveCases([base, base])).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicate id')]),
    );
  });

  it('rejects a provenance other than "adapted"', () => {
    const row = { ...base, provenance: 'real' as unknown as 'adapted' };
    expect(lintSaveCases([row])).toEqual(
      expect.arrayContaining([expect.stringContaining('provenance')]),
    );
  });

  it('rejects a baseSlug that is not a real corpus/adapted fixture', () => {
    const row = { ...base, baseSlug: 'no-such-fixture' };
    expect(lintSaveCases([row])).toEqual(
      expect.arrayContaining([expect.stringContaining('no-such-fixture')]),
    );
  });

  it('rejects a mutation that is neither "none" nor a known check id', () => {
    const row = { ...base, mutation: 'not-a-real-check' as unknown as 'none' };
    expect(lintSaveCases([row])).toEqual(
      expect.arrayContaining([expect.stringContaining('not-a-real-check')]),
    );
  });

  it('rejects "none" paired with a non-empty expected[]', () => {
    const row = { ...base, expected: ['h1-slug-mismatch' as const] };
    expect(lintSaveCases([row])).toEqual(
      expect.arrayContaining([expect.stringContaining('empty expected')]),
    );
  });

  it('rejects a mutated case whose expected[] is not exactly [mutation]', () => {
    const row = {
      ...base,
      mutation: 'h1-slug-mismatch' as const,
      expected: ['index-stale' as const],
    };
    expect(lintSaveCases([row])).toEqual(
      expect.arrayContaining([expect.stringContaining('exactly [mutation]')]),
    );
  });
});

describe('bench integration (the shipped cases-save.jsonl + corpus/adapted/**)', () => {
  it('the committed corpus is a real directory with fixture files', () => {
    expect(CORPUS).toContain('corpus/adapted');
  });

  it('the committed case file is well-formed and every base fixture exists', () => {
    const cases = loadCases(); // throws (BenchAbort) on any lint failure — the assertion IS "does not throw"
    expect(cases.length).toBeGreaterThan(0);
    expect(lintSaveCases(cases)).toEqual([]);
  });

  it("scores 100% recall and 0% FPR on the shipped corpus — the number this suite's headline reports", () => {
    const summary = runPerturbation(loadCases());
    expect(summary.recallFloorMet).toBe(true);
    expect(summary.fpr.bad).toBe(0);
    expect(gatePassed(summary)).toBe(true);
  });

  it('every shipped check has at least one perturbation case exercising it', () => {
    const summary = runPerturbation(loadCases());
    // Asserted against the DECLARED check list, not against summary.perCheck's own keys: summarize()
    // only creates a key for a check some case already names, so iterating perCheck could only ever
    // re-confirm the checks that are covered — a check with zero cases would drop out of the loop
    // entirely and the assertion would pass vacuously, which is exactly the regression this guards.
    expect(summary.checksUncovered).toEqual([]);
    for (const id of INTEGRITY_CHECK_IDS)
      expect(summary.perCheck[id]?.total ?? 0).toBeGreaterThan(0);
  });

  it('the real corpus (docs/decisions/**) has no findings beyond the one known, named exception', () => {
    const real = runRealCorpus();
    expect(real).not.toBeNull();
    expect(real?.unexpected).toEqual([]);
    expect(real?.known).toEqual(KNOWN_REAL_EXCEPTIONS);
  });
});
