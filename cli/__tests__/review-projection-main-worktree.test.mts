import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifest } from '../lib/ship/review/projection/manifest.mts';
import {
  materializeProjectionRuntime,
  verifyProjectionRuntime,
} from '../lib/ship/review/projection/runtime.mts';
import { STRUCTURE_BASELINE_DIR } from '../../gate-engine/ratchets/baseline-paths.mts';
import { rootRegistry } from './_helpers.mts';

const linkScript = fileURLToPath(new URL('../lib/ship/link-gate-configs.sh', import.meta.url));
const prepareScript = fileURLToPath(
  new URL('../lib/ship/prepare-gate-worktree.sh', import.meta.url),
);
const { mkTmp, cleanup } = rootRegistry();
const INDEX = '.search-code/index.db';
const OVERRIDES = '.devkit/correctness-overrides.json';
const BRANCH_BASELINE = '.devkit/baselines/size-lines.json';
const SHARED_CONFIG = 'oxlint.devkit.json';

afterEach(cleanup);

function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// A chunks table with the matcher's columns; `usable` rows carry both embeddings and a symbol_name.
function writeIndex(path: string, usable: number) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, embedding BLOB, code_embedding BLOB)',
  );
  const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  for (let i = 0; i < usable; i++)
    insert.run('a.ts', `f${i}`, new Uint8Array(4), new Uint8Array(4));
  db.close();
}

function chunkCount(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n);
  db.close();
  return n;
}

// A main checkout whose committed guard.config.json (at `pkg`) names the index, plus a linked
// worktree of it that holds no git-ignored gate input at all.
function repos(pkg = '') {
  const parent = realpathSync(mkTmp('review main fallback-'));
  const main = join(parent, 'main checkout');
  const linked = join(parent, 'linked checkout');
  const worktree = join(parent, 'private worktree');
  mkdirSync(main);
  mkdirSync(worktree);
  git(main, 'init', '-q');
  write(join(main, pkg, 'guard.config.json'), `{"indexPath":"${INDEX}"}\n`);
  write(join(main, '.gitignore'), '.search-code/\n.devkit/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'config');
  git(main, 'worktree', 'add', '-q', '--detach', linked);
  return { parent, main, linked, worktree, manifest: join(parent, 'projection.json') };
}

function project(root: string, worktree: string, manifest: string, purpose = 'review') {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'set -u; source "$1"; source "$2"; link_untracked_gate_configs "$3" "$4" "$5"',
      'test',
      prepareScript,
      linkScript,
      worktree,
      root,
      purpose,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_REVIEW_PROJECTION_MANIFEST: manifest },
    },
  );
}

