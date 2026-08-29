import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { countFanout, overCap } from '../folder-fanout.mts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'folder-fanout.mts');
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
const write = (root, rel, content) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const gitInit = (root) => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
};
const gitAdd = (root, ...paths) => execFileSync('git', ['add', ...paths], { cwd: root });

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

  it('counts an explicit skip-named scanRoot while still skipping one nested below another root', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['dist', 'src'] });
    fill(root, 'dist', 3);
    fill(root, 'src/out', 4);
    const counts = countFanout(root);
    expect(counts.dist).toBe(3);
    expect(counts['src/out']).toBeUndefined();
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
    const frozen = JSON.parse(readFileSync(join(root, '.devkit/baselines/fanout.json'), 'utf8'));
    expect(frozen.dirs['src/pile']).toBe(20);
    expect(run(root, 'gate').status).toBe(0);
  });

  it('reads a legacy fan-out baseline and canonicalizes it on the next freeze', () => {
    const root = makeRoot();
    writeConfig(root, {});
    fill(root, 'src/pile', 20);
    write(
      root,
      'eslint/baselines/fanout.json',
      JSON.stringify({ cap: FANOUT_CAP, dirs: { 'src/pile': 20 } }),
    );

    expect(run(root, 'gate').status).toBe(0);
    fill(root, 'src/pile', 21);
    const result = run(root, 'gate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/pile: 21 files (allowed 20)');

    expect(run(root, 'freeze').status).toBe(0);
    const canonical = JSON.parse(readFileSync(join(root, '.devkit/baselines/fanout.json'), 'utf8'));
    expect(canonical.dirs['src/pile']).toBe(21);
    // The legacy alias is still a supported read path, so a freeze keeps it CURRENT rather than
    // retiring it — retiring is migrateRatchetBaselines' job under `devkit init`/`upgrade` (sc-1934).
    const alias = JSON.parse(readFileSync(join(root, 'eslint/baselines/fanout.json'), 'utf8'));
    expect(alias.dirs['src/pile']).toBe(21);
  });

  it('writes the baseline under the CONSUMER cwd, not the package dir (W-3)', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 20);
    expect(run(root, 'freeze').status).toBe(0);
    // Baseline must materialize inside the temp consumer repo, addressed from its cwd.
    expect(() => readFileSync(join(root, '.devkit/baselines/fanout.json'), 'utf8')).not.toThrow();
  });

  it('gate blocks a NEW folder exceeding the cap', () => {
    const root = makeRoot();
    writeConfig(root, {}); // governed repo → enforce even with no debt baseline
    fill(root, 'src/ok', 3);
    run(root, 'freeze'); // no offender → no baseline written
    fill(root, 'src/new-pile', FANOUT_CAP + 1);
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/new-pile');
  });

  it('gate counts a skip-named scanRoot in both HEAD and the pending index', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, { scanRoots: ['dist'] });
    fill(root, 'dist', FANOUT_CAP);
    gitAdd(root, '.');
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });

    fill(root, 'dist', FANOUT_CAP + 1);
    gitAdd(root, 'dist');
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dist: 13 files');
  });

  it('freeze writes NO baseline when no folder is over cap (no empty file left on disk)', () => {
    const root = makeRoot();
    fill(root, 'src/ok', 3);
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, '.devkit/baselines/fanout.json'), 'utf8')).toThrow();
  });

  it('freeze deletes a stale empty baseline once the last over-cap pile heals', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 20);
    run(root, 'freeze'); // fanout.json written
    rmSync(join(root, 'src/pile'), { recursive: true });
    fill(root, 'src/pile', 5); // under cap now
    expect(run(root, 'freeze').status).toBe(0);
    expect(() => readFileSync(join(root, '.devkit/baselines/fanout.json'), 'utf8')).toThrow();
  });

  it('gate ENFORCES from config (not fail-open) when governed but no baseline exists', () => {
    const root = makeRoot();
    writeConfig(root, {}); // governed, never frozen
    fill(root, 'src/new-pile', FANOUT_CAP + 1);
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/new-pile');
  });

  it('gate heal-deletes + stages fanout.json when the last pile heals in a real commit', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, {});
    fill(root, 'src/pile', 20);
    run(root, 'freeze'); // fanout.json = { dirs: { 'src/pile': 20 } }
    gitAdd(root, 'guard.config.json', 'src/pile', '.devkit/baselines/fanout.json');
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    rmSync(join(root, 'src/pile'), { recursive: true });
    fill(root, 'src/pile', 5); // healed under cap
    gitAdd(root, 'src/pile');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('removed & staged');
    expect(() => readFileSync(join(root, '.devkit/baselines/fanout.json'), 'utf8')).toThrow();
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=D'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(staged).toContain('.devkit/baselines/fanout.json');
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

  it('freeze names folders that grew since the previous freeze', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 20);
    run(root, 'freeze');
    fill(root, 'src/pile', 22);
    const r = run(root, 'freeze');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('grew since the last freeze');
    expect(r.stdout).toContain('src/pile: 20 → 22');
  });
});

