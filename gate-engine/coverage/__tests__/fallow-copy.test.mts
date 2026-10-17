/** The coverage copy the staged fallow gate hands fallow (gate-engine/coverage/fallow-copy.mts). */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveForeignRoot, rebaseCoverageMap, writeFallowCopy } from '../fallow-copy.mts';
import { computePercentages } from '../run.mts';
import { entry } from './_provenance-fixtures.mts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

/** A git repo whose coverage/coverage-final.json holds `body`; `track` adds `src/a.ts`. */
function seed(body?: string, { track = false } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'fallow-copy-')));
  dirs.push(top);
  const pkg = join(top, 'packages/app');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(top, 'src'));
  writeFileSync(join(top, 'src/a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: top, env: GIT_ENV });
  if (track) execFileSync('git', ['add', 'src/a.ts'], { cwd: top, env: GIT_ENV });
  mkdirSync(join(top, 'coverage'));
  const report = join(top, 'coverage/coverage-final.json');
  if (body !== undefined) writeFileSync(report, body);
  return { top, pkg, report };
}

const map = (branchHits: number) =>
  JSON.stringify({
    '/repo/src/a.ts': {
      path: '/repo/src/a.ts',
      fnMap: { 0: { name: 'f' } },
      s: { 0: 3 },
      f: { 0: 0 },
      b: { 0: [2, branchHits] },
    },
  });

/** The text of a written copy, which is removed with the fixtures. */
function readCopy(out: string | null): string {
  if (out === null) throw new Error('no copy was written');
  dirs.push(out);
  return readFileSync(out, 'utf8');
}

describe('writeFallowCopy', () => {
  it('clamps a negative hit to 0 and keeps every other field and the artifact itself', () => {
    const { top, report } = seed(map(-1));

    const copy = readCopy(writeFallowCopy(top, top));

    expect(JSON.parse(copy)).toEqual(JSON.parse(map(0)));
    expect(readFileSync(report, 'utf8')).toBe(map(-1));
  });

  // A missed field means no copy at the root, and fallow silently drops the artifact it found.
  it.each([
    ['s', { s: { 0: -1 } }],
    ['f', { f: { 0: -2 } }],
    ['b', { b: { 0: [3, -1] } }],
  ])('copies at the root when only %s holds a negative count', (_field, hits) => {
    const { top } = seed(JSON.stringify({ '/repo/a.ts': { s: { 0: 1 }, f: { 0: 1 }, ...hits } }));
    expect(JSON.stringify(JSON.parse(readCopy(writeFallowCopy(top, top))))).not.toContain('-');
  });

  it('writes nothing when fallow reads the artifact unaided: clean counts, run at the root', () => {
    const { top } = seed(map(4));
    expect(writeFallowCopy(top, top)).toBeNull();
  });

  it('writes a clean map too when fallow runs in a package dir, where it would not look', () => {
    const { top, pkg } = seed(map(4));
    expect(JSON.parse(readCopy(writeFallowCopy(top, pkg)))).toEqual(JSON.parse(map(4)));
  });

  it('moves keys produced in another checkout onto this one and keeps the artifact', () => {
    const { top, report } = seed(map(4), { track: true });

    const copy = readCopy(writeFallowCopy(top, top));

    expect(JSON.parse(copy)).toEqual(JSON.parse(map(4).replaceAll('/repo', top)));
    expect(readFileSync(report, 'utf8')).toBe(map(4));
  });

  // A worktree nested in a checkout (e.g. .claude/worktrees/x) shares that checkout's path prefix.
  it.each([
    ['a worktree nested inside this checkout', (top: string) => join(top, '.claude/worktrees/x')],
    ['the checkout this one is nested in', (top: string) => dirname(top)],
  ])('moves keys produced in %s', (_label, producer) => {
    const { top, report } = seed(undefined, { track: true });
    writeFileSync(report, map(4).replaceAll('/repo', producer(top)));

    const copy = readCopy(writeFallowCopy(top, top));

    expect(JSON.parse(copy)).toEqual(JSON.parse(map(4).replaceAll('/repo', top)));
  });

  it('writes nothing when the keys already sit in this checkout', () => {
    const { top, report } = seed(undefined, { track: true });
    writeFileSync(report, map(4).replaceAll('/repo', top));
    expect(writeFallowCopy(top, top)).toBeNull();
  });

  it('writes nothing when the keys name this checkout through a symlinked path', () => {
    const { top, report } = seed(undefined, { track: true });
    const alias = join(realpathSync(tmpdir()), `fallow-copy-alias-${process.pid}`);
    symlinkSync(top, alias);
    dirs.push(alias);
    writeFileSync(report, map(4).replaceAll('/repo', alias));
    expect(writeFallowCopy(top, top)).toBeNull();
  });

  it('writes nothing when there is no artifact', () => {
    const { top, pkg } = seed();
    expect(writeFallowCopy(top, pkg)).toBeNull();
  });

  it('gives each call its own file, so concurrent commits never share one', () => {
    const { top } = seed(map(-1));
    const [a, b] = [writeFallowCopy(top, top), writeFallowCopy(top, top)];
    readCopy(a);
    readCopy(b);
    expect(a).not.toBe(b);
  });

  it.each([
    ['a non-integer hit', '{"/repo/a.ts":{"s":{"0":"x"}}}'],
    ['a map that is not an object', '[]'],
  ])('throws on %s rather than hand fallow counts it cannot read', (_label, body) => {
    const { top } = seed(body);
    expect(() => writeFallowCopy(top, top)).toThrow(/coverage-final\.json/);
  });
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
