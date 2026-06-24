// `devkit doctor` version-awareness check. Compares the RUNNING devkit (this package's version)
// against the repo's .devkit/config.json — a hand-declared `minDevkit` floor and/or the
// `devkitVersion` stamped at init. Warn-only, config.json-only (never package.json), so overlay
// repos introduce nothing shared. Branches are pinned with 99.0.0 (above any real version) and
// 0.0.1 (below), so the test is deterministic regardless of the actual installed version.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVersion } from '../commands/doctor.mjs';
import { rootRegistry } from './_helpers.mjs';

const { mkTmp, cleanup } = rootRegistry();
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
  });

  it('DRIFT when installed is older than the repo-init stamp (from devkitRef)', () => {
    const root = mkTmp('docver-');
    writeConfig(root, { devkitRef: 'v99.0.0' });
    const r = checkVersion(root);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toContain("repo's init (99.0.0)");
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
});
