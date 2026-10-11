import { describe, expect, it } from 'vitest';
import {
  GUARD_IDS,
  newBundledGates,
  normalizeReviewProfile,
  normalizeSelection,
  RECOMMENDED_GUARD_IDS,
} from '../lib/components.mts';
import { parseFlags } from '../lib/install/flags/init-flags.mts';

describe('gate registry', () => {
  it('ui-evidence is recommended and GUARD_IDS carries it exactly once', () => {
    expect(RECOMMENDED_GUARD_IDS).toContain('ui-evidence');
    expect(GUARD_IDS.filter((g) => g === 'ui-evidence')).toHaveLength(1);
    expect(new Set(GUARD_IDS).size).toBe(GUARD_IDS.length); // no duplicates
    expect(GUARD_IDS).toContain('review'); // opt-in
  });

  it('sentry is offerable but NOT recommended (needs a Sentry-using product)', () => {
    expect(GUARD_IDS).toContain('sentry');
    expect(RECOMMENDED_GUARD_IDS).not.toContain('sentry');
  });

  it('coverage is offerable but NOT recommended (needs a test:run:coverage provider)', () => {
    expect(GUARD_IDS).toContain('coverage');
    expect(RECOMMENDED_GUARD_IDS).not.toContain('coverage');
  });
});

describe('newBundledGates', () => {
  it('splits gates missing from a recorded selection into recommended vs opt-in', () => {
    const recorded = ['size', 'fanout', 'dup', 'clone', 'decisions']; // a pre-ui-evidence selection
    const { recommended, optIn } = newBundledGates(recorded);
    expect(recommended).toEqual(['comments', 'ui-evidence']);
    expect(optIn).toEqual(['review', 'sentry', 'coverage']); // bundled but never selected
  });

  it('returns empty buckets when the recorded set already has every bundled gate', () => {
    const { recommended, optIn } = newBundledGates([...GUARD_IDS]);
    expect(recommended).toEqual([]);
    expect(optIn).toEqual([]);
  });

  it('a fully-recommended selection leaves only the opt-in gates outstanding', () => {
    const { recommended, optIn } = newBundledGates([...RECOMMENDED_GUARD_IDS]);
    expect(recommended).toEqual([]);
    expect(optIn).toEqual(['review', 'sentry', 'coverage']);
  });

  it('does not re-offer a gate recorded as explicitly disabled', () => {
    const selected = RECOMMENDED_GUARD_IDS.filter((guard) => guard !== 'comments');
    const { recommended, optIn } = newBundledGates(selected, ['comments']);
    expect(recommended).toEqual([]);
    expect(optIn).toEqual(['review', 'sentry', 'coverage']);
  });
});

describe('renamed guard ids', () => {
  it('a recorded qavis-advisory reads as ui-evidence, once', () => {
    const guards = ['size', 'qavis-advisory', 'ui-evidence'];
    expect(normalizeSelection({ guards }).guards).toEqual(['size', 'ui-evidence']);
    expect(normalizeReviewProfile({ guards }, ['size', 'ui-evidence']).guards).toEqual([
      'size',
      'ui-evidence',
    ]);
  });

  it('init accepts the old id in --guards and --no-<guard>', () => {
    expect(parseFlags(['--guards', 'size,qavis-advisory']).guards).toEqual(['size', 'ui-evidence']);
    expect(parseFlags(['--no-qavis-advisory']).no.has('ui-evidence')).toBe(true);
  });
});
