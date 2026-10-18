/**
 * The staged fallow gate scores CRAP from the repo's coverage artifact, against the real fallow
 * binary: a commit gets the verdict `devkit ship` gets on the same tree and artifact.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { publishManifest, stageManifest } from '../../gate-engine/coverage/provenance.mts';
import { FALLOW_STAGED } from '../lib/husky/gate-policy/fallow-staged.mts';
import { rebaseWorktreeCoverage } from '../lib/ship/coverage/coverage-rebase.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import { runHookFragment } from './_husky-hook-harness.mts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const BASE_ENV = Object.fromEntries(
  Object.entries(GIT_ENV).filter(([name]) => !name.startsWith('FALLOW_')),
);
const hasFallow = spawnSync('fallow', ['--version'], { encoding: 'utf8' }).status === 0;
const SHELLS = ['sh', 'dash'].filter(
  (shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0,
);
const HINT = 'no measured coverage for this audit';
const BLOCKED = /30\.0 CRAP\s+\(0% tested\)/;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Unexported, cyclomatic 5, never called by a test: CRAP 30 once its 0% is measured. The test file
// importing a sibling export is what makes fallow's ESTIMATE pass it, so the artifact decides.
const MAIN = `export const z = 1;
function main(a, b, c, d) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  if (d) return 4;
  return 0;
}
main(z, 0, 0, 0);
`;
const span = (line: number, from: number, to: number) => ({
  start: { line, column: from },
  end: { line, column: to },
});

/** An istanbul map measuring `main` at 0 calls, with `stray` as its one untaken-branch count. */
function coverageOf(file: string, stray: number): string {
  return JSON.stringify({
    [file]: {
      path: file,
      statementMap: { 0: span(1, 0, 19), 1: span(3, 2, 18), 2: span(9, 0, 17) },
      fnMap: { 0: { name: 'main', decl: span(2, 9, 13), loc: span(2, 26, 30), line: 2 } },
      branchMap: {
        0: {
          type: 'if',
          loc: span(3, 2, 18),
          locations: [span(3, 2, 18), span(3, 2, 18)],
          line: 3,
        },
      },
      s: { 0: 1, 1: 0, 2: 1 },
      f: { 0: 0 },
      b: { 0: [0, stray] },
    },
  });
}

interface Fixture {
  top: string;
  /** Where the hook runs: the repo root, or the package dir of a monorepo. */
  cwd: string;
  report: string;
  bin: string;
  tmp: string;
}

/** A repo whose package (at `pkgRel`) stages `main`, with a guard-coverage shim on a private bin dir. */
function fixture(pkgRel: string, artifact?: (file: string) => string): Fixture {
  // Spaces in the repo and temp paths: real checkouts have them, and the hook must quote every one.
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'fallow staged cov-')));
  dirs.push(top);
  const cwd = join(top, pkgRel);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: top, env: GIT_ENV });
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(top, 'coverage'));
  writeFileSync(join(top, '.gitignore'), 'coverage\nbin\ntmp dir\n');
  writeFileSync(
    join(cwd, 'package.json'),
    '{"name":"x","version":"1.0.0","type":"module","main":"src/a.js","devDependencies":{"vitest":"^3.0.0"}}\n',
  );
  writeFileSync(join(cwd, 'src/a.js'), 'export const z = 1;\n');
  writeFileSync(
    join(cwd, 'src/a.test.js'),
    "import { test } from 'vitest';\nimport { z } from './a.js';\ntest('z', () => z);\n",
  );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'base');
  writeFileSync(join(cwd, 'src/a.js'), MAIN);
  git('add', '-A');
  const report = join(top, 'coverage/coverage-final.json');
  if (artifact) writeFileSync(report, artifact(join(cwd, 'src/a.js')));
  const bin = join(top, 'bin');
  const tmp = join(top, 'tmp dir');
  mkdirSync(bin);
  mkdirSync(tmp);
  writeFileSync(
    join(bin, 'guard-coverage'),
    `#!/bin/sh\necho called >>"${join(bin, 'calls')}"\nexec node "${join(REPO, 'gate-engine/coverage/run.mts')}" "$@"\n`,
    { mode: 0o755 },
  );
  return { top, cwd, report, bin, tmp };
}

/** Record `f`'s artifact as the output of `devkit coverage-run <args>`. */
function bindRun(f: Fixture, args: string[]) {
  const runDir = join(f.top, 'coverage/.runs');
  mkdirSync(runDir);
  const snapshot = { roots: [f.top], head: '', dirty: {}, args };
  publishManifest(stageManifest(runDir, f.report, snapshot, 'run-1'), join(f.top, 'coverage'));
}

