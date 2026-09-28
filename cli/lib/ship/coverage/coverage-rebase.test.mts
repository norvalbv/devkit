import { execFileSync, spawnSync } from 'node:child_process';
import {
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

describe('rebaseWorktreeCoverage — the linked coverage dir', () => {
  it('swaps the link for a real dir whose report joins the worktree, keeping every other entry linked', () => {
    const { wt, source, report } = seed('/Users/dev/checkout');

    expect(rebaseWorktreeCoverage(wt, source)).toBe('/Users/dev/checkout');

    const dest = join(wt, 'coverage');
    expect(lstatSync(dest).isDirectory()).toBe(true);
    const rebased = coverageMapSchema.parse(
      JSON.parse(readFileSync(join(dest, 'coverage-final.json'), 'utf8')),
    );
    expect(Object.keys(rebased)).toEqual([`${realpathSync(wt)}/src/a.ts`]);
    expect(readlinkSync(join(dest, '.last-clear.json'))).toBe(join(source, '.last-clear.json'));
    expect(readlinkSync(join(dest, '.runs'))).toBe(join(source, '.runs'));
    // The source is SHARED with the developer's checkout and sibling agents' coverage-run publishes:
    // it must never be written, only read.
    expect(readFileSync(join(source, 'coverage-final.json'), 'utf8')).toBe(report);
  });

  it('leaves the link alone when the keys already point at the worktree', () => {
    const { wt, source } = seed('');
    // Re-key under the worktree itself, as a plain commit in the producing checkout would.
    const key = `${realpathSync(wt)}/src/a.ts`;
    writeFileSync(join(source, 'coverage-final.json'), JSON.stringify({ [key]: entry(key) }));

    expect(rebaseWorktreeCoverage(wt, source)).toBeNull();
    expect(lstatSync(join(wt, 'coverage')).isSymbolicLink()).toBe(true);
  });

  it('refuses to replace a coverage dir ship did not link (a caller-owned real directory)', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    rmSync(join(wt, 'coverage'));
    mkdirSync(join(wt, 'coverage'));

    expect(() => rebaseWorktreeCoverage(wt, source)).toThrow(/not the link/);
    expect(lstatSync(join(wt, 'coverage')).isDirectory()).toBe(true);
  });

  it('returns null when the source holds no report (the fail-closed gate then decides)', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    rmSync(join(source, 'coverage-final.json'));

    expect(rebaseWorktreeCoverage(wt, source)).toBeNull();
    expect(lstatSync(join(wt, 'coverage')).isSymbolicLink()).toBe(true);
  });
});

describe('coverage-rebase CLI — fail-open', () => {
  it('prints the foreign root on stdout and exits 0, through a path containing a space', () => {
    const { wt, source } = seed('/Users/dev/checkout', { space: true });

    const r = runCli(wt, source);

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('/Users/dev/checkout\n');
  });

  it.each([
    ['malformed JSON', (s: string) => writeFileSync(join(s, 'coverage-final.json'), '{not json')],
    ['a non-object report', (s: string) => writeFileSync(join(s, 'coverage-final.json'), '[]')],
    [
      'a non-object entry',
      (s: string) =>
        writeFileSync(join(s, 'coverage-final.json'), '{"/Users/dev/checkout/src/a.ts":3}'),
    ],
  ])('keeps the link and exits 0 on %s', (_label, corrupt) => {
    const { wt, source } = seed('/Users/dev/checkout');
    corrupt(source);

    const r = runCli(wt, source);

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(lstatSync(join(wt, 'coverage')).isSymbolicLink()).toBe(true);
  });

  it('keeps the link and exits 0 when the worktree is not a git checkout', () => {
    const { wt, source } = seed('/Users/dev/checkout');
    rmSync(join(wt, '.git'), { recursive: true, force: true });

    const r = runCli(wt, source);

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/coverage paths not rebased/);
    expect(lstatSync(join(wt, 'coverage')).isSymbolicLink()).toBe(true);
  });

  it('exits 0 with a usage note when called without arguments', () => {
    const r = runCli();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/usage: coverage-rebase/);
  });
});

// Pins the claim the helper rests on against the real binary: rebased keys join fallow's coverage.
const hasFallow = spawnSync('fallow', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasFallow)('coverage-rebase against the real fallow binary', () => {
  it('turns an estimated CRAP finding into a measured, clean score', () => {
    const src =
      'export function f(a,b,c,d){ if(a){ if(b){ return 1 } else if(c){ return 2 } } else if(d){ return 3 } for(let i=0;i<a;i++){ if(i%2&&b||c&&d){ return 4 } } return a?b?5:6:c?7:8 }\n';
    const key = '/other/checkout/src/a.js';
    const { wt, source } = seed('/other/checkout');
    writeFileSync(join(wt, 'package.json'), '{"name":"x","version":"1.0.0","main":"src/a.js"}\n');
    writeFileSync(join(wt, 'src/a.js'), src);
    execFileSync('git', ['add', 'package.json', 'src/a.js'], { cwd: wt, env: GIT_ENV });
    const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 200 } };
    writeFileSync(
      join(source, 'coverage-final.json'),
      JSON.stringify({
        [key]: {
          path: key,
          statementMap: { 0: loc },
          fnMap: {
            0: {
              name: 'f',
              decl: { start: { line: 1, column: 16 }, end: { line: 1, column: 17 } },
              loc,
              line: 1,
            },
          },
          branchMap: {},
          s: { 0: 5 },
          f: { 0: 5 },
          b: {},
        },
      }),
    );
    const crapMax = () => {
      const r = spawnSync('fallow', ['health', '--no-cache', '--format', 'json'], {
        cwd: wt,
        encoding: 'utf8',
        env: GIT_ENV,
      });
      return Number(/"crap_max":([0-9.]+)/.exec(r.stdout)?.[1]);
    };

    const before = crapMax();
    expect(rebaseWorktreeCoverage(wt, source)).toBe('/other/checkout');
    const after = crapMax();

    expect(before).toBeGreaterThanOrEqual(30);
    expect(after).toBeLessThan(30);
  });
});
