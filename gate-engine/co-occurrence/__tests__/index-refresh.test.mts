import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type IndexFreshnessDb,
  indexIsInThisCheckout,
  indexSourceRoot,
  inspectIndexFreshness,
  staleIndexMessage,
} from '../index-refresh.mts';

// The whole safety of the pre-scan refresh rests on this predicate: say yes about an index that
// really belongs to another checkout and the indexer rewrites THAT checkout's chunk rows with this
// one's code. Say no when it is genuinely local and the gate just scans a staler index.

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'refresh-root-'));
  outside = mkdtempSync(join(tmpdir(), 'refresh-outside-'));
  mkdirSync(join(root, '.search-code'), { recursive: true });
  writeFileSync(join(root, '.search-code', 'index.db'), '');
  mkdirSync(join(outside, '.search-code'), { recursive: true });
  writeFileSync(join(outside, '.search-code', 'index.db'), '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('indexIsInThisCheckout', () => {
  it('accepts an index that really lives inside the checkout', () => {
    expect(indexIsInThisCheckout(join(root, '.search-code', 'index.db'), root)).toBe(true);
  });

  it('rejects an index in a sibling checkout', () => {
    expect(indexIsInThisCheckout(join(outside, '.search-code', 'index.db'), root)).toBe(false);
  });

  it('rejects an index reached through a symlinked dir — the linked-worktree shape', () => {
    // What `devkit ship --link .search-code` sets up, and the case that makes this predicate
    // exist: the path looks local, but realpath lands in the primary checkout.
    const worktree = mkdtempSync(join(tmpdir(), 'refresh-worktree-'));
    try {
      symlinkSync(join(outside, '.search-code'), join(worktree, '.search-code'));
      expect(indexIsInThisCheckout(join(worktree, '.search-code', 'index.db'), worktree)).toBe(
        false,
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('rejects a path that escapes upward out of the checkout', () => {
    expect(indexIsInThisCheckout(join(root, '..'), root)).toBe(false);
  });

  it('rejects a nonexistent path rather than throwing', () => {
    expect(indexIsInThisCheckout(join(root, 'nope', 'index.db'), root)).toBe(false);
  });
});

function freshnessDb(rows: Record<string, unknown>[]): IndexFreshnessDb {
  return { prepare: () => ({ all: () => rows }) };
}

describe('inspectIndexFreshness', () => {
  it('accepts an index whose per-file stamps match its owning checkout', () => {
    const source = join(root, 'src.ts');
    writeFileSync(source, 'export const current = true;\n');
    const mtime = statSync(source).mtimeMs;
    const result = inspectIndexFreshness(
      freshnessDb([{ file_path: 'src.ts', min_mtime: mtime, max_mtime: mtime }]),
      join(root, '.search-code', 'index.db'),
      { cwd: root, indexPath: '.search-code/index.db' },
    );
    expect(result).toMatchObject({ status: 'fresh', checkedFiles: 1, staleFiles: [] });
  });

  it('detects the reported failure: an indexed file changed after the index was built', () => {
    const source = join(root, 'changed.ts');
    writeFileSync(source, 'export const current = true;\n');
    const result = inspectIndexFreshness(
      freshnessDb([{ file_path: 'changed.ts', min_mtime: 1, max_mtime: 1 }]),
      join(root, '.search-code', 'index.db'),
      { cwd: root, indexPath: '.search-code/index.db' },
    );
    expect(result).toMatchObject({ status: 'stale', staleFiles: ['changed.ts'] });
    const message = staleIndexMessage(result);
    expect(message).toContain('STALE');
    expect(message).toContain('search-code index');
    expect(message).toContain('--seed-files');
    expect(message).not.toContain('allowlist');
  });

  it('treats a deleted indexed file as stale', () => {
    const result = inspectIndexFreshness(
      freshnessDb([{ file_path: 'gone.ts', min_mtime: 1, max_mtime: 1 }]),
      join(root, '.search-code', 'index.db'),
      { cwd: root, indexPath: '.search-code/index.db' },
    );
    expect(result).toMatchObject({ status: 'stale', staleFiles: ['gone.ts'] });
  });

  it('degrades safely when a legacy index has no file_mtime column', () => {
    const db: IndexFreshnessDb = {
      prepare: () => {
        throw new Error('no such column: file_mtime');
      },
    };
    expect(
      inspectIndexFreshness(db, join(root, '.search-code', 'index.db'), {
        cwd: root,
        indexPath: '.search-code/index.db',
      }),
    ).toMatchObject({ status: 'unverifiable' });
  });

  it('treats all-null file stamps as unverifiable instead of stale', () => {
    expect(
      inspectIndexFreshness(
        freshnessDb([{ file_path: 'src.ts', min_mtime: null, max_mtime: null }]),
        join(root, '.search-code', 'index.db'),
        { cwd: root, indexPath: '.search-code/index.db' },
      ),
    ).toMatchObject({ status: 'unverifiable', staleFiles: [] });
  });

  it('maps a ship-worktree symlink back to the primary checkout that owns the index', () => {
    const primary = mkdtempSync(join(tmpdir(), 'freshness-primary-'));
    const holder = mkdtempSync(join(tmpdir(), 'freshness-linked-holder-'));
    const linked = join(holder, 'linked');
    try {
      execFileSync('git', ['init', '-q'], { cwd: primary });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: primary });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: primary });
      writeFileSync(join(primary, 'tracked.ts'), 'export const tracked = true;\n');
      execFileSync('git', ['add', '.'], { cwd: primary });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: primary });
      execFileSync('git', ['worktree', 'add', '--detach', '-q', linked, 'HEAD'], { cwd: primary });
      mkdirSync(join(primary, '.search-code'), { recursive: true });
      writeFileSync(join(primary, '.search-code', 'index.db'), 'fixture');
      symlinkSync(join(primary, '.search-code'), join(linked, '.search-code'));
      expect(
        indexSourceRoot(join(linked, '.search-code', 'index.db'), {
          cwd: linked,
          indexPath: '.search-code/index.db',
        }),
      ).toBe(realpathSync(primary));
    } finally {
      rmSync(holder, { recursive: true, force: true });
      rmSync(primary, { recursive: true, force: true });
    }
  });
});

