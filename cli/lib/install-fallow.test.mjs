/**
 * install-fallow tests. The single spawn seam (spawnSync) is mocked so NO test ever shells
 * out to bun/npm/cargo/fallow — each case scripts the per-command exit status it wants.
 * File IO (gitignore) runs against a real tmp repo, mirroring detect-stack.test.mjs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the spawn seam before importing the module under test.
const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...a) => spawnSync(...a) }));

const { FALLOW_PINNED_VERSION, detectFallow, installFallow, ensureFallowGitignore } = await import(
  './install-fallow.mjs'
);

let roots = [];
function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'fallow-'));
  roots.push(root);
  return root;
}
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
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('FALLOW_PINNED_VERSION', () => {
  it('is a concrete semver, never a floating tag', () => {
    expect(FALLOW_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
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

describe('ensureFallowGitignore', () => {
  it('creates .gitignore with the .fallow/ line when absent', () => {
    const root = tmpRepo();
    ensureFallowGitignore({ cwd: root });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.fallow/');
  });

  it('is idempotent — a second call adds nothing', () => {
    const root = tmpRepo();
    ensureFallowGitignore({ cwd: root });
    const after = readFileSync(join(root, '.gitignore'), 'utf8');
    ensureFallowGitignore({ cwd: root });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(after);
    expect(after.match(/\.fallow\//g)).toHaveLength(1);
  });

  it('appends to an existing .gitignore without clobbering it', () => {
    const root = tmpRepo();
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    ensureFallowGitignore({ cwd: root });
    const out = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(out).toContain('node_modules');
    expect(out).toContain('.fallow/');
  });

  it('dryRun writes nothing', () => {
    const root = tmpRepo();
    ensureFallowGitignore({ cwd: root, dryRun: true });
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});
