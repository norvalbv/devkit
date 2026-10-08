import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { publishManifest, stageManifest } from '../../../../gate-engine/coverage/provenance.mts';
import { computePercentages } from '../../../../gate-engine/coverage/run.mts';
import {
  coverageMapSchema,
  deriveForeignRoot,
  rebaseCoverageMap,
  rebaseWorktreeCoverage,
} from './coverage-rebase.mts';

const helper = fileURLToPath(new URL('./coverage-rebase.mts', import.meta.url));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A minimal istanbul entry: one statement, one function, one branch pair, all hit `hits` times. */
const entry = (path: string, hits = 1) => ({
  path,
  statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
  fnMap: { 0: { name: 'f', line: 1 } },
  branchMap: { 0: { type: 'if', line: 1 } },
  s: { 0: hits },
  f: { 0: hits },
  b: { 0: [hits, 0] },
});

describe('deriveForeignRoot', () => {
  const tracked = new Set(['src/a.ts', 'src/index.ts', 'index.ts', 'packages/app/src/x.ts']);

  it('names the checkout the absolute keys were produced under', () => {
    expect(deriveForeignRoot(['/dev/checkout/src/a.ts'], tracked, '/tmp/ship-wt')).toBe(
      '/dev/checkout',
    );
  });

  it('returns null when the keys already sit under the worktree, trailing slash or not', () => {
    expect(deriveForeignRoot(['/tmp/ship-wt/src/a.ts'], tracked, '/tmp/ship-wt')).toBeNull();
    expect(deriveForeignRoot(['/tmp/ship-wt/src/a.ts'], tracked, '/tmp/ship-wt/')).toBeNull();
  });

  it('returns null for repo-relative keys, which fallow already joins', () => {
    expect(deriveForeignRoot(['src/a.ts'], tracked, '/tmp/ship-wt')).toBeNull();
  });

  it('returns null when no key reaches a tracked path (stale or foreign-repo coverage)', () => {
    expect(deriveForeignRoot(['/dev/checkout/gen/out.js'], tracked, '/tmp/ship-wt')).toBeNull();
    expect(deriveForeignRoot([], tracked, '/tmp/ship-wt')).toBeNull();
  });

  it('does not let a shallow tracked file claim a deeper key with the wrong prefix', () => {
    // `index.ts` is tracked at the root AND under src/ — the prefix must be /dev/checkout, never
    // /dev/checkout/src (which would rebase src/index.ts onto <wt>/index.ts).
    expect(deriveForeignRoot(['/dev/checkout/src/index.ts'], tracked, '/wt')).toBe('/dev/checkout');
  });

  it('takes the majority root when the map merges runs from several checkouts', () => {
    const keys = ['/a/src/a.ts', '/b/src/a.ts', '/b/src/index.ts', '/b/index.ts'];
    expect(deriveForeignRoot(keys, tracked, '/wt')).toBe('/b');
  });

  it('resolves a monorepo package key to the repo root, not the package root', () => {
    expect(deriveForeignRoot(['/dev/mono/packages/app/src/x.ts'], tracked, '/wt')).toBe(
      '/dev/mono',
    );
  });

  it('handles a producing root with spaces (a real consumer path shape)', () => {
    expect(
      deriveForeignRoot(['/Users/me/Personal and learning/frink/src/a.ts'], tracked, '/wt'),
    ).toBe('/Users/me/Personal and learning/frink');
  });

  it('handles coverage produced at the filesystem root (a container WORKDIR of /)', () => {
    expect(deriveForeignRoot(['/src/a.ts'], tracked, '/wt')).toBe('/');
  });
});

