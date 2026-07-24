/**
 * Pins the noise audit's pre-registered sampling design (stratified n=60, seed 1119) and the
 * agreement-table semantics its gate reads. The sample must be reproducible — a drifting sample
 * would make the reported κ/AC1 unauditable.
 */

import { describe, expect, it } from 'vitest';
import { readCases } from '../eval/counts.mts';
import { agreementTable, drawSample } from '../eval/noise-audit.mts';

const cases = readCases();

describe.skipIf(!cases.length)('noise-audit sampling (pre-registered)', () => {
  it('is deterministic under seed 1119 and matches the registered strata', () => {
    const a = drawSample(cases);
    const b = drawSample(cases);
    expect(a.sample.map((s) => s.ref)).toEqual(b.sample.map((s) => s.ref));
    const strata = {};
    for (const s of a.sample) strata[s.stratum] = (strata[s.stratum] ?? 0) + 1;
    expect(strata).toEqual({ receipts: 7, 'anchored-noise': 1, 'anchored-ws': 30, global: 22 });
    expect(a.sample).toHaveLength(60);
    // exhaustive strata really are exhaustive
    expect(a.poolSizes.receipts).toBe(7);
    expect(a.poolSizes.anchoredNoise).toBe(1);
  });

  it('a different seed draws a different sample (the seed is doing the work)', () => {
    const a = drawSample(cases, 1119);
    const c = drawSample(cases, 7);
    expect(a.sample.map((s) => s.ref)).not.toEqual(c.sample.map((s) => s.ref));
  });
});

describe('agreementTable', () => {
  it('reports raw/AC1/κ/PABAK together; single-class κ is NaN while AC1 stays defined', () => {
    const pairs = Array.from({ length: 20 }, () => ['worth-surfacing', 'worth-surfacing']);
    const t = agreementTable(pairs);
    expect(t.raw).toBe(1);
    expect(t.ac1).toBe(1);
    expect(Number.isNaN(t.kappa)).toBe(true); // the NaN-PASS clause exists for exactly this
  });
});
