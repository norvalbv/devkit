import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSearchIndex } from '../../../cli/lib/doctor/guard-config-checks.mts';
import { gateConfigFingerprint } from '../../prefix-cache/config-fingerprint.mts';
import { primaryIndexFallback, seedIndexCopy } from '../index-refresh.mts';

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
    // Without an indexCommand there is nothing to refresh, so no private copy is taken.
    expect(existsSync(join(linked, INDEX))).toBe(false);
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

// Stands in for search-code: re-embeds the edited alpha.ts, or stops short leaving beta unembedded.
const INDEXER = `
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [mode] = process.argv.slice(2);
fs.writeFileSync('.indexer-argv.json', JSON.stringify(process.argv.slice(2)));
const db = new DatabaseSync('.search-code/index.db');
if (mode === 'reembed')
  db.prepare('UPDATE chunks SET raw_code = ? WHERE file_path = ?').run(fs.readFileSync('alpha.ts', 'utf8'), 'alpha.ts');
else db.prepare('UPDATE chunks SET embedding = NULL, code_embedding = NULL WHERE file_path = ?').run('beta.ts');
db.close();
if (mode !== 'reembed') process.exitCode = 75;
`;
// Every body line rewritten, the symbol kept: the indexed body is no longer on disk.
const EDITED = HELPER.replaceAll('v', 'w');

function indexer(mode: 'reembed' | 'cut-short') {
  const script = join(tmp('linked-copy-indexer-'), 'indexer.cjs');
  writeFileSync(script, INDEXER);
  return { GUARD_INDEX_COMMAND: `node ${script} ${mode} {staged-csv}`, DEVKIT_SHIP: '' };
}

function degraded(events: string) {
  const text = existsSync(events) ? readFileSync(events, 'utf8') : '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'gate_degraded');
}

