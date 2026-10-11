import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dirs as shipDirs, dropWorktree, seedShipRepo } from './_ship-branch-fixture.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const scriptPath = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));

// A chunks table with the matcher's columns; `usable` rows carry both embeddings and a symbol_name.
function writeIndex(path: string, usable: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INT, end_line INT, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
  );
  const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, 1, 2, ?, ?, ?)');
  for (let i = 0; i < usable; i++)
    insert.run('a.ts', `f${i}`, `h${i}`, new Uint8Array(4), new Uint8Array(4));
  db.close();
}

// Ships from a linked worktree; the gate hook reports where the worktree's index link points.
function shipIndexFromLinked(local: number, main: number, branch: string) {
  const { dir, env, git } = seedShipRepo({ hookBody: 'readlink .search-code/index.db; exit 0' });
  writeFileSync(join(dir, '.gitignore'), '.devkit/ship-intent-*\n.search-code/\n');
  writeFileSync(join(dir, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
  git(['add', '.gitignore', 'guard.config.json'], { stdio: 'ignore' });
  git(['commit', '-q', '--no-verify', '-m', 'config + ignore'], { stdio: 'ignore' });
  writeIndex(join(dir, '.search-code/index.db'), main);
  const linkedParent = mkdtempSync(join(tmpdir(), 'ship index linked-'));
  shipDirs.push(linkedParent);
  const linked = join(linkedParent, 'checkout');
  git(['worktree', 'add', '-q', '-b', `${branch}-task`, linked], { stdio: 'ignore' });
  writeIndex(join(linked, '.search-code/index.db'), local);
  writeFileSync(join(linked, 'note.txt'), 'hi\n');
  const r = spawnSync('/bin/bash', [scriptPath, branch, 't', 'note.txt'], {
    cwd: linked,
    input: 'b\n',
    encoding: 'utf8',
    env: { ...env, SHIP_DRY_RUN: '1' },
  });
  dropWorktree(git, r.stderr);
  const log = readFileSync(join(linked, `.devkit/last-ship-gates-${branch}.log`), 'utf8');
  return { r, log, linkedParent };
}

describe("ship — an empty worktree index must not shadow the main checkout's populated one", () => {
  const NOTICE = /has no usable chunks — linked the main checkout's populated index/;

  it("links the main checkout's index when this checkout's index has no usable chunks", () => {
    const { r, log, linkedParent } = shipIndexFromLinked(0, 3, 'feat-empty-local-index');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(NOTICE);
    expect(log).toMatch(/\.search-code\/index\.db/);
    expect(log).not.toContain(linkedParent);
  });

  it('keeps a populated local index', () => {
    const { r, log, linkedParent } = shipIndexFromLinked(1, 3, 'feat-populated-local-index');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(NOTICE);
    expect(log).toContain(linkedParent);
  });

  it('keeps the local index when neither has usable chunks', () => {
    const { r, log, linkedParent } = shipIndexFromLinked(0, 0, 'feat-both-empty-index');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(NOTICE);
    expect(log).toContain(linkedParent);
  });
});

describe('ship — a main-worktree gate cache is classified by the shipped ignore rules', () => {
  it('uses an ignore rule shipped from a linked worktree to classify a main-worktree index', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
    writeFileSync(join(dir, '.gitignore'), '.base-cache/\n');
    git(['add', 'guard.config.json', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'track config + base ignores'], {
      stdio: 'ignore',
    });
    mkdirSync(join(dir, '.search-code'), { recursive: true });
    writeFileSync(join(dir, '.search-code/index.db'), 'index');

    const linkedParent = mkdtempSync(join(tmpdir(), 'ship-linked-ignore-'));
    shipDirs.push(linkedParent);
    const linked = join(linkedParent, 'checkout');
    git(['worktree', 'add', '-q', '-b', 'linked-ignore-task', linked], { stdio: 'ignore' });
    writeFileSync(join(linked, '.gitignore'), '.base-cache/\n.search-code/\n');
    writeFileSync(join(linked, 'note.txt'), 'hi\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/same-ship-ignore', 't', '--', '.gitignore', 'note.txt'],
      {
        cwd: linked,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\.search-code\/index\.db .*gitignored cache/);
    expect(r.stderr).not.toMatch(/\.search-code\/index\.db .*commit it/);
  });
});