describe('rebaseCoverageMap', () => {
  it('moves the key and its istanbul path, and keeps keys outside the root untouched', () => {
    const out = rebaseCoverageMap(
      { '/dev/c/src/a.ts': entry('/dev/c/src/a.ts'), '/elsewhere/z.ts': entry('/elsewhere/z.ts') },
      '/dev/c',
      '/wt',
    );
    expect(Object.keys(out).sort()).toEqual(['/elsewhere/z.ts', '/wt/src/a.ts']);
    expect(out['/wt/src/a.ts']?.path).toBe('/wt/src/a.ts');
    expect(out['/elsewhere/z.ts']?.path).toBe('/elsewhere/z.ts');
  });

  it('respects the path boundary: a sibling dir sharing the prefix string is not rewritten', () => {
    const out = rebaseCoverageMap(
      { '/dev/c2/src/a.ts': entry('/dev/c2/src/a.ts') },
      '/dev/c',
      '/wt',
    );
    expect(Object.keys(out)).toEqual(['/dev/c2/src/a.ts']);
  });

  it('keeps the key already under the worktree when a rebased key would collide with it', () => {
    const local = entry('/wt/src/a.ts', 7);
    const out = rebaseCoverageMap(
      { '/dev/c/src/a.ts': entry('/dev/c/src/a.ts', 1), '/wt/src/a.ts': local },
      '/dev/c',
      '/wt',
    );
    expect(out['/wt/src/a.ts']).toBe(local);
    expect(Object.keys(out)).toEqual(['/wt/src/a.ts']);
  });

  it('moves a key whose entry names a different path, or none, without inventing one', () => {
    const out = rebaseCoverageMap(
      { '/dev/c/src/a.ts': { path: 'other' }, '/dev/c/b.ts': {} },
      '/dev/c',
      '/wt',
    );
    expect(out).toEqual({ '/wt/src/a.ts': { path: 'other' }, '/wt/b.ts': {} });
  });

  it('rebases an entry path under the foreign root even when it differs from its key', () => {
    const out = rebaseCoverageMap(
      { '/dev/c/src/a.ts': { path: '/dev/c/src/b.ts' }, 'rel/z.ts': { path: '/dev/c/z.ts' } },
      '/dev/c',
      '/wt',
    );
    expect(out).toEqual({
      'rel/z.ts': { path: '/wt/z.ts' },
      '/wt/src/a.ts': { path: '/wt/src/b.ts' },
    });
  });

  it('rebases from a filesystem-root producer', () => {
    expect(Object.keys(rebaseCoverageMap({ '/src/a.ts': entry('/src/a.ts') }, '/', '/wt'))).toEqual(
      ['/wt/src/a.ts'],
    );
  });

  it('leaves the coverage gate totals exactly as they were', () => {
    const map = {
      '/dev/c/src/a.ts': entry('/dev/c/src/a.ts', 3),
      '/dev/c/b.ts': entry('/dev/c/b.ts', 0),
    };
    expect(computePercentages(rebaseCoverageMap(map, '/dev/c', '/wt'))).toEqual(
      computePercentages(map),
    );
  });
});

/** A git worktree with tracked src/a.ts, plus a producer checkout's coverage dir keyed under `producer`. */
function seed(producer: string, { space = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), space ? 'cov rebase-' : 'covrebase-')));
  dirs.push(base);
  const wt = join(base, 'wt');
  mkdirSync(join(wt, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, env: GIT_ENV });
  git('init', '-q');
  writeFileSync(join(wt, 'src/a.ts'), 'export const a = 1;\n');
  git('add', 'src/a.ts');
  const source = join(base, 'producer-coverage');
  mkdirSync(join(source, '.runs'), { recursive: true });
  const key = `${producer}/src/a.ts`;
  const report = JSON.stringify({ [key]: entry(key, 2) });
  writeFileSync(join(source, 'coverage-final.json'), report);
  writeFileSync(join(source, '.last-clear.json'), '{}');
  symlinkSync(source, join(wt, 'coverage'));
  return { wt, source, report };
}

const runCli = (...args: string[]) =>
  spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', env: GIT_ENV });

/** The private rekeyed copy's path for a seeded worktree (outside it, as ship's git dir is). */
const outFor = (wt: string) => join(wt, '..', 'fallow-coverage.json');

