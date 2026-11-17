/**
 * install-fallow tests. The suite runs on node's native module runner, where `vi.mock` cannot
 * replace a builtin, so each case puts scripted stand-ins for fallow/bun/npm/cargo on a private
 * PATH: a binary left out is a PATH miss, and every spawn is logged so NO test ever shells out
 * to a real package manager.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FALLOW_PINNED_VERSION,
  detectFallow,
  ensureFallow,
  installFallow,
  resolveOverlayFallow,
} from './install-fallow.mts';

let dir: string;
let cwd: string;
let originalPath: string | undefined;

// Stand-in binary `name`: logs "name args" to the spawn log, prints `stdout`, exits `status`.
function fakeBin(name: string, status: number, stdout = '') {
  const file = join(dir, 'bin', name);
  const body = `#!/bin/sh\necho "${name} $*" >> "${join(dir, 'spawns.log')}"\nprintf '%s' '${stdout}'\nexit ${status}\n`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

// Every spawn so far, as "cmd args" lines, in order.
function spawned(): string[] {
  try {
    return readFileSync(join(dir, 'spawns.log'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-fallow-'));
  cwd = join(dir, 'cwd');
  mkdirSync(cwd);
  mkdirSync(join(dir, 'bin'));
  originalPath = process.env.PATH;
  process.env.PATH = join(dir, 'bin');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('FALLOW_PINNED_VERSION', () => {
  it('pins the approved fallow release exactly, never a floating tag', () => {
    expect(FALLOW_PINNED_VERSION).toBe('3.35.0');
  });
});

describe('detectFallow', () => {
  // Real 3.x shape: a second "verified:" line that repeats the version.
  it('parses the version from a `fallow --version` probe', () => {
    fakeBin('fallow', 0, 'fallow 3.12.1\nverified: yes (cache hit); fallow 3.12.1 signed\n');
    expect(detectFallow({ cwd })).toEqual({ available: true, version: '3.12.1' });
  });

  // The hook runs `command -v fallow`, so a copy only npx can reach must not count as installed.
  it('reports unavailable on a PATH miss without probing npx', () => {
    fakeBin('npx', 0, 'fallow 9.9.9\n');
    expect(detectFallow({ cwd })).toEqual({ available: false, version: null });
    expect(spawned()).toEqual([]);
  });
});

describe('ensureFallow', () => {
  it.each(['99.0.0', FALLOW_PINNED_VERSION])(
    'keeps an installed fallow %s: probe only, no install',
    (v) => {
      fakeBin('fallow', 0, `fallow ${v}\n`);
      fakeBin('bun', 0);
      expect(ensureFallow({ cwd })).toEqual({
        ok: true,
        message: `using installed fallow ${v} (>= ${FALLOW_PINNED_VERSION})`,
      });
      expect(spawned()).toEqual(['fallow --version']);
    },
  );

  // A prerelease suffix must not read as "older": installing the pin would downgrade it.
  it('keeps a newer prerelease fallow instead of downgrading it to the pin', () => {
    fakeBin('fallow', 0, 'fallow 99.0.0-rc.1\n');
    fakeBin('bun', 0);
    expect(ensureFallow({ cwd }).ok).toBe(true);
    expect(spawned()).toEqual(['fallow --version']);
  });

  // 3.6.0 sorts above 3.35.0 as a string, so this catches a lexical compare.
  it.each(['3.6.0', '3.9.99'])('installs the pin over a below-pin fallow %s', (v) => {
    fakeBin('fallow', 0, `fallow ${v}\n`);
    fakeBin('bun', 0);
    const r = ensureFallow({ cwd });
    expect(r.ok).toBe(true);
    expect(r.message).toBe(
      `fallow ${v} is below ${FALLOW_PINNED_VERSION}: installed fallow@${FALLOW_PINNED_VERSION} via bun`,
    );
    expect(spawned()).toEqual(['fallow --version', `bun add -g fallow@${FALLOW_PINNED_VERSION}`]);
  });

  it('installs the pin when fallow is absent', () => {
    fakeBin('bun', 0);
    expect(ensureFallow({ cwd }).message).toMatch(/^fallow not found: installed fallow@/);
    expect(spawned()).toEqual([`bun add -g fallow@${FALLOW_PINNED_VERSION}`]);
  });

  it('dryRun prints the decision and spawns nothing', () => {
    fakeBin('fallow', 0, 'fallow 1.0.0\n');
    expect(ensureFallow({ cwd, dryRun: true }).message).toMatch(
      /^\[dry-run\] fallow: keep an installed/,
    );
    expect(spawned()).toEqual([]);
  });
});

describe('installFallow', () => {
  it('stops at the first PM that succeeds (bun)', () => {
    fakeBin('bun', 0);
    fakeBin('npm', 0);
    expect(installFallow({ cwd })).toMatchObject({ ok: true, method: 'bun' });
    expect(spawned()).toHaveLength(1);
  });

  it('falls through bun→npm→cargo and uses cargo when only it works', () => {
    fakeBin('bun', 1);
    fakeBin('npm', 1);
    fakeBin('cargo', 0);
    expect(installFallow({ cwd })).toMatchObject({ ok: true, method: 'cargo' });
    // cargo crate is fallow-cli (binary is fallow), pinned by --version.
    expect(spawned()[2]).toBe(`cargo install fallow-cli --version ${FALLOW_PINNED_VERSION}`);
  });

  it('returns ok:false and prints manual steps when every PM misses', () => {
    const r = installFallow({ cwd });
    expect(r.ok).toBe(false);
    expect(r.method).toBeNull();
    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).toMatch(/bun add -g fallow@/);
    expect(printed).toMatch(/npm install -g fallow@/);
    expect(printed).toMatch(/cargo install fallow-cli/);
  });

  it('never shells out and writes nothing under dryRun', () => {
    fakeBin('bun', 0);
    installFallow({ cwd, dryRun: true });
    expect(spawned()).toEqual([]);
  });
});

describe('resolveOverlayFallow', () => {
  it('keeps an installed fallow at the pin, with no install spawn', () => {
    fakeBin('fallow', 0, `fallow ${FALLOW_PINNED_VERSION}\n`);
    fakeBin('bun', 0);
    expect(resolveOverlayFallow(cwd, false)).toBe(true);
    expect(spawned()).toEqual(['fallow --version']);
  });

  // The pin is the minimum: a below-pin fallow that cannot be upgraded is not gated on either.
  it.each([null, 'fallow 3.6.0\n'])(
    'skips the gate when fallow (%s) cannot be brought to the pin',
    (probe) => {
      if (probe) fakeBin('fallow', 0, probe);
      expect(resolveOverlayFallow(cwd, false)).toBe(false);
    },
  );
});