describe('guard-dup in a linked worktree with an indexCommand', () => {
  function edited(pkg = '') {
    const { primary, linked } = checkouts(pkg);
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    writeFileSync(join(linked, 'alpha.ts'), `${EDITED}\n`);
    return { primary, linked, before: sha(join(primary, INDEX)) };
  }

  it('re-judges an edited-but-kept symbol on its own refreshed copy', () => {
    const { primary, linked, before } = edited();
    const r = scan(linked, indexer('reembed'));
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('Stale index');
    expect(lstatSync(join(linked, INDEX)).isFile()).toBe(true);
    expect(sha(join(primary, INDEX))).toBe(before);
    expect(JSON.parse(readFileSync(join(linked, '.indexer-argv.json'), 'utf8'))).toEqual([
      'reembed',
      'alpha.ts',
    ]);
  });

  it("replaces ship's own link with a copy, never writing through it", () => {
    const { primary, linked, before } = edited();
    mkdirSync(join(linked, '.search-code'));
    symlinkSync(join(primary, INDEX), join(linked, INDEX));
    const r = scan(linked, { ...indexer('reembed'), DEVKIT_SHIP: '1' });
    expect(r.status).toBe(1);
    expect(lstatSync(join(linked, INDEX)).isSymbolicLink()).toBe(false);
    expect(sha(join(primary, INDEX))).toBe(before);
  });

  it("keeps a plain worktree's own link, and names the pair it drops", () => {
    const { primary, linked } = edited();
    mkdirSync(join(linked, '.search-code'));
    symlinkSync(join(primary, INDEX), join(linked, INDEX));
    const events = join(tmp('linked-copy-events-'), 'events.jsonl');
    const reason = join(tmp('linked-copy-reason-'), 'reason');
    const r = scan(linked, {
      ...indexer('reembed'),
      DEVKIT_GATE_EVENTS: events,
      DEVKIT_GATE_REASON_FILE: reason,
    });
    expect(r.status).toBe(0);
    expect(lstatSync(join(linked, INDEX)).isSymbolicLink()).toBe(true);
    expect(r.stdout).toContain('Stale index — dropped 1 candidate pair');
    expect(r.stdout).toContain('No new duplication among the compared files. ✓');
    expect(degraded(events)).toMatchObject([{ judge: 'dup', cause: 'stale_index_drop' }]);
    // The note a cached PASS carries, so a same-tree re-ship still reports the drop.
    expect(readFileSync(reason, 'utf8')).toContain('dup: Stale index — dropped 1 candidate pair');
  });

  // A regular file can be a build still running beside its WAL: renaming over it would corrupt it.
  it('never replaces a regular index file, even one with no usable chunk', () => {
    const { primary, linked } = edited();
    writeIndex(join(linked, INDEX), []);
    writeFileSync(join(linked, `${INDEX}-wal`), 'wal');
    const before = sha(join(linked, INDEX));
    const r = scan(linked, indexer('reembed'));
    expect(r.stderr).toContain("reading the primary checkout's");
    expect(sha(join(linked, INDEX))).toBe(before);
    expect(readFileSync(join(linked, `${INDEX}-wal`), 'utf8')).toBe('wal');
    expect(existsSync(join(primary, '.indexer-argv.json'))).toBe(false);
  });

  it('names chunks a cut-short refresh left unembedded, even outside the staged files', () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const events = join(tmp('linked-copy-events-'), 'events.jsonl');
    const r = scan(linked, { ...indexer('cut-short'), DEVKIT_GATE_EVENTS: events });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  1 outside the staged files, left by this run's index refresh");
    expect(r.stdout).toContain('No new duplication among the compared files. ✓');
    expect(degraded(events)).toMatchObject([{ judge: 'dup', cause: 'pending_embed' }]);
  });

  it('seeds the copy at the same package dir in a monorepo subdir', () => {
    const { primary, linked, before } = edited('pkg');
    const r = scan(linked, indexer('reembed'));
    expect(r.status).toBe(1);
    expect(lstatSync(join(linked, INDEX)).isFile()).toBe(true);
    expect(sha(join(primary, INDEX))).toBe(before);
  });

  // A linked index DIRECTORY resolves into the primary: seeding there would write the primary's tree.
  it("never seeds through a link to the primary's index directory", () => {
    const { primary, linked, before } = edited();
    symlinkSync(join(primary, '.search-code'), join(linked, '.search-code'));
    const r = scan(linked, { ...indexer('reembed'), DEVKIT_SHIP: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stale index — dropped 1 candidate pair');
    expect(readdirSync(join(primary, '.search-code'))).toEqual(['index.db']);
    expect(sha(join(primary, INDEX))).toBe(before);
  });

  // No index behind the link, so only the directory check stands between the seed and that folder.
  it('never writes a seed into an index directory linked outside the worktree', () => {
    const { primary, linked } = edited();
    const outside = tmp('linked-copy-outside-');
    symlinkSync(outside, join(linked, '.search-code'));
    seedIndexCopy(join(linked, INDEX), join(primary, INDEX), linked);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('seeds into a directory whose name merely starts with two dots', () => {
    const { primary, linked } = edited();
    seedIndexCopy(join(linked, '..search', 'index.db'), join(primary, INDEX), linked);
    expect(lstatSync(join(linked, '..search', 'index.db')).isFile()).toBe(true);
  });

  // A byte copy would adopt a torn or foreign file as this worktree's own index; VACUUM INTO refuses it.
  it('a source that is not a database leaves no index behind', () => {
    const { linked } = checkouts();
    const notADb = join(tmp('linked-copy-src-'), 'index.db');
    writeFileSync(notADb, 'not sqlite');
    seedIndexCopy(join(linked, INDEX), notADb, linked);
    expect(readdirSync(join(linked, '.search-code'))).toEqual([]);
  });

  // An unembedded chunk cannot be detected: reading that as "resolved" deletes a human approval.
  it('reconcile keeps an approval whose chunk a cut-short refresh left unembedded', () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const today = new Date().toISOString().slice(0, 10);
    const pair = { symbolA: 'helper', fileA: 'alpha.ts', symbolB: 'helper', fileB: 'beta.ts' };
    const approval = { ...pair, description: 'kept on purpose', date: today, decayDays: 3650 };
    writeFileSync(
      join(linked, 'allowlist.json'),
      JSON.stringify({ pairs: [approval], clones: [] }),
    );
    const r = scan(linked, indexer('cut-short'), ['reconcile', '--apply']);
    expect(r.stdout).toContain('keep 1, drop 0');
    expect(JSON.parse(readFileSync(join(linked, 'allowlist.json'), 'utf8')).pairs).toHaveLength(1);
  });

  it('sweeps seed temp files a killed gate left, never a live one', () => {
    const { primary, linked } = checkouts();
    writeIndex(join(primary, INDEX), ['alpha.ts', 'beta.ts']);
    const dir = join(linked, '.search-code');
    mkdirSync(dir);
    const dead = spawnSync('true').pid;
    writeFileSync(join(dir, `.index-seed-${dead}.db`), 'orphan');
    writeFileSync(join(dir, `.index-seed-${process.pid}.db.keep`), 'unrelated');
    writeFileSync(join(dir, `.index-seed-${process.ppid}.db`), 'live');
    seedIndexCopy(join(linked, INDEX), join(primary, INDEX), linked);
    expect(readdirSync(dir).sort()).toEqual(
      [`.index-seed-${process.pid}.db.keep`, `.index-seed-${process.ppid}.db`, 'index.db'].sort(),
    );
  });

  it('never copies for baseline, which writes the index', () => {
    const { linked } = edited();
    expect(scan(linked, indexer('reembed'), ['baseline']).status).toBe(2);
    expect(existsSync(join(linked, INDEX))).toBe(false);
  });

  it('keys the prefix cache on the primary it copies, before and after the copy', () => {
    const { primary, linked } = edited();
    vi.stubEnv('GUARD_INDEX_COMMAND', 'true');
    try {
      mkdirSync(join(linked, '.search-code'));
      symlinkSync(join(primary, INDEX), join(linked, INDEX));
      const viaLink = gateConfigFingerprint(linked);
      rmSync(join(linked, INDEX));
      copyFileSync(join(primary, INDEX), join(linked, INDEX));
      expect(gateConfigFingerprint(linked)).toBe(viaLink);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
