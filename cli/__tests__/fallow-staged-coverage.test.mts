/**
 * The staged fallow gate scores CRAP from the repo's coverage artifact, against the real fallow
 * binary: a commit gets the verdict `devkit ship` gets on the same tree and artifact. It also blocks
 * introduced duplication, which fallow rates `warn` and exits 0 on.
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
    expect(rebaseWorktreeCoverage(wt, join(f.top, 'coverage'), rekeyed)).toBe(f.top);

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
    expect(gate.out).toContain('fallow passed the staged diff');
  });

  it('says nothing about coverage in a repo that has no artifact', () => {
    const f = fixture('');

    const gate = runGate(f);

    expect(gate.status).toBe(0);
    expect(gate.out).not.toContain(HINT);
  });
});

const DUPLICATION = 'the staged diff introduces duplication';
// Long enough to clear fallow's default clone floor (50 tokens, 5 lines).
const body = (name: string) => `export function ${name}(x) {
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > 10) { total += x[i] * 2; } else { total -= x[i]; }
    if (total > 1000) { total = total / 3; }
    console.log('step', i, total, x[i]);
  }
  return total;
}
`;

/** A committed `a.js`, then `files` staged on top; no coverage artifact and no guard-coverage. */
function stagedRepo(files: Record<string, string>): Fixture {
  const [top, bin, tmp] = ['fallow-dup-', 'fallow-dup-bin-', 'fallow-dup-tmp-'].map((prefix) =>
    realpathSync(mkdtempSync(join(tmpdir(), prefix))),
  );
  dirs.push(top, bin, tmp);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: top, env: GIT_ENV });
  writeFileSync(join(top, 'package.json'), '{"name":"x","version":"1.0.0","type":"module"}\n');
  // Every file is an entry, so an unused file or export can never be what blocks.
  writeFileSync(join(top, '.fallowrc.json'), '{"entry":["*.js"]}\n');
  writeFileSync(join(top, 'a.js'), body('a'));
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'base');
  for (const [file, text] of Object.entries(files)) writeFileSync(join(top, file), text);
  git('add', '-A');
  return { top, cwd: top, report: '', bin, tmp };
}

describe.skipIf(!hasFallow)('staged fallow gate — introduced duplication', () => {
  it('blocks a duplication-only staged set that fallow alone lets through', () => {
    const f = stagedRepo({ 'c.js': body('c') });
    const diff = execFileSync('git', ['diff', '--cached'], { cwd: f.top, env: GIT_ENV });
    const unaided = spawnSync('fallow', ['audit', '--diff-stdin'], {
      cwd: f.cwd,
      encoding: 'utf8',
      input: diff,
      env: BASE_ENV,
    });

    const gate = runGate(f);

    expect(unaided.status).toBe(0);
    expect(gate.status).toBe(1);
    expect(gate.out).toContain(DUPLICATION);
    expect(gate.out).toContain('c.js');
  });

  it('lets an intended copy through once it carries the suppression the block line names', () => {
    const gate = runGate(
      stagedRepo({ 'c.js': `// fallow-ignore-next-line code-duplication\n${body('c')}` }),
    );
    expect(gate.out).not.toContain(DUPLICATION);
    expect(gate.status).toBe(0);
  });

  it('lets a staged set with no new clone through', () => {
    const gate = runGate(stagedRepo({ 'b.js': 'export const b = () => 1;\n' }));
    expect(gate.out).not.toContain(DUPLICATION);
    expect(gate.status).toBe(0);
  });
});
