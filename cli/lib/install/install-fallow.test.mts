/**
 * install-fallow tests. The single spawn seam (spawnSync) is mocked so NO test ever shells
 * out to bun/npm/cargo/fallow — each case scripts the per-command exit status it wants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the spawn seam before importing the module under test.
const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...a) => spawnSync(...a) }));

const { FALLOW_PINNED_VERSION, detectFallow, installFallow } = await import('./install-fallow.mts');

// Helper: a spawnSync result object. status null mimics a missing binary (spawn error).
function result(status, stdout = '') {
  return status === null
    ? { error: new Error('ENOENT'), status: null, stdout }
    : { status, stdout };
}

beforeEach(() => {
  spawnSync.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('FALLOW_PINNED_VERSION', () => {
  it('pins the approved fallow release exactly, never a floating tag', () => {
    expect(FALLOW_PINNED_VERSION).toBe('3.10.0');
  });
});

describe('detectFallow', () => {
  it('parses the version from a `fallow --version` probe', () => {
    spawnSync.mockReturnValueOnce(result(0, 'fallow 2.89.0\n'));
    expect(detectFallow({ cwd: '/x' })).toEqual({ available: true, version: '2.89.0' });
  });

  it('falls back to npx when the PATH binary is missing', () => {
    spawnSync
      .mockReturnValueOnce(result(null)) // fallow --version: ENOENT
      .mockReturnValueOnce(result(0, 'fallow 2.89.0\n')); // npx --no-install fallow --version
    const got = detectFallow({ cwd: '/x' });
    expect(got).toEqual({ available: true, version: '2.89.0' });
    expect(spawnSync.mock.calls[1][0]).toBe('npx');
  });

  it('reports unavailable when nothing answers', () => {
    spawnSync.mockReturnValue(result(null));
    expect(detectFallow({ cwd: '/x' })).toEqual({ available: false, version: null });
  });
});

describe('installFallow', () => {
  it('stops at the first PM that succeeds (bun)', () => {
    spawnSync.mockReturnValueOnce(result(0));
    const r = installFallow({ cwd: '/x' });
    expect(r).toMatchObject({ ok: true, method: 'bun' });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('falls through bun→npm→cargo and uses cargo when only it works', () => {
    spawnSync
      .mockReturnValueOnce(result(1)) // bun fails
      .mockReturnValueOnce(result(1)) // npm fails
      .mockReturnValueOnce(result(0)); // cargo ok
    const r = installFallow({ cwd: '/x' });
    expect(r).toMatchObject({ ok: true, method: 'cargo' });
    expect(spawnSync.mock.calls[2][0]).toBe('cargo');
    // cargo crate is fallow-cli (binary is fallow), pinned by --version.
    expect(spawnSync.mock.calls[2][1]).toContain('fallow-cli');
    expect(spawnSync.mock.calls[2][1]).toContain(FALLOW_PINNED_VERSION);
  });

  it('returns ok:false and prints manual steps when every PM misses', () => {
    spawnSync.mockReturnValue(result(null)); // every binary missing
    const r = installFallow({ cwd: '/x' });
    expect(r.ok).toBe(false);
    expect(r.method).toBeNull();
    const printed = console.log.mock.calls.flat().join('\n');
    expect(printed).toMatch(/bun add -g fallow@/);
    expect(printed).toMatch(/npm install -g fallow@/);
    expect(printed).toMatch(/cargo install fallow-cli/);
  });

  it('never shells out and writes nothing under dryRun', () => {
    installFallow({ cwd: '/x', dryRun: true });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
