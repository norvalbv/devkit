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
import { computePercentages } from '../../../../gate-engine/coverage/run.mts';
import { coverageMapSchema } from '../../../../gate-engine/coverage/fallow-copy.mts';
import { rebaseWorktreeCoverage } from './coverage-rebase.mts';

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

    expect(rebaseWorktreeCoverage(wt, source, out)).toBe('/Users/dev/checkout');

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

    expect(rebaseWorktreeCoverage(wt, source, outFor(wt))).toBe('/Users/dev/checkout');

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

describe.skipIf(!hasFallow)('coverage-rebase against the real fallow binary', () => {
  // A negative count (from vitest's v8→istanbul conversion) makes fallow reject the whole file.
  it.each([
    ['clean counts', [5, 0]],
    ['a negative branch count', [5, -1]],
  ])(
    'turns an estimated CRAP finding into a measured one through FALLOW_COVERAGE (%s)',
    (_label, arms) => {
      const src =
        'export function f(a,b,c,d){ if(a){ if(b){ return 1 } else if(c){ return 2 } } else if(d){ return 3 } for(let i=0;i<a;i++){ if(i%2&&b||c&&d){ return 4 } } return a?b?5:6:c?7:8 }\n';
      const key = '/other/checkout/src/a.js';
      const { wt, source } = seed('/other/checkout');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, env: GIT_ENV });
      writeFileSync(join(wt, 'package.json'), '{"name":"x","version":"1.0.0","main":"src/a.js"}\n');
      writeFileSync(join(wt, 'src/a.js'), 'export const z = 1;\n');
      git('add', 'package.json', 'src/a.js');
      git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'base');
      writeFileSync(join(wt, 'src/a.js'), src);
      git('add', 'src/a.js');
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
            s: { 0: 5 },
            f: { 0: 5 },
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

      const before = audit({});
      const out = outFor(wt);
      expect(rebaseWorktreeCoverage(wt, source, out)).toBe('/other/checkout');
      const after = audit({ FALLOW_COVERAGE: out });

      expect(before).toContain('"coverage_source":"estimated"');
      expect(after).not.toContain('"error":true');
      expect(after).not.toContain('"coverage_source":"estimated"');
      expect(after).not.toContain('cognitive_crap');
    },
  );
});
