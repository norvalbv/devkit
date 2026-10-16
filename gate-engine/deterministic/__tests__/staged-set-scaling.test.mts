// Counts the git processes each deterministic gate starts and the packed blobs they read, at two
// staged-set sizes. Unseen: worktree `fs` reads, non-git children such as jscpd, loose objects.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
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

/** Where each staged change keeps its files, and how it stages them over the base commit. No case
 * stages an add beside a delete, where git's inexact rename detection reads every deleted blob. */
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
  // GIT_TRACE_PACK_ACCESS logs packed objects only; window=0 keeps every object whole, not a delta.
  git(root, ['-c', 'pack.window=0', 'repack', '-adq']);
  expect(git(root, ['count-objects', '-v'])).toMatch(/^count: 0$/m);
  return root;
}

/** Pack offsets of the fixture's blobs; a `verify-pack -v` row is `oid type size packed offset`. */
function blobOffsets(root: string): Set<string> {
  const pack = join(root, '.git', 'objects', 'pack');
  const idx = readdirSync(pack).filter((file) => file.endsWith('.idx'));
  const rows = idx.flatMap((file) =>
    git(root, ['verify-pack', '-v', join(pack, file)]).split('\n'),
  );
  return new Set(
    rows
      .map((row) => row.split(/\s+/))
      .filter((fields) => fields[1] === 'blob')
      .map((fields) => fields[4]),
  );
}

function traceLines(file: string): string[] {
  return (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').filter(Boolean);
}

interface GitWork {
  starts: number;
  blobs: number;
}

function gitWork(root: string, gate: (typeof DETERMINISTIC)[number]): GitWork {
  const traceDir = tmp('staged-scaling-trace-');
  const trace2 = join(traceDir, 'trace2.json');
  const packAccess = join(traceDir, 'pack-access.log');
  const module = fileURLToPath(
    new URL(gate.module.replace(/\.mjs$/, '.mts'), new URL('../', import.meta.url)),
  );
  const run = testSpawnSync(process.execPath, [module, ...gate.args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TRACE2_EVENT: trace2, GIT_TRACE_PACK_ACCESS: packAccess },
  });
  expect(run.status, `${gate.id} must pass the clean fixture: ${run.stderr}`).toBe(0);
  const starts = traceLines(trace2).filter((line) => line.includes('"event":"start"')).length;
  expect(starts, `${gate.id} recorded no git process, so its count proves nothing`).toBeGreaterThan(
    0,
  );
  const reads = traceLines(packAccess);
  expect(
    reads.length,
    `${gate.id} read nothing from the pack, so its blob count proves nothing`,
  ).toBeGreaterThan(0);
  const blobs = blobOffsets(root);
  return {
    starts,
    blobs: reads.filter((line) => blobs.has(line.split(/\s+/).at(-1) ?? '')).length,
  };
}

function slopes(change: StagedChange): Record<string, GitWork> {
  const small = stagedRepo(change, SMALL);
  const big = stagedRepo(change, BIG);
  return Object.fromEntries(
    MEASURED.map((gate) => {
      const [before, after] = [gitWork(small, gate), gitWork(big, gate)];
      const slope = (key: keyof GitWork) => (after[key] - before[key]) / (BIG - SMALL);
      return [gate.id, { starts: slope('starts'), blobs: slope('blobs') }];
    }),
  );
}

describe('deterministic gate cost against the staged-set size', () => {
  it('names a reason for every registry gate it does not measure', () => {
    expect(MEASURED.map((gate) => gate.id)).toEqual(['size', 'fanout', 'clone', 'comments']);
    for (const id of EXCLUDED.keys()) expect(DETERMINISTIC.map((gate) => gate.id)).toContain(id);
  });

  it.each(['delete-out-of-scope', 'rename-out-of-scope', 'modify-out-of-scope'] as const)(
    'starts no git process and reads no blob per staged file outside scanRoots (%s)',
    (change) => {
      expect(slopes(change)).toEqual(
        Object.fromEntries(MEASURED.map((gate) => [gate.id, { starts: 0, blobs: 0 }])),
      );
    },
  );

  it.each(['rename-in-scope', 'codemod-in-scope'] as const)(
    'starts at most the pinned git processes per staged file inside scanRoots (%s)',
    (change) => {
      const measured = slopes(change);
      for (const [id, slope] of Object.entries(measured)) {
        expect(slope.starts, id).toBeLessThanOrEqual(IN_SCOPE_SLOPE[change].get(id) ?? 0);
      }
      expect(
        measured.size.blobs,
        'size reads each in-scope blob it line-counts, so 0 means the blob count is blind',
      ).toBeGreaterThan(0);
    },
  );
});
