/**
 * Fixture tests for the bench's pre-registered scoring semantics (no LLM, no corpus): the
 * noise-match-is-FP rule, zero-finding rows, item-3 recall credit, guard gates (incl. the
 * N<15 descriptive-only clause), the ship-target clause, bit-reproducible nested bootstrap,
 * and the parse coercions. These pin PREREGISTRATION.md rules to executable checks.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateConfig,
  annotateBearingRow,
  evaluateGates,
  GUARD_FIRE_MAX,
  GUARD_MIN_N,
  nestedBootstrap,
  parseFindings,
  scoreRunOnBearingRow,
} from '../eval/bench.mts';

const gold = (idx, over = {}) => ({
  idx,
  claim: `edge case number ${idx} about flushing`,
  files: [`src/f${idx}.ts`],
  category: 'race',
  severity: 'medium',
  verdict: 'worth-surfacing',
  wasLiveBug: 'unknown',
  evidence: { tier: 'none', detail: 'n/a', confidence: 'low', reviewed: false },
  ...over,
});

const row = annotateBearingRow({
  id: 'cc-frink-20260101-00000000',
  repo: 'frink',
  anchor: {
    kind: 'diff',
    nameStatus: 'M\tsrc/f1.ts\nM\tsrc/f2.ts\nM\tsrc/f3.ts',
    summary: 'test row',
  },
  degenerate: false,
  findings: [
    gold(1),
    gold(2, {
      wasLiveBug: 'true',
      evidence: { tier: 'f2p-in-session', detail: 'x', confidence: 'high', reviewed: true },
    }),
    gold(3, { verdict: 'noise' }),
    gold(4, { files: ['src/unanchored.ts'] }), // anchored? no — outside nameStatus
  ],
});

const judge = (over = {}) => ({
  claim: 'edge case number 1 about flushing',
  files: ['src/f1.ts'],
  category: 'race',
  severity: 'medium',
  ...over,
});

describe('annotateBearingRow', () => {
  it('splits anchored WS / anchored noise / receipts; unanchored excluded', () => {
    expect([...row.anchoredWSIdx].sort()).toEqual([1, 2]);
    expect([...row.anchoredNoiseIdx]).toEqual([3]);
    expect([...row.receiptsIdx]).toEqual([2]);
  });
});

describe('scoreRunOnBearingRow', () => {
  it('recall counts anchored∩WS only; matched unanchored gold is precision credit, not recall', () => {
    const s = scoreRunOnBearingRow(
      [judge(), judge({ files: ['src/unanchored.ts'], claim: 'edge case number 4' })],
      row,
    );
    expect(s.recall).toBe(0.5); // matched gold 1 of anchored-WS {1,2}
    expect(s.tp).toBe(2); // both matches are to worth-surfacing gold (row-wide precision)
    expect(s.fp).toBe(0);
  });

  it('a match to a noise-verdict gold is an FP, never recall credit', () => {
    const s = scoreRunOnBearingRow([judge({ files: ['src/f3.ts'], claim: 'number 3' })], row);
    expect(s.recall).toBe(0);
    expect(s.tp).toBe(0);
    expect(s.fp).toBe(1);
    expect(s.noiseMatchedIdx.has(3)).toBe(true); // bootstrap needs it for noise→WS flips
  });

  it('zero findings → recall 0, no FPs', () => {
    const s = scoreRunOnBearingRow([], row);
    expect(s.recall).toBe(0);
    expect(s.fp).toBe(0);
    expect(s.judgeTotal).toBe(0);
  });

  it('item-3 covered credit reaches recall and is counted separately', () => {
    const broad = judge({ files: ['src/f1.ts', 'src/f2.ts'] });
    const s = scoreRunOnBearingRow([broad], row);
    expect(s.recall).toBe(1); // greedy match + item-3 credit cover both anchored WS golds
    expect(s.item3Count).toBe(1);
    expect(s.receiptsRecalled.has(2)).toBe(true);
  });

  it('unmatched judge findings are FPs', () => {
    const s = scoreRunOnBearingRow([judge({ files: ['src/nowhere.ts'], claim: 'unrelated' })], row);
    expect(s.fp).toBe(1);
    expect(s.tp).toBe(0);
  });
});

describe('evaluateGates (pre-registered decision rule)', () => {
  const base = {
    macroRecall: 0.6,
    ciLower: 0.5,
    guardN: 26,
    guardFireRate: 0.1,
    receiptsHit: 5,
  };

  it('clears the target when all gates pass', () => {
    const g = evaluateGates(base, 0.5, false);
    expect(g).toMatchObject({ guardDisqualified: false, softFlag: false, clearsTarget: true });
  });

  it('guard fire-rate above the max disqualifies', () => {
    const g = evaluateGates({ ...base, guardFireRate: GUARD_FIRE_MAX + 0.05 }, 0.5, false);
    expect(g.guardDisqualified).toBe(true);
    expect(g.clearsTarget).toBe(false);
  });

  it('guard gate is descriptive-only below the pre-registered minimum N', () => {
    const g = evaluateGates({ ...base, guardN: GUARD_MIN_N - 1, guardFireRate: 0.9 }, 0.5, false);
    expect(g.guardGateActive).toBe(false);
    expect(g.guardDisqualified).toBe(false);
  });

  it('receipts below minimum raises the soft flag and blocks shipping', () => {
    const g = evaluateGates({ ...base, receiptsHit: 3 }, 0.5, false);
    expect(g.softFlag).toBe(true);
    expect(g.clearsTarget).toBe(false);
  });

  it('CI lower bound below T − 0.15 blocks; matcher-limited blocks numerically', () => {
    expect(evaluateGates({ ...base, ciLower: 0.3 }, 0.5, false).clearsTarget).toBe(false);
    expect(evaluateGates(base, 0.5, true).clearsTarget).toBe(false);
    expect(evaluateGates(base, null, false).clearsTarget).toBe(false);
  });
});

describe('nested bootstrap', () => {
  const mkScore = (recallsByCase) => {
    const perRow = new Map();
    for (const [id, recalled] of Object.entries(recallsByCase)) {
      const runs = [0, 1, 2].map(() => ({
        recalledIdx: new Set(recalled),
        noiseMatchedIdx: new Set(),
        recall: recalled.length / 2,
      }));
      runs.anchoredWSSize = 2;
      runs.anchoredWSList = [1, 2];
      runs.anchoredNoiseList = [3];
      perRow.set(id, runs);
    }
    return { perRow };
  };

  it('is bit-reproducible under the pre-registered seed', () => {
    const s = mkScore({ a: [1], b: [1, 2], c: [] });
    const r1 = nestedBootstrap(s, null, { alpha: 3, beta: 20 }, { B: 200 });
    const r2 = nestedBootstrap(s, null, { alpha: 3, beta: 20 }, { B: 200 });
    expect(r1).toEqual(r2);
  });

  it('without ε the replicate mean tracks the observed macro recall', () => {
    const s = mkScore({ a: [1], b: [1, 2], c: [] });
    const reps = nestedBootstrap(s, null, null, { B: 2000 });
    const m = reps.reduce((x, y) => x + y, 0) / reps.length;
    expect(m).toBeGreaterThan(0.4);
    expect(m).toBeLessThan(0.6); // observed macro = (0.5 + 1 + 0)/3 = 0.5
  });

  it('label noise widens the spread, and paired flips are shared between configs', () => {
    const s = mkScore({ a: [1], b: [1, 2], c: [] });
    const plain = nestedBootstrap(s, null, null, { B: 500 });
    const noisy = nestedBootstrap(s, null, { alpha: 5, beta: 15 }, { B: 500 });
    const spread = (xs) => Math.max(...xs) - Math.min(...xs);
    expect(spread(noisy)).toBeGreaterThanOrEqual(spread(plain));
    // identical configs → paired Δ is exactly 0 in EVERY replicate (shared flips)
    const dd = nestedBootstrap(
      s,
      mkScore({ a: [1], b: [1, 2], c: [] }),
      { alpha: 5, beta: 15 },
      { B: 200 },
    );
    expect(dd.every((d) => d === 0)).toBe(true);
  });
});

describe('parseFindings coercions (pre-registered)', () => {
  it('coerces unknown enums and strips non-string files', () => {
    const raw = JSON.stringify({
      findings: [{ claim: 'x', files: ['a.ts', 42], category: 'made-up', severity: 'urgent' }],
    });
    expect(parseFindings(raw)).toEqual([
      { claim: 'x', files: ['a.ts'], category: 'other', severity: 'unstated' },
    ]);
  });

  it('tolerates fences and surrounding prose; rejects JSON without findings', () => {
    expect(parseFindings('```json\n{"findings":[]}\n```')).toEqual([]);
    expect(parseFindings('Here you go: {"findings":[]} hope that helps')).toEqual([]);
    expect(() => parseFindings('{"answer":42}')).toThrow();
    expect(() => parseFindings('I refuse to analyze this.')).toThrow();
  });
});

describe('aggregateConfig', () => {
  it('macro vs micro weighting differ on skewed rows (both reported)', () => {
    const runsOf = (recalled, size) => {
      const runs = [
        {
          recalledIdx: new Set(recalled),
          noiseMatchedIdx: new Set(),
          recall: recalled.length / size,
          tp: recalled.length,
          fp: 0,
          judgeTotal: recalled.length,
          item3Count: 0,
          receiptsRecalled: new Set(),
        },
      ];
      runs.anchoredWSSize = size;
      runs.anchoredWSList = Array.from({ length: size }, (_, i) => i + 1);
      runs.anchoredNoiseList = [];
      runs.receiptsIdxAll = [];
      return runs;
    };
    const perRow = new Map([
      ['tiny', runsOf([1], 1)], // 1/1
      ['big', runsOf([1, 2], 10)], // 2/10
    ]);
    const agg = aggregateConfig(perRow, new Map(), 0, 2);
    expect(agg.macroRecall).toBeCloseTo((1 + 0.2) / 2, 10);
    expect(agg.microRecall).toBeCloseTo(3 / 11, 10);
  });
});
