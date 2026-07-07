import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AdvisoryDeps, runQavisAdvisory } from '../check.mts';

const ENV_KEYS = ['GUARD_AI_STRICT', 'GUARD_QAVIS_OK', 'GUARD_NO_QAVIS_ADVISORY'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const deps = (verdict: 'ADVISE' | 'SILENT' | null, hasRecipe = true): AdvisoryDeps => ({
  hasRecipe: () => hasRecipe,
  routeVerdict: () => verdict,
});

describe('runQavisAdvisory exit contract', () => {
  it('no recipe → 0, and never shells qavis (zero-weight for non-qavis repos)', () => {
    const routeVerdict = vi.fn(() => 'ADVISE' as const);
    expect(runQavisAdvisory('/r', { hasRecipe: () => false, routeVerdict })).toBe(0);
    expect(routeVerdict).not.toHaveBeenCalled();
  });

  it('SILENT → 0', () => {
    expect(runQavisAdvisory('/r', deps('SILENT'))).toBe(0);
  });

  it('qavis absent/errored (null verdict) → 0 (fail-open)', () => {
    expect(runQavisAdvisory('/r', deps(null))).toBe(0);
  });

  it('ADVISE on a normal commit → 0 (advisory only, never blocks)', () => {
    expect(runQavisAdvisory('/r', deps('ADVISE'))).toBe(0);
  });

  it('ADVISE under a strict ship → 3 (block until QA or override)', () => {
    process.env.GUARD_AI_STRICT = '1';
    expect(runQavisAdvisory('/r', deps('ADVISE'))).toBe(3);
  });

  it('GUARD_QAVIS_OK short-circuits ADVISE under strict → 0, never shells qavis', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_QAVIS_OK = '1';
    const routeVerdict = vi.fn(() => 'ADVISE' as const);
    expect(runQavisAdvisory('/r', { hasRecipe: () => true, routeVerdict })).toBe(0);
    expect(routeVerdict).not.toHaveBeenCalled();
  });

  it('GUARD_NO_QAVIS_ADVISORY disables entirely → 0', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_NO_QAVIS_ADVISORY = '1';
    expect(runQavisAdvisory('/r', deps('ADVISE'))).toBe(0);
  });
});
