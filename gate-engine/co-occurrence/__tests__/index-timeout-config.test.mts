import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfigJson } from '../../config.mts';

// Node's child_process rejects a fractional `timeout` with ERR_OUT_OF_RANGE, and refreshIndex
// swallows every failure, so a fractional value here would silently skip the index refresh.
describe('indexCommandTimeoutMs resolution', () => {
  beforeEach(() => {
    vi.stubEnv('GUARD_INDEX_COMMAND_TIMEOUT_MS', undefined);
    vi.stubEnv('FRINK_INDEX_COMMAND_TIMEOUT_MS', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  const resolve = (fileValue?: number | string) =>
    resolveGuardConfigJson(
      fileValue === undefined ? null : JSON.stringify({ indexCommandTimeoutMs: fileValue }),
    ).indexCommandTimeoutMs;

  it('rounds a fractional env value up to a whole millisecond', () => {
    vi.stubEnv('GUARD_INDEX_COMMAND_TIMEOUT_MS', '1500.5');
    expect(resolve()).toBe(1501);
  });

  it('never rounds a sub-millisecond value down to 0, which Node reads as no timeout', () => {
    vi.stubEnv('GUARD_INDEX_COMMAND_TIMEOUT_MS', '0.4');
    expect(resolve()).toBe(1);
  });

  it('rounds a fractional file value up to a whole millisecond', () => {
    expect(resolve(1500.5)).toBe(1501);
  });

  it.each(['Infinity', '0', '-5', 'abc'])(
    'skips an unusable env value %s for the file value',
    (env) => {
      vi.stubEnv('GUARD_INDEX_COMMAND_TIMEOUT_MS', env);
      expect(resolve(1500.5)).toBe(1501);
    },
  );

  it('falls back to the default when neither source is usable', () => {
    vi.stubEnv('GUARD_INDEX_COMMAND_TIMEOUT_MS', '');
    expect(resolve('1500')).toBe(60_000);
  });
});
