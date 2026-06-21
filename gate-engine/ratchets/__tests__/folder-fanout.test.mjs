import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mjs';
import { countFanout, overCap } from '../folder-fanout.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'folder-fanout.mjs');
const FANOUT_CAP = 12; // engine default (config.mjs DEFAULTS.fanoutCap)

let roots = [];
const makeRoot = () => {
  // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each is self-contained with the same freeze/gate CLI shell
  // fallow-ignore-next-line code-duplication
  const root = mkdtempSync(join(tmpdir(), 'fanout-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const fill = (root, dir, n, prefix = 'file') => {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(root, dir, `${prefix}-${i}.ts`), 'export {};\n');
};

const writeConfig = (root, cfg) =>
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify(cfg));

describe('countFanout', () => {
  it('counts impl files per directory at every depth, recursively', () => {
    const root = makeRoot();
    fill(root, 'src/a', 3);
    fill(root, 'src/a/deep/deeper', 5);
    const counts = countFanout(root);
    expect(counts['src/a']).toBe(3);
    expect(counts['src/a/deep/deeper']).toBe(5);
  });

  it('excludes tests, barrels, and skip-dirs from the count', () => {
    const root = makeRoot();
    fill(root, 'src/a', 2);
    writeFileSync(join(root, 'src/a/index.ts'), 'export {};\n');
    writeFileSync(join(root, 'src/a/x.test.ts'), 'export {};\n');
    fill(root, 'src/a/__tests__', 4);
    fill(root, 'src/node_modules/dep', 30);
    const counts = countFanout(root);
    expect(counts['src/a']).toBe(2);
    expect(counts['src/a/__tests__']).toBeUndefined();
    expect(counts['src/node_modules/dep']).toBeUndefined();
  });

  it('honours config.scanRoots (multi-root, no longer hardcoded)', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src', 'socket-server/src', 'vercel-serverless'] });
    fill(root, 'src/a', 3);
    fill(root, 'socket-server/src/b', 4);
    fill(root, 'vercel-serverless/c', 5);
    fill(root, 'ignored-root/d', 9); // not in scanRoots → invisible
    const counts = countFanout(root);
    expect(counts['src/a']).toBe(3);
    expect(counts['socket-server/src/b']).toBe(4);
    expect(counts['vercel-serverless/c']).toBe(5);
    expect(counts['ignored-root/d']).toBeUndefined();
  });

  it('exempts only config.fanoutExempt dirs (NOT hardcoded — opt-in per consumer)', () => {
    const root = makeRoot();
    writeConfig(root, {
      fanoutExempt: ['src/main/lib/trpc/routers', 'src/renderer/components/ui'],
    });
    fill(root, 'src/main/lib/trpc/routers', 40);
    fill(root, 'src/renderer/components/ui', 40);
    fill(root, 'src/main/lib/flows', 40);
    const counts = countFanout(root);
    expect(counts['src/main/lib/trpc/routers']).toBeUndefined();
    expect(counts['src/renderer/components/ui']).toBeUndefined();
    expect(counts['src/main/lib/flows']).toBe(40);
  });

  it('without a config, frink-style exempt dirs are NOT silently exempt (defaults: [])', () => {
    const root = makeRoot();
    fill(root, 'src/main/lib/trpc/routers', 40);
    const counts = countFanout(root);
    expect(counts['src/main/lib/trpc/routers']).toBe(40);
  });

  it('boundary: exactly at cap is legal, cap+1 is an offender', () => {
    const root = makeRoot();
    fill(root, 'src/at-cap', FANOUT_CAP);
    fill(root, 'src/over-cap', FANOUT_CAP + 1);
    const offenders = overCap(countFanout(root), FANOUT_CAP);
    expect(offenders['src/at-cap']).toBeUndefined();
    expect(offenders['src/over-cap']).toBe(FANOUT_CAP + 1);
  });

  it('honours a custom config.fanoutCap', () => {
    const root = makeRoot();
    writeConfig(root, { fanoutCap: 3 });
    fill(root, 'src/small', 4);
    const cap = resolveGuardConfig(root).fanoutCap;
    expect(cap).toBe(3);
    expect(overCap(countFanout(root), cap)['src/small']).toBe(4);
  });
});

describe('CLI freeze/gate contract', () => {
  const run = (root, cmd) =>
    spawnSync(process.execPath, [SCRIPT, cmd], { cwd: root, encoding: 'utf8' });

  it('freeze grandfathers current offenders; gate passes while they do not grow', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 20);
    expect(run(root, 'freeze').status).toBe(0);
    const frozen = JSON.parse(readFileSync(join(root, 'eslint/baselines/fanout.json'), 'utf8'));
    expect(frozen.dirs['src/pile']).toBe(20);
    expect(run(root, 'gate').status).toBe(0);
  });

  it('writes the baseline under the CONSUMER cwd, not the package dir (W-3)', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 20);
    expect(run(root, 'freeze').status).toBe(0);
    // Baseline must materialize inside the temp consumer repo, addressed from its cwd.
    expect(() => readFileSync(join(root, 'eslint/baselines/fanout.json'), 'utf8')).not.toThrow();
  });

  it('gate blocks a NEW folder exceeding the cap', () => {
    const root = makeRoot();
    fill(root, 'src/ok', 3);
    run(root, 'freeze');
    fill(root, 'src/new-pile', FANOUT_CAP + 1);
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/new-pile');
  });

  it('gate blocks a grandfathered folder growing past its frozen count (shrink-only)', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 20);
    run(root, 'freeze');
    fill(root, 'src/pile', 21); // rewrites 0..20 → 21 files
    expect(run(root, 'gate').status).toBe(1);
  });

  it('gate passes (with re-freeze reminder) when a pile shrinks', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 20);
    run(root, 'freeze');
    rmSync(join(root, 'src/pile'), { recursive: true });
    fill(root, 'src/pile', 5);
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrank');
  });

  it('gate fails OPEN (exit 2) without a baseline; unknown command exits 2', () => {
    const root = makeRoot();
    fill(root, 'src/a', 1);
    expect(run(root, 'gate').status).toBe(2);
    expect(run(root, 'bogus').status).toBe(2);
  });

  it('gate honours config.scanRoots + fanoutExempt end-to-end', () => {
    const root = makeRoot();
    writeConfig(root, {
      scanRoots: ['src', 'socket-server/src'],
      fanoutExempt: ['src/main/lib/trpc/routers'],
    });
    fill(root, 'src/main/lib/trpc/routers', 40); // exempt → ignored
    run(root, 'freeze');
    fill(root, 'socket-server/src/new-pile', FANOUT_CAP + 1); // in scanRoots → caught
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('socket-server/src/new-pile');
  });
});
