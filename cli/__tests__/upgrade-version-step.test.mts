/**
 * `devkit upgrade` — version/pin step wiring (Option B): install a genuinely newer PUBLISHED tag, then
 * decide via `needsRerun` whether to re-run (running CLI itself behind ⇒ can't hot-swap) or continue
 * reconciling in the SAME pass (running CLI already >= latest). The composed slices are mocked at
 * their module boundaries — only `upgrade.mts` imports doctor/init/migrate-config, so wholesale-mocking them
 * is safe — so this exercises upgrade's OWN control flow without a network install or a real reconcile.
 *
 * Pure decisions (cmpSemver / needsRerun) are unit-tested in update.test.mts; this locks the WIRING:
 * a future edit that drops the needsRerun gate (returning NEEDS_RERUN unconditionally, the pre-fix
 * behaviour that caused the exit-10 loop) must turn the continue-path test red.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The version the running CLI reports: upgrade reads its OWN package.json via packageDir().
const V = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version as string;

// Keep cmpSemver / needsRerun / repinPackageJson REAL; stub the network (fetchLatestTag) and the
// install (default `update`, which must NOT touch the repo — so any re-pin we observe is upgrade's).
vi.mock('../commands/update.mts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/update.mts')>()),
  default: vi.fn(async () => 0),
  fetchLatestTag: vi.fn(),
}));
vi.mock('../commands/migrate-config.mts', () => ({ computeMigration: vi.fn(() => []) }));
vi.mock('../commands/init.mts', () => ({ applyInit: vi.fn(async () => {}) }));
vi.mock('../commands/doctor.mts', () => ({ default: vi.fn(async () => 0) }));

import update, { fetchLatestTag } from '../commands/update.mts';
import upgrade from '../commands/upgrade.mts';

const REF = 'git+https://github.com/norvalbv/devkit.git';
const made: string[] = [];

// A config-driven consumer repo whose node_modules devkit is `nmVersion`, pinned stale at #v0.0.1.
const makeRepo = (nmVersion: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-upgr-'));
  made.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'c', devDependencies: { '@norvalbv/devkit': `${REF}#v0.0.1` } }, null, 2)}\n`,
  );
  mkdirSync(join(dir, 'node_modules', '@norvalbv', 'devkit'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '@norvalbv', 'devkit', 'package.json'),
    JSON.stringify({ version: nmVersion }),
  );
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  writeFileSync(
    join(dir, '.devkit', 'config.json'),
    JSON.stringify({
      stack: 'component-lib',
      standalone: false,
      components: { structure: false, agentTargets: ['claude'] },
    }),
  );
  return dir;
};

const spies: Array<{ mockRestore: () => void }> = [];
const silence = () => {
  const s = vi.spyOn(console, 'log').mockImplementation(() => {});
  spies.push(s);
};

beforeEach(() => vi.mocked(update).mockClear());
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('upgrade version step — converge in one pass vs re-run (Option B)', () => {
  it('running CLI already >= latest → installs, then RECONCILES in the same pass (exit 0, re-pinned to latest)', async () => {
    vi.mocked(fetchLatestTag).mockReturnValue({ latest: V }); // published latest == the running CLI
    const dir = makeRepo('0.0.1'); // node_modules far behind ⇒ install fires
    silence();

    const code = await upgrade([], dir);

    expect(code).toBe(0); // NOT NEEDS_RERUN — the Option-B win over the old exit-10 loop
    expect(vi.mocked(update)).toHaveBeenCalledTimes(1); // it did install
    // update was stubbed (no re-pin), so this re-pin to `latest` is upgrade's own in-pass reconcile.
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain(`#v${V}`);
  });

  it('running CLI behind latest → installs and returns NEEDS_RERUN (10), reconcile deferred', async () => {
    vi.mocked(fetchLatestTag).mockReturnValue({ latest: '99.0.0' }); // published newer than the running CLI
    const dir = makeRepo('0.0.1');
    silence();

    const code = await upgrade([], dir);

    expect(code).toBe(10);
    expect(vi.mocked(update)).toHaveBeenCalledTimes(1);
    // returned before reconciling ⇒ the pin is still the stale #v0.0.1.
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('#v0.0.1');
  });
});
