import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeProjectionRuntime } from '../lib/ship/review/projection/runtime.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

const INDEX = '.search-code/index.db';

function target() {
  const parent = mkTmp('wal-index projection-');
  const root = join(parent, 'target repo');
  const worktree = join(parent, 'review worktree');
  mkdirSync(join(root, '.search-code'), { recursive: true });
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', root]);
  const manifest = join(parent, 'projection-runtime.json');
  return { root, worktree, manifest };
}

describe('review projection: the SQLite wal-index is never copied', () => {
  it('captures the index while a live reader rewrites -shm mid-copy', () => {
    const { root, worktree, manifest } = target();
    writeFileSync(join(root, INDEX), 'sqlite-main');
    writeFileSync(join(root, `${INDEX}-wal`), 'frames');
    writeFileSync(join(root, `${INDEX}-shm`), 'wal-index');
    const capture = () =>
      materializeProjectionRuntime(root, worktree, manifest, [INDEX], INDEX, {
        beforeSourceVerification: () => appendFileSync(join(root, `${INDEX}-shm`), 'read-mark'),
      });
    expect(capture).not.toThrow();
    expect(existsSync(join(worktree, `${INDEX}-shm`))).toBe(false);
    expect(readFileSync(join(worktree, `${INDEX}-wal`), 'utf8')).toBe('frames');
    const entries = JSON.parse(readFileSync(manifest, 'utf8')).entries;
    const shm = entries.find((entry: { path: string }) => entry.path === `${INDEX}-shm`);
    expect(shm).toMatchObject({ mutable: true, sourceVolatile: true, source: { type: 'absent' } });
  });

  it('retries a capture torn by a writer that then goes quiet', () => {
    const { root, worktree, manifest } = target();
    writeFileSync(join(root, INDEX), 'sqlite-main');
    writeFileSync(join(root, `${INDEX}-wal`), 'frames');
    let commits = 2;
    materializeProjectionRuntime(root, worktree, manifest, [INDEX], INDEX, {
      beforeSourceVerification: () => {
        if (commits-- > 0) appendFileSync(join(root, `${INDEX}-wal`), '+commit');
      },
    });
    expect(readFileSync(join(worktree, `${INDEX}-wal`), 'utf8')).toBe('frames+commit+commit');
    expect(existsSync(manifest)).toBe(true);
  });

  it('still refuses a capture torn by a writer appending WAL frames mid-copy', () => {
    const { root, worktree, manifest } = target();
    writeFileSync(join(root, INDEX), 'sqlite-main');
    writeFileSync(join(root, `${INDEX}-wal`), 'frames');
    expect(() =>
      materializeProjectionRuntime(root, worktree, manifest, [INDEX], INDEX, {
        beforeSourceVerification: () => appendFileSync(join(root, `${INDEX}-wal`), 'commit'),
      }),
    ).toThrow(/changed during capture; retry — .*index\.db-wal was still being written after 5/);
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(join(worktree, `${INDEX}-wal`))).toBe(false);
  });

  it('recovers uncheckpointed WAL rows in the private copy without the -shm', () => {
    const { root, worktree, manifest } = target();
    const writer = new DatabaseSync(join(root, INDEX));
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      writer.exec('CREATE TABLE chunks (id INTEGER PRIMARY KEY, body TEXT)');
      for (let id = 1; id <= 25; id += 1) {
        writer.prepare('INSERT INTO chunks (body) VALUES (?)').run(`chunk ${id}`);
      }
      expect(statSync(join(root, `${INDEX}-wal`)).size).toBeGreaterThan(0);
      expect(existsSync(join(root, `${INDEX}-shm`))).toBe(true);
      materializeProjectionRuntime(root, worktree, manifest, [INDEX], INDEX);
    } finally {
      writer.close();
    }
    const copy = new DatabaseSync(join(worktree, INDEX));
    try {
      expect(copy.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual({ n: 25 });
    } finally {
      copy.close();
    }
  });
});