describe('guard-dup short-helper verification', () => {
  it('drops stale three-line helpers without opting the whole scan out (sc-1509)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-index-gate-'));
    try {
      writeFileSync(join(dir, 'alpha.ts'), "import { fail } from './common';\n");
      writeFileSync(join(dir, 'beta.ts'), "import { fail } from './common';\n");
      writeFileSync(join(dir, 'allowlist.json'), JSON.stringify({ pairs: [], clones: [] }));
      const dbPath = join(dir, 'index.db');
      const db = new DatabaseSync(dbPath);
      db.exec(
        'CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, raw_code TEXT, file_mtime INTEGER, embedding BLOB, code_embedding BLOB)',
      );
      const insert = db.prepare(
        'INSERT INTO chunks (file_path, symbol_name, start_line, end_line, code_hash, raw_code, file_mtime, embedding, code_embedding) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const raw = 'function fail(message: string): never {\n  throw new Error(message);\n}';
      const embedding = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
      for (const file of ['alpha.ts', 'beta.ts'])
        insert.run(file, 'fail', 1, 15, 'same', raw, 1, embedding, embedding);
      db.close();

      const output = execFileSync(
        'node',
        [join(import.meta.dirname, '..', 'matcher.mts'), 'scan', '--new', '--changed', '--gate'],
        {
          cwd: dir,
          env: {
            ...process.env,
            SEARCH_CODE_DB: dbPath,
            CO_OCCURRENCE_ALLOWLIST: join(dir, 'allowlist.json'),
            MATCHER_CHANGED_FILES: 'alpha.ts',
          },
          encoding: 'utf8',
        },
      );
      expect(output).toContain('Stale index — dropped 1 candidate pair');
      expect(output).toContain('New candidates: 0');
      expect(output).toContain('No new duplication');
      expect(output).not.toContain('allowlist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
