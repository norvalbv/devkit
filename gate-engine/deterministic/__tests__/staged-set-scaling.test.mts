// Counts the git processes each deterministic gate starts (trace2 "start" events) at two staged-set
// sizes. Blind to in-process O(N) work, such as one `cat-file --batch` lexing every blob.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync } from '../../../cli/__tests__/_helpers.mts';
import { DETERMINISTIC } from '../registry.mts';

const SMALL = 10;
const BIG = 50;
const EXCLUDED = new Map([
  ['dup', 'exits 2 without a .search-code index'],
  ['coverage', 'needs a coverage run to measure'],
  ['anti-slop', 'exits 2 until `devkit init --anti-slop` installs its lint config and baseline'],
  [
    'decision-checks',
    'runs only the Checks linked to decision Targets, which a fixture has none of',
  ],
]);
const MEASURED = DETERMINISTIC.filter((gate) => !EXCLUDED.has(gate.id));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// The line caps `devkit init` enables: at their default of 0 the size gate skips its line ratchet.
const GUARD_CONFIG = { scanRoots: ['src'], maxLines: 500, maxTestLines: 2000 };

// Folders stay under the default fan-out cap, so no gate fails on the fixture's own layout.
const PER_FOLDER = 10;

function writeFiles(root: string, dir: string, n: number, revision: number): void {
  for (let i = 0; i < n; i++) {
    const folder = join(root, dir, `d${Math.floor(i / PER_FOLDER)}`);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `f${i}.${dir === 'dist' ? 'js' : 'ts'}`);
    writeFileSync(file, `// generated helper ${i}\nexport const g${i} = ${revision};\n`);
  }
}

function rewrite(dir: string) {
  return (root: string, n: number): void => {
    writeFiles(root, dir, n, 1);
    git(root, ['add', '-A']);
  };
}

/** Where each staged change keeps its files, and how it stages them over the base commit. */
const CHANGES = {
  'delete-out-of-scope': { dir: 'dist', stage: (root: string) => git(root, ['rm', '-rq', 'dist']) },
  'rename-out-of-scope': { dir: 'dist', stage: (root: string) => git(root, ['mv', 'dist', 'gen']) },
  'modify-out-of-scope': { dir: 'dist', stage: rewrite('dist') },
  'rename-in-scope': {
    dir: 'src/old',
    stage: (root: string) => git(root, ['mv', 'src/old', 'src/new']),
  },
  'codemod-in-scope': { dir: 'src/lib', stage: rewrite('src/lib') },
};
type StagedChange = keyof typeof CHANGES;

/** A governed repo scanning `src/`, with `change` applied to `n` files and staged. */
function stagedRepo(change: StagedChange, n: number): string {
  const root = tmp('staged-scaling-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'scaling@example.test']);
  git(root, ['config', 'user.name', 'Scaling Test']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'guard.config.json'), `${JSON.stringify(GUARD_CONFIG)}\n`);
  writeFileSync(join(root, 'src', 'index.ts'), 'export const index = 1;\n');
  writeFiles(root, CHANGES[change].dir, n, 0);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  CHANGES[change].stage(root, n);
  return root;
}

function gitStarts(root: string, gate: (typeof DETERMINISTIC)[number]): number {
  const trace = join(tmp('staged-scaling-trace-'), 'trace2.json');
  const module = fileURLToPath(
    new URL(gate.module.replace(/\.mjs$/, '.mts'), new URL('../', import.meta.url)),
  );
  const run = testSpawnSync(process.execPath, [module, ...gate.args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  expect(run.status, `${gate.id} must pass the clean fixture: ${run.stderr}`).toBe(0);
  const starts = (existsSync(trace) ? readFileSync(trace, 'utf8') : '')
    .split('\n')
    .filter((line) => line.includes('"event":"start"')).length;
  expect(starts, `${gate.id} recorded no git process, so its count proves nothing`).toBeGreaterThan(
    0,
  );
  return starts;
}

function slopes(change: StagedChange): Record<string, number> {
  const small = stagedRepo(change, SMALL);
  const big = stagedRepo(change, BIG);
  return Object.fromEntries(
    MEASURED.map((gate) => [
      gate.id,
      (gitStarts(big, gate) - gitStarts(small, gate)) / (BIG - SMALL),
    ]),
  );
}

describe('deterministic gate cost against the staged-set size', () => {
  it('names a reason for every registry gate it does not measure', () => {
    expect(MEASURED.map((gate) => gate.id)).toEqual(['size', 'fanout', 'clone', 'comments']);
    for (const id of EXCLUDED.keys()) expect(DETERMINISTIC.map((gate) => gate.id)).toContain(id);
  });

  it.each([
    'delete-out-of-scope',
    'rename-out-of-scope',
    'modify-out-of-scope',
    'rename-in-scope',
    'codemod-in-scope',
  ] as const)('starts no git process per staged file (%s)', (change) => {
    expect(slopes(change)).toEqual(Object.fromEntries(MEASURED.map((gate) => [gate.id, 0])));
  });
});