describe('review gate projection — main-worktree inputs, as ship links them', () => {
  it("copies a shared input the linked worktree lacks from main, never main's branch-local one", () => {
    const { main, linked, worktree, manifest } = repos();
    writeIndex(join(main, INDEX), 2);
    write(join(main, SHARED_CONFIG), '{}\n');
    write(join(main, BRANCH_BASELINE), '{}\n');
    write(join(main, OVERRIDES), '{"waivers":[]}\n');
    // An empty local cache dir is unusable, so main's populated one wins, as ship's link does.
    mkdirSync(join(linked, '.decisions'));
    write(join(main, '.decisions', 'cache.json'), '{}\n');

    const result = project(linked, worktree, manifest);

    expect(result.status, result.stderr).toBe(0);
    expect(chunkCount(join(worktree, INDEX))).toBe(2);
    expect(readFileSync(join(worktree, SHARED_CONFIG), 'utf8')).toBe('{}\n');
    expect(readFileSync(join(worktree, '.decisions', 'cache.json'), 'utf8')).toBe('{}\n');
    // Another branch's ratchet ceilings never gate this one.
    expect(() => readFileSync(join(worktree, BRANCH_BASELINE))).toThrow();
    // Review's setup authority froze the target's absent overrides; main's copy must not appear.
    expect(() => readFileSync(join(worktree, OVERRIDES))).toThrow();
    expect(result.stderr).not.toContain(OVERRIDES);
    const entries = readManifest(manifest).entries;
    expect(entries.find((entry) => entry.path === SHARED_CONFIG)?.sourceVolatile).toBe(true);
    expect(entries.find((entry) => entry.path === INDEX)?.sourceVolatile).toBe(true);

    // A parallel ship rewriting main's copy must not abort this review.
    write(join(main, SHARED_CONFIG), '{"changed":true}\n');
    expect(() => verifyProjectionRuntime(linked, worktree, manifest)).not.toThrow();
  });

  it("copies main's populated index over a local one with no usable chunks", () => {
    const { main, linked, worktree, manifest } = repos();
    writeIndex(join(main, INDEX), 3);
    writeIndex(join(linked, INDEX), 0);

    const result = project(linked, worktree, manifest);

    expect(result.status, result.stderr).toBe(0);
    expect(chunkCount(join(worktree, INDEX))).toBe(3);
    expect(result.stderr).toContain(
      `↳ review: ${INDEX} in this checkout has no usable chunks — copied the main checkout's populated index instead`,
    );
  });

  it('reads from the target itself in the main checkout and in a worktree nested under it', () => {
    const { main, worktree, manifest, parent } = repos();
    writeIndex(join(main, INDEX), 3);
    const fromMain = project(main, worktree, manifest);
    expect(fromMain.status, fromMain.stderr).toBe(0);
    expect(chunkCount(join(worktree, INDEX))).toBe(3);

    const nested = join(main, 'nested', 'task');
    git(main, 'worktree', 'add', '-q', '--detach', nested);
    writeIndex(join(nested, INDEX), 1);
    const nestedWorktree = join(parent, 'nested private worktree');
    mkdirSync(nestedWorktree);
    const result = project(nested, nestedWorktree, join(parent, 'nested.json'));
    expect(result.status, result.stderr).toBe(0);
    expect(chunkCount(join(nestedWorktree, INDEX))).toBe(1);
  });

  it('falls back to the same package dir in main for a monorepo package target', () => {
    const { main, linked, worktree, manifest } = repos('pkg');
    writeIndex(join(main, 'pkg', INDEX), 2);
    writeIndex(join(main, INDEX), 5);

    const result = project(join(linked, 'pkg'), worktree, manifest);

    expect(result.status, result.stderr).toBe(0);
    expect(chunkCount(join(worktree, INDEX))).toBe(2);
  });

  it("still links ship's gate worktree straight at main's index", () => {
    const { main, linked, worktree, manifest } = repos();
    writeIndex(join(main, INDEX), 2);

    const result = project(linked, worktree, manifest, 'ship');

    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(worktree, INDEX))).toBe(`${main}/${INDEX}`);
  });

  it('refuses a main-worktree input when the target has no main worktree to read', () => {
    const { main, worktree, manifest } = repos();
    write(join(main, SHARED_CONFIG), '{}\n');
    expect(() =>
      materializeProjectionRuntime(main, worktree, manifest, [SHARED_CONFIG], '', {}, [
        SHARED_CONFIG,
      ]),
    ).toThrow('gate projection names the main worktree, but none resolves');
  });

  it('copies a per-file entry both checkouts list exactly once', () => {
    const { main, linked, worktree, manifest } = repos();
    const baseline = `${STRUCTURE_BASELINE_DIR}/a.mjs`;
    // Without its own guard.config.json the target resolves candidates from main's config.
    rmSync(join(linked, 'guard.config.json'));
    write(join(main, baseline), 'export default {};\n');
    write(join(linked, baseline), 'export default { linked: true };\n');

    const result = project(linked, worktree, manifest);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.split(`- ${baseline} `)).toHaveLength(2);
    expect(readFileSync(join(worktree, baseline), 'utf8')).toBe(
      'export default { linked: true };\n',
    );
  });

  it('never reads a path the review setup authority owns from main', () => {
    const { main, linked, worktree, manifest } = repos();
    write(join(main, OVERRIDES), '{}\n');
    materializeProjectionRuntime(linked, worktree, manifest, [OVERRIDES], '', {}, [OVERRIDES]);
    expect(() => readFileSync(join(worktree, OVERRIDES))).toThrow();
  });
});
