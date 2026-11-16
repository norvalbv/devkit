import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSearchIndex } from '../../../cli/lib/doctor/guard-config-checks.mts';
import { primaryIndexFallback } from '../index-refresh.mts';

// A linked worktree has no copy of the gitignored index. A plain commit there must run guard-dup
// against the primary checkout's index, exactly as `devkit ship` does by linking it.

const MATCHER = join(import.meta.dirname, '..', 'matcher.mts');
const INDEX = '.search-code/index.db';
const HELPER = [
  'export function helper(): number {',
  ...Array.from({ length: 14 }, (_, i) => `  const v${i} = ${i};`),
  '  return v0;',
  '}',
].join('\n');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A chunk table the matcher accepts; `files` get one identical, embedded `helper` chunk each,
 * stamped with the mtime of the checkout that holds `<checkout>/.search-code/index.db`. */
function writeIndex(dbPath: string, files: string[]): void {
  const checkout = dirname(dirname(dbPath));
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, raw_code TEXT, file_mtime INTEGER, embedding BLOB, code_embedding BLOB)',
  );
  const insert = db.prepare(
    'INSERT INTO chunks (file_path, symbol_name, start_line, end_line, code_hash, raw_code, file_mtime, embedding, code_embedding) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const vec = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  const end = HELPER.split('\n').length;
  for (const file of files) {
    const mtime = statSync(join(checkout, file)).mtimeMs;
    insert.run(file, 'helper', 1, end, 'same', HELPER, mtime, vec, vec);
  }
  db.close();
}

/** A primary checkout (code under `pkg`) with a linked worktree; returns both package dirs. */
function checkouts(pkg = '') {
  const primary = tmp('linked-index-primary-');
  const linked = join(tmp('linked-index-holder-'), 'wt');
  const dir = join(primary, pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'guard.config.json'), JSON.stringify({ indexPath: INDEX }));
  writeFileSync(join(dir, 'allowlist.json'), JSON.stringify({ pairs: [], clones: [] }));
  for (const file of ['alpha.ts', 'beta.ts']) writeFileSync(join(dir, file), `${HELPER}\n`);
  git(primary, 'init', '-q');
  git(primary, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '.');
  git(primary, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'fixture');
  git(primary, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
  return { primary: dir, linked: join(linked, pkg) };
}

function scan(
  cwd: string,
  env: Record<string, string> = {},
  args = ['scan', '--new', '--changed', '--gate'],
) {
  const base = { ...process.env };
  delete base.SEARCH_CODE_DB;
  delete base.GUARD_INDEX_PATH;
  return spawnSync('node', [MATCHER, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...base,
      CO_OCCURRENCE_ALLOWLIST: join(cwd, 'allowlist.json'),
      MATCHER_CHANGED_FILES: 'alpha.ts',
      ...env,
    },
  });
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('guard-dup in a linked worktree with no index of its own', () => {
  it("blocks on the primary checkout's index and never writes it", () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const before = sha(join(primary, INDEX));
    const r = scan(linked);
    expect(r.stderr).toContain("reading the primary checkout's");
    expect(r.status).toBe(1);
    expect(sha(join(primary, INDEX))).toBe(before);
  });

  it("falls back past an empty schema-only local index, as ship's link does", () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    writeIndex(join(linked, INDEX), []);
    expect(scan(linked).status).toBe(1);
  });

  // baseline rewrites the index's allowlisted flags: borrowing would overwrite the primary's.
  it("never lets baseline borrow, so it cannot write the primary checkout's index", () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const before = sha(join(primary, INDEX));
    const r = scan(linked, {}, ['baseline']);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toContain(
      `never borrows the primary checkout's ${join(realpathSync(primary), INDEX)}`,
    );
    expect(sha(join(primary, INDEX))).toBe(before);
  });

  it('drops a pair whose indexed body this worktree no longer has', () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    writeFileSync(join(linked, 'alpha.ts'), 'export const changed = true;\n');
    const r = scan(linked);
    expect(r.stdout).toContain('Stale index — dropped');
    expect(r.status).toBe(0);
  });

  it('maps a monorepo package subdir to the same subdir in the primary', () => {
    const { primary, linked } = checkouts('pkg');
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const r = scan(linked);
    expect(r.stderr).toContain(join('pkg', INDEX));
    expect(r.status).toBe(1);
  });

  it('opts out visibly, naming the primary, when no checkout has an index', () => {
    const { primary, linked } = checkouts();
    const r = scan(linked);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toContain(`${join(primary, INDEX)} has no usable index either`);
  });

  // The primary is its own counterpart: it must not "fall back" to itself or blame a linked worktree.
  it('in the primary checkout with no index, opts out with the plain build remedy', () => {
    const { primary } = checkouts();
    const r = scan(primary);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toContain('Build one with your indexer');
    expect(r.stderr + r.stdout).not.toContain('linked worktree');
  });

  it('leaves SEARCH_CODE_DB and the primary checkout itself alone', () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const empty = join(tmp('linked-index-env-'), 'index.db');
    writeIndex(empty, []);
    const viaEnv = scan(linked, { SEARCH_CODE_DB: empty });
    expect(viaEnv.status).toBe(2);
    expect(viaEnv.stderr).not.toContain("reading the primary checkout's");
    const inPrimary = scan(primary);
    expect(inPrimary.status).toBe(1);
    expect(inPrimary.stderr).not.toContain("reading the primary checkout's");
  });
});

describe('primaryIndexFallback', () => {
  it('is null outside git and for a primary index whose schema it cannot judge', () => {
    const plain = tmp('linked-index-plain-');
    expect(primaryIndexFallback(join(plain, INDEX), plain)).toBeNull();
    const { primary, linked } = checkouts();
    mkdirSync(join(primary, '.search-code'), { recursive: true });
    new DatabaseSync(join(primary, INDEX)).exec('CREATE TABLE other (x INTEGER)');
    expect(primaryIndexFallback(join(linked, INDEX), linked)).toBeNull();
  });

  // Re-rooting a path that leaves the worktree would land on whatever sits beside the primary.
  it('never re-roots an index path outside the worktree onto an unrelated index', () => {
    const { primary, linked } = checkouts();
    const shared = tmp('linked-index-shared-');
    writeFileSync(join(shared, 'alpha.ts'), `${HELPER}\n`);
    writeFileSync(join(shared, 'beta.ts'), `${HELPER}\n`);
    writeIndex(join(shared, '.search-code', 'index.db'), ['alpha.ts', 'beta.ts']);
    const escaping = join(dirname(linked), basename(shared), INDEX);
    expect(dirname(primary)).toBe(dirname(shared));
    expect(primaryIndexFallback(escaping, linked)).toBeNull();
  });
});

describe('doctor in a linked worktree', () => {
  it("reports the primary checkout's index instead of MISSING", () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const result = checkSearchIndex(linked, INDEX, true);
    expect(result.status).toBe('OK');
    expect(result.detail).toContain("(the primary checkout's)");
    expect(result.detail).toContain('2 indexed file(s) match');
  });

  // Freshness reads file stamps under the primary's package dir, not its toplevel.
  it('verifies freshness against the primary package dir in a monorepo subdir', () => {
    const { primary, linked } = checkouts('pkg');
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    expect(checkSearchIndex(linked, INDEX, true).detail).toContain('2 indexed file(s) match');
  });
});
