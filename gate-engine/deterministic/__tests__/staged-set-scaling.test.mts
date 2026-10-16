// Counts the git processes each deterministic gate starts (trace2 "start" events) at two staged-set
// sizes. Blind to in-process O(N) work (`cat-file --batch`, dup's pair sweep) and to oxlint input.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI, testSpawnSync } from '../../../cli/__tests__/_helpers.mts';
import { linkCheck } from '../../decisions/ruling-checks/enforce.mts';
import { DETERMINISTIC } from '../registry.mts';

const SMALL = 10;
const BIG = 50;
const EXCLUDED = new Map([
  [
    'coverage',
    "needs a `devkit coverage-run` artifact whose provenance matches each fixture's staged tree",
  ],
]);
// Git spawns per in-scope staged file today. Lower one when a gate gets cheaper; never raise it.
const IN_SCOPE_SLOPE = {
  'rename-in-scope': new Map([['size', 2]]),
  'codemod-in-scope': new Map([
    ['size', 2],
    ['comments', 6],
  ]),
};
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

function devkit(root: string, args: string[]): void {
  const run = testSpawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
  expect(run.status, `devkit ${args.join(' ')}: ${run.stderr}`).toBe(0);
}

/** A repo adopted the way a consumer adopts devkit, with anti-slop and one linked decision Check. */
async function adoptedRepo(root: string): Promise<void> {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'scaling@example.test']);
  git(root, ['config', 'user.name', 'Scaling Test']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const index = 1;\n');
  devkit(root, ['init', '--stack', 'generic', '--yes', '--anti-slop']);
  // At a line cap of 0 the size gate skips its ratchet, and its slope pin would still pass.
  expect(JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'))).toMatchObject({
    scanRoots: ['src'],
    maxLines: 500,
    maxTestLines: 2000,
  });
  devkit(root, ['anti-slop', 'create']);
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'decisions', 'demo.md'),
    '---\nslug: demo\ncreated: 2026-10-01\n---\n\n# demo\n\n## Target · 2026-10-01 — demo\n\n**Ruling:** Keep src passing.\n**Scope:** src/**\n',
  );
  expect(await linkCheck('demo', 'node -e 0', 'puts decision-checks on its due path', root)).toBe(
    0,
  );
}

/** One indexed chunk: enough for dup to run, too few to pair. */
function dupIndex(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
  );
  const emb = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?)').run(
    'src/index.ts',
    'index',
    1,
    1,
    'INDEX_HASH',
    emb,
    emb,
  );
  db.close();
}

let shared = '';
const template = () => join(shared, 'repo');
const searchCodeDb = () => join(shared, 'index.db');
beforeAll(async () => {
  shared = mkdtempSync(join(tmpdir(), 'staged-scaling-template-'));
  mkdirSync(template());
  await adoptedRepo(template());
  dupIndex(searchCodeDb());
});
afterAll(() => rmSync(shared, { recursive: true, force: true }));

/** The adopted repo, with `change` applied to `n` files and staged. */
function stagedRepo(change: StagedChange, n: number): string {
  const root = tmp('staged-scaling-');
  cpSync(template(), root, { recursive: true });
  writeFiles(root, CHANGES[change].dir, n, 0);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base', '--no-verify']);
  CHANGES[change].stage(root, n);
  return root;
}

type Gate = (typeof DETERMINISTIC)[number];

/** Run `gate` from source in `root`; it must pass the clean fixture. */
function runGate(root: string, gate: Gate, trace: string): string {
  const module = fileURLToPath(
    new URL(gate.module.replace(/\.mjs$/, '.mts'), new URL('../', import.meta.url)),
  );
  const run = testSpawnSync(process.execPath, [module, ...gate.args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TRACE2_EVENT: trace, SEARCH_CODE_DB: searchCodeDb() },
  });
  expect(run.status, `${gate.id} must pass the clean fixture: ${run.stderr}`).toBe(0);
  return `${run.stdout}${run.stderr}`;
}

function gitStarts(root: string, gate: Gate): number {
  const trace = join(tmp('staged-scaling-trace-'), 'trace2.json');
  runGate(root, gate, trace);
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
    expect(MEASURED.map((gate) => gate.id)).toEqual([
      'size',
      'fanout',
      'dup',
      'clone',
      'anti-slop',
      'comments',
      'decision-checks',
    ]);
    for (const id of EXCLUDED.keys()) expect(DETERMINISTIC.map((gate) => gate.id)).toContain(id);
  });

  it('runs the linked decision Check on an in-scope fixture, so its due path is measured', () => {
    const gate = MEASURED.find((g) => g.id === 'decision-checks');
    if (!gate) throw new Error('decision-checks is no longer a measured registry gate');
    const trace = join(tmp('staged-scaling-trace-'), 'trace2.json');
    expect(runGate(stagedRepo('rename-in-scope', 1), gate, trace)).toContain(
      'decision-checks: demo',
    );
  });

  it.each(['delete-out-of-scope', 'rename-out-of-scope', 'modify-out-of-scope'] as const)(
    'starts no git process per staged file outside scanRoots (%s)',
    (change) => {
      expect(slopes(change)).toEqual(Object.fromEntries(MEASURED.map((gate) => [gate.id, 0])));
    },
  );

  it.each(['rename-in-scope', 'codemod-in-scope'] as const)(
    'starts at most the pinned git processes per staged file inside scanRoots (%s)',
    (change) => {
      for (const [id, slope] of Object.entries(slopes(change))) {
        expect(slope, id).toBeLessThanOrEqual(IN_SCOPE_SLOPE[change].get(id) ?? 0);
      }
    },
  );
});
