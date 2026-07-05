import { describe, expect, it } from 'vitest';
import { classifyPair, DEFAULT_KNOBS, isCandidate } from '../classify.mts';

const base = { hashEqual: false, code: 0.5, desc: 0.5, minLoc: 50, bothTest: false };

describe('classifyPair', () => {
  it('flags identical code across files as exact', () => {
    expect(classifyPair({ ...base, hashEqual: true, code: 1, desc: 1 })).toBe('exact');
  });

  it('bothTest suppresses exact (test boilerplate is out of scope)', () => {
    // bothTest is checked first by design, before hashEqual.
    expect(classifyPair({ ...base, hashEqual: true, bothTest: true })).toBeNull();
  });

  it('flags high code similarity as near regardless of desc', () => {
    expect(classifyPair({ ...base, code: 0.96, desc: 0.2 })).toBe('near');
  });

  it('flags drifted only when code AND desc AND size all clear', () => {
    expect(classifyPair({ ...base, code: 0.86, desc: 0.9, minLoc: 30 })).toBe('drifted');
  });

  it('rejects drifted when desc is below the floor (structural-noise veto)', () => {
    // High code, low desc = the "all TS looks alike" floor. Must be rejected.
    expect(classifyPair({ ...base, code: 0.9, desc: 0.5, minLoc: 30 })).toBeNull();
  });

  it('rejects drifted when code is below the floor', () => {
    expect(classifyPair({ ...base, code: 0.7, desc: 0.95, minLoc: 30 })).toBeNull();
  });

  it('rejects drifted when chunk is too small', () => {
    expect(
      classifyPair({ ...base, code: 0.9, desc: 0.95, minLoc: 1 }, { ...DEFAULT_KNOBS, minLoc: 5 }),
    ).toBeNull();
  });

  it('excludes test<>test pairs entirely', () => {
    expect(classifyPair({ ...base, code: 0.99, desc: 0.99, bothTest: true })).toBeNull();
  });

  it('returns null for unrelated code', () => {
    expect(classifyPair({ ...base, code: 0.4, desc: 0.4 })).toBeNull();
  });

  it('honours custom knobs', () => {
    const strict = { nearCode: 0.99, driftCode: 0.95, driftDesc: 0.95, minLoc: 50 };
    expect(classifyPair({ ...base, code: 0.96, desc: 0.96, minLoc: 60 }, strict)).toBe('drifted');
    expect(classifyPair({ ...base, code: 0.96, desc: 0.5, minLoc: 60 }, strict)).toBeNull();
  });
});

describe('isCandidate', () => {
  it('is true for any non-null tier', () => {
    expect(isCandidate({ ...base, hashEqual: true })).toBe(true);
  });
  it('is false for ignored pairs', () => {
    expect(isCandidate({ ...base, code: 0.3, desc: 0.3 })).toBe(false);
  });
});
