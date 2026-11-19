/** The coverage copy the staged fallow gate hands fallow (gate-engine/coverage/fallow-copy.mts). */
import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  coverageMapSchema,
  deriveForeignRoot,
  type FallowCopy,
  rebaseCoverageMap,
  staleNotice,
  writeFallowCopy,
} from '../fallow-copy.mts';
import { publishManifest, snapshotSource, stageManifest } from '../provenance.mts';
import { computePercentages } from '../run.mts';
import {
  cleanupRepos,
  entry,
  git,
  measure,
  repo,
  stage,
  trackRoot,
  write,
} from './_provenance-fixtures.mts';

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
function readCopy(out: FallowCopy | null): string {
  if (!out?.path) throw new Error('no copy was written');
  dirs.push(out.path);
  return readFileSync(out.path, 'utf8');
}

/** Bind a `devkit coverage-run` manifest recording `args` to the report in `coverageDir`. */
function bindManifest(coverageDir: string, args: string[]) {
  const snapshot = { roots: [], head: '', dirty: {}, args };
  const runDir = join(coverageDir, '.runs');
  mkdirSync(runDir, { recursive: true });
  const report = join(coverageDir, 'coverage-final.json');
  publishManifest(stageManifest(runDir, report, snapshot, 'run-1'), coverageDir);
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
    expect(a?.path).not.toBe(b?.path);
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

describe('writeFallowCopy — a scoped coverage-run', () => {
  // Loaded-but-unrun files read as measured 0%; `{}` makes fallow estimate them instead.
  it('hands fallow an empty map, even where it would read the artifact unaided', () => {
    const { top } = seed(map(4));
    bindManifest(join(top, 'coverage'), ['src/a.test.ts']);

    const copy = writeFallowCopy(top, top);

    expect(copy?.scopedArgs).toEqual(['src/a.test.ts']);
    expect(readCopy(copy)).toBe('{}');
  });

  it("checks the package's own artifact when the repo root has none", () => {
    const { top, pkg } = seed();
    mkdirSync(join(pkg, 'coverage'));
    writeFileSync(join(pkg, 'coverage/coverage-final.json'), map(4));
    expect(writeFallowCopy(top, pkg)).toBeNull();

    bindManifest(join(pkg, 'coverage'), ['-t', 'one test']);

    expect(readCopy(writeFallowCopy(top, pkg))).toBe('{}');
  });

  it('keeps the measured map for a full run', () => {
    const { top } = seed(map(4));
    bindManifest(join(top, 'coverage'), ['--reporter=dot']);
    expect(writeFallowCopy(top, top)).toBeNull();
  });

  it('keeps the measured map when the manifest describes other bytes', () => {
    const { top, report } = seed(map(4));
    bindManifest(join(top, 'coverage'), ['src/a.test.ts']);
    writeFileSync(report, map(-1));

    expect(JSON.parse(readCopy(writeFallowCopy(top, top)))).toEqual(JSON.parse(map(0)));
  });
});

/** A committed repo with src/a.mts and src/b.mts, measured by a full run keyed under its top. */
function measured(snapshotArgs: string[] = []) {
  const { root } = repo();
  write(root, 'src/b.mts', 'export const b = 1;\n');
  stage(root);
  git(root, 'commit', '-q', '-m', 'b');
  const top = git(root, 'rev-parse', '--show-toplevel');
  const [a, b] = [`${top}/src/a.mts`, `${top}/src/b.mts`];
  measure(
    root,
    snapshotSource(root, snapshotArgs),
    JSON.stringify({ [a]: entry(a), [b]: entry(b) }),
  );
  return { root, top, a, b };
}

const keysOf = (copy: FallowCopy | null) =>
  Object.keys(coverageMapSchema.parse(JSON.parse(readCopy(copy))));

describe('writeFallowCopy — a full run the briefed edits postdate', () => {
  afterEach(cleanupRepos);

  it("drops a staged edit's key so fallow estimates that file alone, even where it read unaided", () => {
    const { root, top, b } = measured();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    stage(root);

    const copy = writeFallowCopy(top, root);

    expect(keysOf(copy)).toEqual([b]);
    expect(copy?.stale).toEqual({ files: ['src/a.mts'], keys: [`${top}/src/a.mts`], tests: [] });
  });

  it('counts a comment-only edit as stale: it still moves the lines fallow joins on', () => {
    const { root, top, b } = measured();
    write(root, 'src/a.mts', '// header\nexport const a = 1;\n');
    stage(root);
    expect(keysOf(writeFallowCopy(top, root))).toEqual([b]);
  });

  it('never names a measured file the commit deletes: fallow scores nothing for it', () => {
    const { root, top } = measured();
    git(root, 'rm', '-q', 'src/b.mts');
    write(root, 'src/a.mts', 'export const a = 2;\n');
    stage(root);
    expect(writeFallowCopy(top, root)?.stale?.files).toEqual(['src/a.mts']);
  });

  it('reports nothing stale when the only stale file is the one the commit deletes', () => {
    const { root, top } = measured();
    git(root, 'rm', '-q', 'src/b.mts');
    expect(writeFallowCopy(top, root)).toBeNull();
  });

  // git reads `[id]` as a glob unless pathspecs are literal; the file must still match itself.
  it('names a bracketed file (a dynamic-route name) the run predates', () => {
    const { root } = repo();
    write(root, 'src/[id].mts', 'export const id = 1;\n');
    stage(root);
    git(root, 'commit', '-q', '-m', 'route');
    const top = git(root, 'rev-parse', '--show-toplevel');
    const key = `${top}/src/[id].mts`;
    measure(root, snapshotSource(root), JSON.stringify({ [key]: entry(key) }));
    write(root, 'src/[id].mts', 'export const id = 2;\n');
    stage(root);

    expect(writeFallowCopy(top, root)?.stale?.files).toEqual(['src/[id].mts']);
  });

  it('writes nothing for a fresh artifact', () => {
    const { root, top } = measured();
    expect(writeFallowCopy(top, root)).toBeNull();
  });

  it('keeps the map and only warns when the run predates a test edit', () => {
    const { root, top } = measured();
    write(root, 'src/a.test.mts', 'test("a2", () => {});\n');
    stage(root);

    const copy = writeFallowCopy(top, root);

    expect(copy).toEqual({ stale: { files: [], keys: [], tests: ['src/a.test.mts'] } });
    expect(staleNotice(copy?.stale ?? { files: [], keys: [], tests: [] })).toBe(
      'the coverage run predates edits to src/a.test.mts, so measured CRAP may be off',
    );
  });

  it('still hands a scoped run {}, stale or not', () => {
    const { root, top } = measured(['src/a.test.mts']);
    write(root, 'src/a.mts', 'export const a = 2;\n');
    stage(root);
    const copy = writeFallowCopy(top, root);
    expect(copy?.scopedArgs).toEqual(['src/a.test.mts']);
    expect(readCopy(copy)).toBe('{}');
  });

  it("drops the stale key before moving another checkout's keys onto this one", () => {
    const { root, top } = measured();
    const wt = join(trackRoot(realpathSync(mkdtempSync(join(tmpdir(), 'fallow-copy-wt-')))), 'wt');
    git(root, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    symlinkSync(join(root, 'coverage'), join(wt, 'coverage'));
    write(wt, 'src/a.mts', 'export const a = 2;\n');
    stage(wt);

    const copy = writeFallowCopy(wt, wt);

    expect(keysOf(copy)).toEqual([`${wt}/src/b.mts`]);
    expect(copy?.stale?.keys).toEqual([`${top}/src/a.mts`]);
  });

  // fallow reads a package's own coverage/ unaided, so a copy was never written there before.
  it("prunes a package dir's own artifact, which fallow would otherwise read stale", () => {
    const { root, cwd } = repo('pkg');
    write(cwd, 'src/b.mts', 'export const b = 1;\n');
    stage(root);
    git(root, 'commit', '-q', '-m', 'b');
    const top = git(root, 'rev-parse', '--show-toplevel');
    const [a, b] = [`${top}/pkg/src/a.mts`, `${top}/pkg/src/b.mts`];
    measure(cwd, snapshotSource(cwd), JSON.stringify({ [a]: entry(a), [b]: entry(b) }));
    write(cwd, 'src/a.mts', 'export const a = 2;\n');
    stage(root);

    const copy = writeFallowCopy(top, cwd);

    expect(keysOf(copy)).toEqual([b]);
    expect(copy?.stale?.files).toEqual(['pkg/src/a.mts']);
  });

  it('guard-coverage fallow-copy prints the copy on stdout and the stale files on stderr', () => {
    const { root } = measured();
    write(root, 'src/a.mts', 'export const a = 2;\n');
    stage(root);
    const cli = fileURLToPath(new URL('../run.mts', import.meta.url));

    const r = spawnSync(process.execPath, [cli, 'fallow-copy'], { cwd: root, encoding: 'utf8' });

    expect(r.status, r.stderr).toBe(0);
    dirs.push(r.stdout.trim());
    expect(
      Object.keys(coverageMapSchema.parse(JSON.parse(readFileSync(r.stdout.trim(), 'utf8')))),
    ).toHaveLength(1);
    expect(r.stderr).toContain(
      'devkit fallow gate: fallow scores CRAP for 1 file(s) from static estimates — coverage predates their edits: src/a.mts; re-measure with a full `devkit coverage-run`',
    );
  });
});

describe('staleNotice', () => {
  it('names the estimated files, then the test edits, on one line', () => {
    expect(staleNotice({ files: ['a.mts', 'b.mts'], keys: [], tests: ['a.test.mts'] })).toBe(
      'fallow scores CRAP for 2 file(s) from static estimates — coverage predates their edits: a.mts, b.mts; re-measure with a full `devkit coverage-run` · the coverage run predates edits to a.test.mts, so measured CRAP may be off',
    );
  });
});
