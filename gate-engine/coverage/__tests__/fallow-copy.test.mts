/** The clamped coverage copy the staged fallow gate hands fallow (gate-engine/coverage/fallow-copy.mts). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type FallowCopy, writeFallowCopy } from '../fallow-copy.mts';
import { publishManifest, stageManifest } from '../provenance.mts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repo root holding `coverage/coverage-final.json` with the given body, plus a package dir. */
function seed(body?: string) {
  const top = mkdtempSync(join(tmpdir(), 'fallow-copy-'));
  dirs.push(top);
  const pkg = join(top, 'packages/app');
  mkdirSync(pkg, { recursive: true });
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
  if (out === null) throw new Error('no copy was written');
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
