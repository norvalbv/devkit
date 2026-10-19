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

const {
  FALLOW_PINNED_VERSION,
  detectFallow,
  ensureFallow,
  installFallow,
  ensureFallowGitignore,
  resolveOverlayFallow,
} = await import('./install-fallow.mts');

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
  it('pins the approved fallow release exactly, never a floating tag', () => {
    expect(FALLOW_PINNED_VERSION).toBe('3.10.0');
  });
});

describe('detectFallow', () => {
  // Real 3.x shape: a second "verified:" line that repeats the version.
  it('parses the version from a `fallow --version` probe', () => {
    const out =
      'fallow 3.12.1\nverified: yes (cache hit at /g/.fallow-verified); fallow 3.12.1 signed\n';
    spawnSync.mockReturnValueOnce(result(0, out));
    expect(detectFallow({ cwd: '/x' })).toEqual({ available: true, version: '3.12.1' });
  });

  // The hook runs `command -v fallow`, so a copy only npx can reach must not count as installed.
  it('reports unavailable on a PATH miss without probing npx', () => {
    spawnSync.mockReturnValue(result(null));
    expect(detectFallow({ cwd: '/x' })).toEqual({ available: false, version: null });
    expect(spawnSync.mock.calls.map((c) => c[0])).toEqual(['fallow']);
  });
});

describe('ensureFallow', () => {
  const spawned = () => spawnSync.mock.calls.map((c) => [c[0], ...c[1]].join(' '));

  it.each(['3.34.1', FALLOW_PINNED_VERSION])(
    'keeps an installed fallow %s: probe only, no install',
    (v) => {
      spawnSync.mockReturnValueOnce(result(0, `fallow ${v}\n`));
      expect(ensureFallow({ cwd: '/x' })).toEqual({
        ok: true,
        message: `using installed fallow ${v} (>= ${FALLOW_PINNED_VERSION})`,
      });
      expect(spawned()).toEqual(['fallow --version']);
    },
  );

  // A prerelease suffix must not read as "older": installing the pin would downgrade it.
  it('keeps a newer prerelease fallow instead of downgrading it to the pin', () => {
    spawnSync.mockReturnValueOnce(result(0, 'fallow 3.10.1-rc.1\n'));
    expect(ensureFallow({ cwd: '/x' }).ok).toBe(true);
    expect(spawned()).toEqual(['fallow --version']);
  });

  // 3.6.0 sorts above 3.10.0 as a string, so this catches a lexical compare.
  it.each(['3.6.0', '3.9.99'])('installs the pin over a below-pin fallow %s', (v) => {
    spawnSync.mockReturnValueOnce(result(0, `fallow ${v}\n`)).mockReturnValueOnce(result(0));
    const r = ensureFallow({ cwd: '/x' });
    expect(r.ok).toBe(true);
    expect(r.message).toBe(
      `fallow ${v} is below ${FALLOW_PINNED_VERSION}: installed fallow@${FALLOW_PINNED_VERSION} via bun`,
    );
    expect(spawned()).toEqual(['fallow --version', `bun add -g fallow@${FALLOW_PINNED_VERSION}`]);
  });

  it('installs the pin when fallow is absent', () => {
    spawnSync.mockReturnValueOnce(result(null)).mockReturnValueOnce(result(0));
    expect(ensureFallow({ cwd: '/x' }).message).toMatch(/^fallow not found: installed fallow@/);
    expect(spawned()[1]).toBe(`bun add -g fallow@${FALLOW_PINNED_VERSION}`);
  });

  it('dryRun prints the decision and spawns nothing', () => {
    expect(ensureFallow({ cwd: '/x', dryRun: true }).message).toMatch(
      /^\[dry-run\] fallow: keep an installed/,
    );
    expect(spawnSync).not.toHaveBeenCalled();
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

describe('resolveOverlayFallow', () => {
  it('keeps an installed fallow at the pin and saves baselines, with no install spawn', () => {
    spawnSync.mockReturnValueOnce(result(0, `fallow ${FALLOW_PINNED_VERSION}\n`));
    spawnSync.mockReturnValue(result(0));
    expect(resolveOverlayFallow('/x', false)).toBe(true);
    const cmds = spawnSync.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(['fallow', 'fallow', 'fallow', 'fallow']);
  });

  // The pin is the minimum: a below-pin fallow that cannot be upgraded is not gated on either.
  it.each([null, 'fallow 3.6.0\n'])(
    'skips the gate when fallow (%s) cannot be brought to the pin',
    (probe) => {
      spawnSync.mockReturnValueOnce(probe ? result(0, probe) : result(null));
      spawnSync.mockReturnValue(result(null));
      expect(resolveOverlayFallow('/x', false)).toBe(false);
      expect(spawnSync.mock.calls.some((c) => c[1].includes('--save-baseline'))).toBe(false);
    },
  );
});