describe('rebaseWorktreeCoverage — a private rekeyed copy for fallow', () => {
  it('writes the rekeyed map to outFile and leaves the link and the source byte-exact', () => {
    const { wt, source, report } = seed('/Users/dev/checkout');
    const out = outFor(wt);

    expect(rebaseWorktreeCoverage(wt, source, out)).toEqual({ root: '/Users/dev/checkout' });

    const rebased = coverageMapSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(Object.keys(rebased)).toEqual([`${realpathSync(wt)}/src/a.ts`]);
    // The gate reads the link (sc-3225 provenance): it must stay the SAME file the manifest binds.
    expect(lstatSync(join(wt, 'coverage')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(wt, 'coverage'))).toBe(source);
    expect(readFileSync(join(source, 'coverage-final.json'), 'utf8')).toBe(report);
  });

  it('writes nothing when the keys already point at the worktree', () => {
    const { wt, source } = seed('');
    const key = `${realpathSync(wt)}/src/a.ts`;
    writeFileSync(join(source, 'coverage-final.json'), JSON.stringify({ [key]: entry(key) }));

    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toBeNull();
    expect(existsSync(outFor(wt))).toBe(false);
  });

  it('never overwrites an existing outFile (a stale copy must not be silently replaced)', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    writeFileSync(outFor(wt), '{}');

    expect(() => rebaseWorktreeCoverage(wt, source, outFor(wt))).toThrow(/EEXIST/);
    expect(readFileSync(outFor(wt), 'utf8')).toBe('{}');
  });

  it('writes negative hit counts as 0 and leaves the source artifact untouched', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    const key = '/Users/dev/checkout/src/a.ts';
    const artifact = { [key]: { ...entry(key, 5), s: { 0: -1 }, f: { 0: -1 }, b: { 2: [5, -1] } } };
    const report = JSON.stringify(artifact);
    writeFileSync(join(source, 'coverage-final.json'), report);

    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toEqual({ root: '/Users/dev/checkout' });

    const rebased = coverageMapSchema.parse(JSON.parse(readFileSync(outFor(wt), 'utf8')));
    expect(rebased[`${realpathSync(wt)}/src/a.ts`]).toMatchObject({
      s: { 0: 0 },
      f: { 0: 0 },
      b: { 2: [5, 0] },
    });
    expect(computePercentages(rebased)).toEqual(computePercentages(artifact));
    expect(readFileSync(join(source, 'coverage-final.json'), 'utf8')).toBe(report);
  });

  it('returns null when the source holds no report (the fail-closed gate then decides)', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    rmSync(join(source, 'coverage-final.json'));

    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toBeNull();
    expect(existsSync(outFor(wt))).toBe(false);
  });
});

/** Bind a coverage-run manifest recording `args` to the report currently in `source`. */
function bindManifest(source: string, args: string[]) {
  const report = join(source, 'coverage-final.json');
  const snapshot = { roots: [], head: '', dirty: {}, args };
  publishManifest(stageManifest(join(source, '.runs'), report, snapshot, 'run-1'), source);
}

describe('rebaseWorktreeCoverage — a scoped run hands fallow an empty map', () => {
  it('writes {} for a scoped run, even when the keys already sit at the worktree', () => {
    const { wt, source } = seed('');
    const key = `${realpathSync(wt)}/src/a.ts`;
    writeFileSync(join(source, 'coverage-final.json'), JSON.stringify({ [key]: entry(key, 0) }));
    bindManifest(source, ['src/a.test.ts']);

    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toEqual({
      scopedArgs: ['src/a.test.ts'],
    });
    expect(readFileSync(outFor(wt), 'utf8')).toBe('{}');
  });

  it('rekeys a full run exactly as before', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    bindManifest(source, []);

    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toEqual({ root: '/Users/dev/checkout' });
  });

  it("ignores a scoped manifest bound to other bytes (provenance unknown keeps today's copy)", () => {
    const { wt, source } = seed('/Users/dev/checkout');
    bindManifest(source, ['src/a.test.ts']);
    const key = '/Users/dev/checkout/src/a.ts';
    writeFileSync(join(source, 'coverage-final.json'), JSON.stringify({ [key]: entry(key, 3) }));

    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toEqual({ root: '/Users/dev/checkout' });
  });

  it('prints the scoped args on stdout for the ship script', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    bindManifest(source, ['src/a.test.ts', '-t', 'renders']);

    const r = runCli(wt, source, outFor(wt));

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('scoped src/a.test.ts -t renders\n');
  });
});

describe('coverage-rebase CLI — fail-open', () => {
  it('prints the foreign root on stdout and exits 0, through a path containing a space', () => {
    const { wt, source } = seed('/Users/dev/checkout', { space: true });

    const r = runCli(wt, source, outFor(wt));

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('/Users/dev/checkout\n');
    expect(existsSync(outFor(wt))).toBe(true);
  });

  it.each([
    ['malformed JSON', (s: string) => writeFileSync(join(s, 'coverage-final.json'), '{not json')],
    ['a non-object report', (s: string) => writeFileSync(join(s, 'coverage-final.json'), '[]')],
    [
      'a non-object entry',
      (s: string) =>
        writeFileSync(join(s, 'coverage-final.json'), '{"/Users/dev/checkout/src/a.ts":3}'),
    ],
    [
      'a fractional hit count fallow cannot read',
      (s: string) =>
        writeFileSync(
          join(s, 'coverage-final.json'),
          '{"/Users/dev/checkout/src/a.ts":{"s":{"0":1.5}}}',
        ),
    ],
  ])('writes nothing, says so and exits 0 on %s', (_label, corrupt) => {
    const { wt, source } = seed('/Users/dev/checkout');
    corrupt(source);

    const r = runCli(wt, source, outFor(wt));

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/coverage paths not rebased/);
    expect(existsSync(outFor(wt))).toBe(false);
  });

  it('writes nothing and exits 0 when the worktree is not a git checkout', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    rmSync(join(wt, '.git'), { recursive: true, force: true });

    const r = runCli(wt, source, outFor(wt));

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/coverage paths not rebased/);
    expect(existsSync(outFor(wt))).toBe(false);
  });

  it('exits 0 with a usage note when called without an out-file', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    const r = runCli(wt, source);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/usage: coverage-rebase/);
  });
});

