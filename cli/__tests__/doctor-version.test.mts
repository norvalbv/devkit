// `devkit doctor` version-awareness check. Compares the RUNNING devkit (this package's version)
// against the repo's .devkit/config.json — a hand-declared `minDevkit` floor and/or the
// `devkitVersion` stamped at init. Warn-only, config.json-only (never package.json), so overlay
// repos introduce nothing shared. Branches are pinned with 99.0.0 (above any real version) and
// 0.0.1 (below), so the test is deterministic regardless of the actual installed version.
// Also covers the latest-published-tag note: a single `git ls-remote` (mocked here), gated by
// DEVKIT_SKIP_REMOTE_CHECKS, informational-only (always OK, never DRIFT) — mirrors checkLockPin's
// network contract in pin-checks.test.mts. Sentinel v9.9.9 (above any real version) / empty output
// (no tags) keep the network path deterministic the same way the floor sentinels do.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkVersion } from '../commands/doctor.mts';
import { packageDir, readJson } from '../lib/fs-helpers.mts';
import { rootRegistry } from './_helpers.mts';

const RUNNING_VERSION = (
  readJson(join(packageDir(), 'package.json')) as { version?: string } | null
)?.version;

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const mocked = vi.mocked(execFileSync);
const { mkTmp, cleanup } = rootRegistry();

beforeEach(() => {
  mocked.mockReset();
  mocked.mockReturnValue(''); // no tags found -> fetchLatestTag() resolves { latest: null }
});
afterEach(cleanup);

const writeConfig = (root, cfg) => {
  mkdirSync(join(root, '.devkit'), { recursive: true });
  writeFileSync(join(root, '.devkit', 'config.json'), JSON.stringify(cfg));
};

describe('doctor checkVersion', () => {
  it('DRIFT when installed is below the declared minDevkit', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { minDevkit: '99.0.0' });
    const r = checkVersion(root);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain('minimum 99.0.0');
    expect(r.remediation).toBe('devkit update');
    expect(mocked).not.toHaveBeenCalled();
  });

  it('DRIFT when installed is older than the repo-init stamp (from devkitRef)', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { devkitRef: 'v99.0.0' });
    const r = checkVersion(root);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain("repo's init (99.0.0)");
    expect(mocked).not.toHaveBeenCalled();
  });

  it('DRIFT on a floor breach wins over a simultaneous behind-latest tag, and skips the network', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { minDevkit: '99.0.0' });
    mocked.mockReturnValue('abc123\trefs/tags/v9.9.9\n');
    const r = checkVersion(root);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain('minimum 99.0.0');
    expect(mocked).not.toHaveBeenCalled();
  });

  it('ignores a non-version devkitRef (main/branch/SHA) as a baseline', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { devkitRef: 'main' });
    expect(checkVersion(root).status).toBe('OK');
  });

  it('OK when installed satisfies both the min and the stamp', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { minDevkit: '0.0.1', devkitRef: 'v0.0.1' });
    const r = checkVersion(root);
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('repo init 0.0.1');
    expect(r.detail).toContain('min 0.0.1');
  });

  it('OK detail echoes a declared min even with no init stamp (so the floor is visible)', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { minDevkit: '0.0.1' });
    const r = checkVersion(root);
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('min 0.0.1');
  });

  it('OK (no false warn) when config / version fields are absent', () => {
    expect(checkVersion(mkTmp('docver-')).status).toBe('OK');
  });

  it('OK with no behind-latest note when installed is already the latest tag', () => {
    mocked.mockReturnValue('abc123\trefs/tags/v0.0.1\n');
    const r = checkVersion(mkTmp('docver-'));
    expect(r.status).toBe('OK');
    expect(r.detail).not.toContain('latest');
  });

  it('OK with a behind-latest note when installed is older than the latest published tag', () => {
    mocked.mockReturnValue('abc123\trefs/tags/v9.9.9\n');
    const r = checkVersion(mkTmp('docver-'));
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('latest 9.9.9');
    expect(r.detail).toContain('devkit update');
  });

  it('OK with no note and no network call when DEVKIT_SKIP_REMOTE_CHECKS is set', () => {
    mocked.mockReturnValue('abc123\trefs/tags/v9.9.9\n');
    const r = checkVersion(mkTmp('docver-'), { DEVKIT_SKIP_REMOTE_CHECKS: '1' });
    expect(r.status).toBe('OK');
    expect(r.detail).not.toContain('latest');
    expect(mocked).not.toHaveBeenCalled();
  });

  it('OK with no note when the remote is unreachable', () => {
    mocked.mockImplementation(() => {
      throw new Error('could not resolve host');
    });
    const r = checkVersion(mkTmp('docver-'));
    expect(r.status).toBe('OK');
    expect(r.detail).not.toContain('latest');
  });

  it('OK with no behind-latest note when installed EQUALS the latest tag exactly (boundary)', () => {
    // Exercises cmpSemver(running, latest) < 0 at the equality boundary specifically — a stray `<=`
    // would wrongly show "latest" for a repo that IS current.
    mocked.mockReturnValue(`abc123\trefs/tags/v${RUNNING_VERSION}\n`);
    const r = checkVersion(mkTmp('docver-'));
    expect(r.status).toBe('OK');
    expect(r.detail).not.toContain('latest');
  });

  it('OK detail combines a satisfied floor echo AND a behind-latest note together', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { minDevkit: '0.0.1' });
    mocked.mockReturnValue('abc123\trefs/tags/v9.9.9\n');
    const r = checkVersion(root);
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('min 0.0.1');
    expect(r.detail).toContain('latest 9.9.9');
  });

  it('a DEVKIT_SKIP_REMOTE_CHECKS value of "0" still opts out (truthy string, not boolean false)', () => {
    // Mirrors checkLockPin's identical `if (env.DEVKIT_SKIP_REMOTE_CHECKS)` truthy-string check — a
    // user writing `=0` expecting "off" gets the same skip as `=1`, since only '' is falsy in JS.
    mocked.mockReturnValue('abc123\trefs/tags/v9.9.9\n');
    const r = checkVersion(mkTmp('docver-'), { DEVKIT_SKIP_REMOTE_CHECKS: '0' });
    expect(r.status).toBe('OK');
    expect(r.detail).not.toContain('latest');
    expect(mocked).not.toHaveBeenCalled();
  });
});
