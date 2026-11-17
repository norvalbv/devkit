import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { reportUnindexed, unindexedNotice, unindexedStaged } from '../index-refresh.mts';

const MATCHER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'matcher.mts');
const CLEAN_RE = /since the last baseline\. ✓/;

let tmp: string;
let dbPath: string;

const emb = (v = [1, 0, 0, 0]) => Buffer.from(new Float32Array(v).buffer);
const touch = (rel: string) => {
  mkdirSync(dirname(join(tmp, rel)), { recursive: true });
  writeFileSync(join(tmp, rel), 'export const x = 1;\n');
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'unindexed-'));
  writeFileSync(
    join(tmp, 'guard.config.json'),
    JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'] }),
  );
  for (const f of ['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/pending.ts', 'src/new.test.ts']) {
    touch(f);
  }
  touch('docs/new.ts');
  touch('src/__tests__/helpers.ts');
  dbPath = join(tmp, 'index.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
  );
  const ins = db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?)');
  ins.run('src/a.ts', 'dupA', 1, 10, 'SAME', emb(), emb());
  ins.run('src/b.ts', 'dupB', 1, 10, 'SAME', emb(), emb());
  const apart = [0, 1, 0, 0]; // orthogonal to the dup pair, so it pairs with nothing
  ins.run('src/other.ts', 'other', 1, 10, 'OTHER', emb(apart), emb(apart));
  // Chunked but never embedded (an interrupted index run): present, yet not comparable.
  ins.run('src/pending.ts', 'pending', 1, 10, 'P', null, null);
  db.close();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function gate(changed: string) {
  const events = join(tmp, `events-${Math.random().toString(36).slice(2)}.jsonl`);
  const r = spawnSync('node', [MATCHER, 'scan', '--new', '--changed', '--gate'], {
    cwd: tmp,
    env: {
      ...process.env,
      SEARCH_CODE_DB: dbPath,
      CO_OCCURRENCE_ALLOWLIST: join(tmp, 'missing-allowlist.json'),
      MATCHER_CHANGED_FILES: changed,
      DEVKIT_GATE_EVENTS: events,
    },
    encoding: 'utf8',
  });
  const lines = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [];
  const degraded = lines
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((ev) => ev.type === 'gate_degraded');
  return { status: r.status, stdout: r.stdout, degraded };
}

describe('unindexedStaged', () => {
  const scope = (includeTests = false) => ({
    cwd: tmp,
    scanRoots: ['src'],
    sourceExtensions: ['ts'],
    includeTests,
  });
  const indexed = new Set(['src/a.ts']);

  it('names only on-disk scan-root sources with no usable chunk', () => {
    const changed = new Set([
      'src/a.ts', // indexed
      'src/new.ts', // named
      'docs/new.ts', // outside scanRoots
      'src/readme.md', // not a source extension
      'src/new.test.ts', // test file
      'src/deleted.ts', // not on disk
    ]);
    expect(unindexedStaged(changed, indexed, scope())).toEqual(['src/new.ts']);
  });

  // The indexer skips __tests__/ dirs, so a helper there would be named on every commit forever.
  it('treats a __tests__/ helper as test code, like a .test. file', () => {
    const changed = new Set(['src/__tests__/helpers.ts']);
    expect(unindexedStaged(changed, indexed, scope())).toEqual([]);
    expect(unindexedStaged(changed, indexed, scope(true))).toEqual(['src/__tests__/helpers.ts']);
  });

  it('a "." scan root covers every directory', () => {
    const changed = new Set(['src/new.ts', 'docs/new.ts']);
    const all = { ...scope(), scanRoots: ['.'] };
    expect(unindexedStaged(changed, indexed, all)).toEqual(['docs/new.ts', 'src/new.ts']);
  });

  it('includes test files under --include-tests', () => {
    const changed = new Set(['src/new.test.ts']);
    expect(unindexedStaged(changed, indexed, scope(true))).toEqual(['src/new.test.ts']);
  });
});

describe('unindexedNotice', () => {
  it('is empty when every staged file was compared', () => {
    expect(unindexedNotice([], true)).toEqual([]);
  });

  it('counts, samples six and points at the right remedy', () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const [head, owned] = unindexedNotice(files, true);
    expect(head).toContain('8 staged file(s) have no usable (embedded) chunks');
    expect(head).toContain('src/f5.ts (+2 more)');
    expect(head).not.toContain('src/f6.ts');
    expect(owned).toContain('search-code index');
    // An excluded or unchunkable file never gets embedded; the remedy must not promise it will.
    expect(owned).toContain('excludes or cannot chunk');
    expect(unindexedNotice(files, false)[1]).toContain('shared from another checkout');
  });
});

describe('reportUnindexed', () => {
  afterEach(() => vi.unstubAllEnvs());
  const scope = () => ({
    cwd: tmp,
    scanRoots: ['src'],
    sourceExtensions: ['ts'],
    includeTests: false,
    indexPath: dbPath,
  });

  it('does nothing for an unscoped scan', () => {
    expect(reportUnindexed(null, [], scope())).toEqual([]);
  });

  it('returns the notice and writes one gate_degraded event', () => {
    const events = join(tmp, 'report-events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', events);
    const rows = [{ file_path: 'src/a.ts' }];
    const lines = reportUnindexed(new Set(['src/a.ts', 'src/new.ts']), rows, scope());
    expect(lines[0]).toContain('not compared: src/new.ts');
    const [ev] = readFileSync(events, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ev).toMatchObject({ type: 'gate_degraded', judge: 'dup', cause: 'unindexed_staged' });
  });

  // Catches the wiring: the remedy must follow where the index physically lives, not a constant.
  it('picks the remedy from whether this checkout owns the index', () => {
    const changed = new Set(['src/new.ts']);
    expect(reportUnindexed(changed, [], scope())[1]).toContain('search-code index');
    const elsewhere = mkdtempSync(join(tmpdir(), 'unindexed-primary-'));
    try {
      writeFileSync(join(elsewhere, 'index.db'), '');
      const shared = { ...scope(), indexPath: join(elsewhere, 'index.db') };
      expect(reportUnindexed(changed, [], shared)[1]).toContain('shared from another checkout');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('matcher gate names staged files it never compared', () => {
  it('names a staged file absent from the index, exits 0 and counts it', () => {
    const r = gate('src/new.ts');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 staged file(s) have no usable (embedded) chunks');
    expect(r.stdout).toContain('not compared: src/new.ts');
    expect(r.stdout).toContain('No new duplication among the compared files. ✓');
    expect(r.stdout).not.toMatch(CLEAN_RE);
    expect(r.degraded).toHaveLength(1);
    expect(r.degraded[0]).toMatchObject({ judge: 'dup', cause: 'unindexed_staged' });
    expect(r.degraded[0].detail).toContain('src/new.ts');
  });

  it('names a file whose rows were never embedded', () => {
    expect(gate('src/pending.ts').stdout).toContain('not compared: src/pending.ts');
  });

  it('still names the uncompared file when a dup blocks', () => {
    const r = gate('src/a.ts,src/new.ts');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('not compared: src/new.ts');
  });

  it('keeps the plain clean line and emits nothing when every staged file was compared', () => {
    const r = gate('src/other.ts');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(CLEAN_RE);
    expect(r.stdout).not.toContain('not compared');
    expect(r.degraded).toHaveLength(0);
  });
});