// The gate must fail the CHANGE that broke the cap, never whoever commits next. These cases use a
// real repository and index because that is the only context where "this change" is defined.
describe('attribution — pending index against HEAD', () => {
  const run = (root, cmd, cwd = root) =>
    spawnSync(process.execPath, [SCRIPT, cmd], { cwd, encoding: 'utf8' });

  const driftedRepo = (piled = 24, frozenAt = 23) => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, {});
    fill(root, 'src/pile', frozenAt);
    run(root, 'freeze');
    fill(root, 'src/pile', piled);
    mkdirSync(join(root, 'src/other'), { recursive: true });
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'seed with drift'], { cwd: root });
    return root;
  };

  it('does not blame an unrelated change for existing fan-out drift', () => {
    const root = driftedRepo();
    writeFileSync(join(root, 'src/other/unrelated.ts'), 'export {};\n');
    gitAdd(root, 'src/other/unrelated.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('Folder fan-out exceeded');
  });

  it('reports drift separately with the baseline-refresh remedy', () => {
    const root = driftedRepo();
    writeFileSync(join(root, 'src/other/unrelated.ts'), 'export {};\n');
    gitAdd(root, 'src/other/unrelated.ts');
    const r = run(root, 'gate');
    expect(r.stdout).toContain('drifted above their baseline');
    expect(r.stdout).toContain('src/pile: 24 files (baseline 23)');
    expect(r.stdout).toContain('guard-fanout freeze');
    expect(r.stdout).not.toContain('Split into cohesive kebab subfolders');
    expect(r.stdout).not.toContain('Folder fan-out exceeded');
  });

  it('still blocks a change that grows the drifted folder further', () => {
    const root = driftedRepo();
    writeFileSync(join(root, 'src/pile/grown.ts'), 'export {};\n');
    gitAdd(root, 'src/pile/grown.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/pile: 25 files (allowed 23)');
    expect(r.stderr).toContain('Split into cohesive kebab subfolders');
  });

  it('blocks a fresh folder crossing the cap', () => {
    const root = driftedRepo();
    fill(root, 'src/brand-new', FANOUT_CAP + 1);
    gitAdd(root, 'src/brand-new');
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/brand-new');
  });

  it('blocks drift with a clean index, preserving the CI backstop', () => {
    const root = driftedRepo();
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/pile: 24 files (allowed 23)');
  });

  it("ignores a parallel agent's untracked files", () => {
    const root = driftedRepo();
    for (const name of ['p1', 'p2', 'p3'])
      writeFileSync(join(root, `src/pile/${name}.ts`), 'export {};\n');
    writeFileSync(join(root, 'src/pile/file-0.ts'), 'export {}; // edited\n');
    gitAdd(root, 'src/pile/file-0.ts');
    const r = run(root, 'gate');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('src/pile: 24 files (baseline 23)');
  });

  it('catches a merge that creates an aggregate pile neither parent had', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, {});
    fill(root, 'src/pile', 8);
    gitAdd(root, '-A');
    execFileSync('git', ['commit', '-qm', 'fork point'], { cwd: root });
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

    git('checkout', '-qb', 'branch-a');
    for (let i = 0; i < 4; i++) writeFileSync(join(root, `src/pile/a${i}.ts`), 'export {};\n');
    gitAdd(root, '-A');
    git('commit', '-qm', 'branch a adds 4');

    git('checkout', '-q', git('rev-parse', 'HEAD~1').trim());
    git('checkout', '-qb', 'branch-b');
    for (let i = 0; i < 4; i++) writeFileSync(join(root, `src/pile/b${i}.ts`), 'export {};\n');
    gitAdd(root, '-A');
    git('commit', '-qm', 'branch b adds 4');

    spawnSync('git', ['merge', '--no-commit', '--no-ff', 'branch-a'], { cwd: root });
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/pile');
  });

  it('enforces from a monorepo package-directory install', () => {
    const repo = makeRoot();
    gitInit(repo);
    const pkg = join(repo, 'packages/app');
    mkdirSync(pkg, { recursive: true });
    writeConfig(pkg, {});
    mkdirSync(join(repo, 'other/src'), { recursive: true });
    writeFileSync(join(repo, 'other/src/sibling.ts'), 'export {};\n');
    fill(pkg, 'src/pile', FANOUT_CAP);
    run(pkg, 'freeze', pkg);
    gitAdd(repo, '-A');
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });

    writeFileSync(join(pkg, 'src/pile/over.ts'), 'export {};\n');
    execFileSync('git', ['add', 'src/pile/over.ts'], { cwd: pkg });
    const r = run(pkg, 'gate', pkg);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`src/pile: ${FANOUT_CAP + 1} files`);
  });

  it('treats every over-cap folder as new on an unborn HEAD', () => {
    const root = makeRoot();
    gitInit(root);
    writeConfig(root, {});
    fill(root, 'src/pile', FANOUT_CAP + 1);
    gitAdd(root, '-A');
    const r = run(root, 'gate');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/pile');
  });
});
