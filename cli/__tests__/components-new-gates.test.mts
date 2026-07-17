/**
 * The gate registry after promoting `qavis-advisory` to recommended, plus `newBundledGates` — the
 * pure reconcile helper `upgrade` uses to detect gates a recorded selection predates (the fix for
 * `devkit upgrade` silently dropping a newly-bundled gate).
 */
import { describe, expect, it } from 'vitest';
import { GUARD_IDS, newBundledGates, RECOMMENDED_GUARD_IDS } from '../lib/components.mts';

describe('gate registry', () => {
  it('qavis-advisory is recommended and GUARD_IDS carries it exactly once', () => {
    expect(RECOMMENDED_GUARD_IDS).toContain('qavis-advisory');
    expect(GUARD_IDS.filter((g) => g === 'qavis-advisory')).toHaveLength(1);
    expect(new Set(GUARD_IDS).size).toBe(GUARD_IDS.length); // no duplicates
    expect(GUARD_IDS).toContain('review'); // opt-in
  });

  it('sentry is offerable but NOT recommended (needs a Sentry-using product)', () => {
    expect(GUARD_IDS).toContain('sentry');
    expect(RECOMMENDED_GUARD_IDS).not.toContain('sentry');
  });
});

describe('newBundledGates', () => {
  it('splits gates missing from a recorded selection into recommended vs opt-in', () => {
    const recorded = ['size', 'fanout', 'dup', 'clone', 'decisions']; // a pre-qavis selection
    const { recommended, optIn } = newBundledGates(recorded);
    expect(recommended).toEqual(['qavis-advisory']); // newly recommended, absent
    expect(optIn).toEqual(['review', 'sentry']); // bundled but never selected
  });

  it('returns empty buckets when the recorded set already has every bundled gate', () => {
    const { recommended, optIn } = newBundledGates([...GUARD_IDS]);
    expect(recommended).toEqual([]);
    expect(optIn).toEqual([]);
  });

  it('a fully-recommended selection leaves only the opt-in gates outstanding', () => {
    const { recommended, optIn } = newBundledGates([...RECOMMENDED_GUARD_IDS]);
    expect(recommended).toEqual([]);
    expect(optIn).toEqual(['review', 'sentry']);
  });
});