/** Run the generated staged-gate block as a hook would, in `cwd`. */
function runGate(f: Fixture, cwd = f.cwd, env: Record<string, string> = {}, shell = 'sh') {
  const r = runHookFragment(FALLOW_STAGED, {
    cwd,
    shell,
    env: { ...BASE_ENV, TMPDIR: f.tmp, ...env },
    binOpen: `__dk_package_bin_dir="${f.bin}"`,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!hasFallow)('staged fallow gate — measured CRAP at commit', () => {
  // dash is /bin/sh on Debian and Ubuntu; macOS's sh is bash in POSIX mode.
  it.each(SHELLS)('blocks the function ship blocks, where fallow alone passes it (%s)', (shell) => {
    const f = fixture('', (file) => coverageOf(file, -1));
    const before = readFileSync(f.report, 'utf8');
    const diff = execFileSync('git', ['diff', '--cached'], { cwd: f.top, env: GIT_ENV });
    const unaided = spawnSync('fallow', ['audit', '--diff-stdin', '--no-cache'], {
      cwd: f.cwd,
      encoding: 'utf8',
      input: diff,
      env: BASE_ENV,
    });

    const gate = runGate(f, f.cwd, {}, shell);

    expect(unaided.status).toBe(0);
    expect(gate.status).toBe(1);
    expect(gate.out).toMatch(BLOCKED);
    expect(gate.out).toContain('CRAP scores use Istanbul coverage');
    expect(readFileSync(f.report, 'utf8')).toBe(before);
    expect(readdirSync(f.tmp).filter((name) => name.startsWith('devkit-fallow-coverage'))).toEqual(
      [],
    );
  });

  it("reaches the same verdict in a ship worktree, through ship's own rekeyed copy", () => {
    const f = fixture('', (file) => coverageOf(file, -1));
    const wt = join(f.tmp, 'ship-wt');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: f.top, env: GIT_ENV });
    writeFileSync(join(wt, 'src/a.js'), MAIN);
    execFileSync('git', ['add', '-A'], { cwd: wt, env: GIT_ENV });
    const rekeyed = join(f.top, 'rekeyed.json');
    expect(rebaseWorktreeCoverage(wt, join(f.top, 'coverage'), rekeyed)).toEqual({ root: f.top });

    const ship = runGate(f, wt, { FALLOW_COVERAGE: rekeyed });

    expect(ship.status).toBe(1);
    expect(ship.out).toMatch(BLOCKED);
    expect(readdirSync(f.bin)).toEqual(['guard-coverage']);
  });

  it('reads the root artifact from a monorepo package dir, where fallow would not look', () => {
    const f = fixture('packages/app', (file) => coverageOf(file, 0));

    const gate = runGate(f);

    expect(gate.status).toBe(1);
    expect(gate.out).toMatch(BLOCKED);
  });

  it('still audits, and says CRAP is estimated, when the artifact cannot be read', () => {
    const f = fixture('', () => '{"/x/a.js":{"s":{"0":"many"}}}');

    const gate = runGate(f);

    expect(gate.status).toBe(0);
    expect(gate.out).toContain(HINT);
    expect(gate.out).toContain('No issues in 1 changed file');
  });

  it('says nothing about coverage in a repo that has no artifact', () => {
    const f = fixture('');

    const gate = runGate(f);

    expect(gate.status).toBe(0);
    expect(gate.out).not.toContain(HINT);
  });
});

describe.skipIf(!hasFallow)('staged fallow gate — a scoped coverage-run', () => {
  const SCOPED =
    'the coverage artifact came from a scoped run (`devkit coverage-run src/a.test.js`)';

  it('blocks on the measured 0% of a function the run loaded but never called', () => {
    const f = fixture('', (file) => coverageOf(file, 0));

    const gate = runGate(f);

    expect(gate.status).toBe(1);
    expect(gate.out).toMatch(BLOCKED);
  });

  it('scores that function from the estimate once the artifact is known to be scoped', () => {
    const f = fixture('', (file) => coverageOf(file, 0));
    bindRun(f, ['src/a.test.js']);

    const gate = runGate(f);

    // Exit 0 alone would also be fallow failing on a bad FALLOW_COVERAGE: it must have audited.
    expect(gate.status).toBe(0);
    expect(gate.out).toContain('No issues in 1 changed file');
    expect(gate.out).toContain(SCOPED);
    expect(readdirSync(f.tmp).filter((name) => name.startsWith('devkit-fallow-coverage'))).toEqual(
      [],
    );
  });

  it("leaves an operator's FALLOW_COVERAGE in place", () => {
    const f = fixture('', (file) => coverageOf(file, 0));
    bindRun(f, ['src/a.test.js']);
    const operator = join(f.tmp, 'operator.json');
    writeFileSync(operator, readFileSync(f.report));

    const gate = runGate(f, f.cwd, { FALLOW_COVERAGE: operator });

    expect(gate.status).toBe(1);
    expect(gate.out).toMatch(BLOCKED);
    expect(readdirSync(f.bin)).toEqual(['guard-coverage']);
  });

  it('gives ship the verdict the commit got, through the rekey', () => {
    const f = fixture('', (file) => coverageOf(file, 0));
    bindRun(f, ['src/a.test.js']);
    const wt = join(f.tmp, 'ship-wt');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: f.top, env: GIT_ENV });
    writeFileSync(join(wt, 'src/a.js'), MAIN);
    execFileSync('git', ['add', '-A'], { cwd: wt, env: GIT_ENV });
    const rekeyed = join(f.top, 'rekeyed.json');
    expect(rebaseWorktreeCoverage(wt, join(f.top, 'coverage'), rekeyed)).toEqual({
      scopedArgs: ['src/a.test.js'],
    });

    const ship = runGate(f, wt, { FALLOW_COVERAGE: rekeyed });

    expect(ship.status).toBe(0);
    expect(ship.out).toContain('No issues in 1 changed file');
  });
});