// Pins the claim the helper rests on against the real binary: `fallow audit` (what the hook runs)
// joins measured coverage from FALLOW_COVERAGE, so the gate's own artifact never has to be rewritten.
const hasFallow = spawnSync('fallow', ['--version'], { encoding: 'utf8' }).status === 0;
const FALLOW_ENV = Object.fromEntries(
  Object.entries(GIT_ENV).filter(([name]) => !name.startsWith('FALLOW_')),
);

const CRAP_SRC =
  'export function f(a,b,c,d){ if(a){ if(b){ return 1 } else if(c){ return 2 } } else if(d){ return 3 } for(let i=0;i<a;i++){ if(i%2&&b||c&&d){ return 4 } } return a?b?5:6:c?7:8 }\n';

/** A seeded worktree staging a complex `f`, with a report keyed under `producer` (wt root when ''). */
function seedFallowCheckout(producer: string, hits: number, arms: number[]) {
  const { wt, source } = seed(producer);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, env: GIT_ENV });
  writeFileSync(join(wt, 'package.json'), '{"name":"x","version":"1.0.0","main":"src/a.js"}\n');
  writeFileSync(join(wt, 'src/a.js'), 'export const z = 1;\n');
  git('add', 'package.json', 'src/a.js');
  git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'base');
  writeFileSync(join(wt, 'src/a.js'), CRAP_SRC);
  git('add', 'src/a.js');
  const key = `${producer || realpathSync(wt)}/src/a.js`;
  const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 200 } };
  const decl = { start: { line: 1, column: 16 }, end: { line: 1, column: 17 } };
  writeFileSync(
    join(source, 'coverage-final.json'),
    JSON.stringify({
      [key]: {
        path: key,
        statementMap: { 0: loc },
        fnMap: { 0: { name: 'f', decl, loc, line: 1 } },
        branchMap: { 0: { type: 'if', loc: decl, locations: [decl, decl], line: 1 } },
        s: { 0: hits },
        f: { 0: hits },
        b: { 0: arms },
      },
    }),
  );
  const audit = (extra: Record<string, string>) =>
    spawnSync('fallow', ['audit', '--base', 'HEAD', '--no-cache', '--format', 'json'], {
      cwd: wt,
      encoding: 'utf8',
      env: { ...FALLOW_ENV, ...extra },
    }).stdout;
  return { wt, source, audit };
}

describe.skipIf(!hasFallow)('coverage-rebase against the real fallow binary', () => {
  // A negative count (from vitest's v8→istanbul conversion) makes fallow reject the whole file.
  it.each([
    ['clean counts', [5, 0]],
    ['a negative branch count', [5, -1]],
  ])(
    'turns an estimated CRAP finding into a measured one through FALLOW_COVERAGE (%s)',
    (_label, arms) => {
      const { wt, source, audit } = seedFallowCheckout('/other/checkout', 5, arms);

      const before = audit({});
      const out = outFor(wt);
      expect(rebaseWorktreeCoverage(wt, source, out)).toEqual({ root: '/other/checkout' });
      const after = audit({ FALLOW_COVERAGE: out });

      expect(before).toContain('"coverage_source":"estimated"');
      expect(after).not.toContain('"error":true');
      expect(after).not.toContain('"coverage_source":"estimated"');
      expect(after).not.toContain('cognitive_crap');
    },
  );

  // fallow reads <cwd>/coverage when FALLOW_COVERAGE is unset, so only the empty map stops the 0%.
  it("scores a scoped run's loaded-but-unrun function from estimates, not as measured 0%", () => {
    const { wt, source, audit } = seedFallowCheckout('', 0, [0, 0]);
    bindManifest(source, ['src/other.test.ts']);

    const discovered = audit({});
    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toEqual({
      scopedArgs: ['src/other.test.ts'],
    });
    const after = audit({ FALLOW_COVERAGE: outFor(wt) });

    expect(discovered).not.toContain('"coverage_source":"estimated"');
    expect(after).not.toContain('"error":true');
    expect(after).toContain('"coverage_source":"estimated"');
  });
});
