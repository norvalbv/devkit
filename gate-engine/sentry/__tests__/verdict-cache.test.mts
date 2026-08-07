// The sentry judge's verdict cache: an identical commit attempt must replay its earned verdict
// (including a hard-block MONITOR) instead of re-billing the 3-sample judge, and anything
// unearned (null / ambiguous) must never be remembered.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { judgeSentryWithCache, sentryVerdictKey } from '../verdict-cache.mts';

const IDENTITY = { model: 'haiku', samples: 3, prompt: 'PROMPT' };

describe('sentryVerdictKey', () => {
  it('differs on every identity part (input, model, samples, prompt)', () => {
    const base = sentryVerdictKey('INPUT', IDENTITY);
    expect(sentryVerdictKey('OTHER', IDENTITY)).not.toBe(base);
    expect(sentryVerdictKey('INPUT', { ...IDENTITY, model: 'sonnet' })).not.toBe(base);
    // A 1-sample warn verdict must never replay as a 3-sample hard block:
    expect(sentryVerdictKey('INPUT', { ...IDENTITY, samples: 1 })).not.toBe(base);
    expect(sentryVerdictKey('INPUT', { ...IDENTITY, prompt: 'EDITED' })).not.toBe(base);
  });

  it('is boundary-safe (NUL separators — shifting bytes across parts cannot collide)', () => {
    expect(sentryVerdictKey('INPUT', { ...IDENTITY, model: 'a', prompt: 'bc' })).not.toBe(
      sentryVerdictKey('INPUT', { ...IDENTITY, model: 'ab', prompt: 'c' }),
    );
  });

  it('is stable across calls', () => {
    expect(sentryVerdictKey('INPUT', IDENTITY)).toBe(sentryVerdictKey('INPUT', IDENTITY));
  });
});

describe('judgeSentryWithCache', () => {
  // Non-repo temp cwd → devkitDataFile's degraded per-cwd fallback keeps the store local + disposable.
  const dirs: string[] = [];
  const tempCwd = () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-cache-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    ['MONITOR', 'adoption refusal path uncaptured'],
    ['SKIP', ''],
  ])('replays an earned %s without re-invoking the judge', (verdict, evidence) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = tempCwd();
    const first = vi.fn(() => ({ verdict, evidence }));
    expect(judgeSentryWithCache(cwd, 'INPUT', IDENTITY, first)).toEqual({ verdict, evidence });
    expect(first).toHaveBeenCalledTimes(1);
    const second = vi.fn(() => ({ verdict: 'SKIP', evidence: 'should not run' }));
    expect(judgeSentryWithCache(cwd, 'INPUT', IDENTITY, second)).toEqual({ verdict, evidence });
    expect(second).not.toHaveBeenCalled();
  });

  it('different inputs miss — the fix restage (changed error-hunks) re-judges', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = tempCwd();
    judgeSentryWithCache(cwd, 'INPUT-A', IDENTITY, () => ({ verdict: 'MONITOR', evidence: 'e' }));
    const fresh = vi.fn(() => ({ verdict: 'SKIP', evidence: 'capture added' }));
    expect(judgeSentryWithCache(cwd, 'INPUT-B', IDENTITY, fresh)?.verdict).toBe('SKIP');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['outage (null result)', () => null],
    ['ambiguous vote (null verdict)', () => ({ verdict: null, evidence: '' })],
  ])('never caches %s — the next attempt re-judges', (_label, judgeFn) => {
    const cwd = tempCwd();
    judgeSentryWithCache(cwd, 'INPUT', IDENTITY, judgeFn);
    const retry = vi.fn(() => null);
    judgeSentryWithCache(cwd, 'INPUT', IDENTITY, retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a cache hit names itself on stderr (the gate output stays explainable)', () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = tempCwd();
    judgeSentryWithCache(cwd, 'INPUT', IDENTITY, () => ({ verdict: 'MONITOR', evidence: 'e' }));
    judgeSentryWithCache(cwd, 'INPUT', IDENTITY, () => null);
    expect(errs.mock.calls.flat().join('\n')).toContain('cached MONITOR');
  });
});
