import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setHard } from '../mine-telemetry-lib.mts';
import { mineLabels } from '../scale/labels.mts';
import { assertMergedParentRows } from '../warehouse-guards.mts';

// sc-2073: chunked review (sc-1907) keeps chunk grain in CHILD tables; the consumers here read
// only merged parent rows. These tests pin that contract: chunk child rows change NOTHING, and a
// parent-table duplicate (the corruption chunking could cause) fails loudly instead of silently
// fanning out joins or last-write-winning Map indexes into the training corpus.

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const PARENT_SCHEMA = `
  create table commit_ships (ship_id text, repo text, branch text, ts_start text, exit_code int);
  create table commit_reviews (ship_id text, reviewer text, status text, reason text);
  create table commit_review_scope (ship_id text, reviewer text, diff_sha256 text, diff_bytes int, file_count int);
  create table commit_review_lenses (ship_id text, reviewer text, lens text, status text, disposition text, issues_json text, ts text);
`;
const CHILD_SCHEMA = `
  create table commit_review_chunks (ship_id text, reviewer text, chunk_index int, files_sha text, file_count int, bytes int);
  create table commit_review_lens_chunks (ship_id text, reviewer text, lens text, chunk_index int, files_sha text, status text);
`;
// s0 = the attempt whose diff is under test (sha DDD); s1 = a later attempt on the same branch
// whose correctness FAIL mints the label. Both merged: one row per (ship, reviewer[, lens]).
const PARENT_ROWS = `
  insert into commit_ships values ('s0','devkit','feat/x','2026-08-01T00:00:00Z',1);
  insert into commit_ships values ('s1','devkit','feat/x','2026-08-02T00:00:00Z',1);
  insert into commit_reviews values ('s0','correctness-reviewer','fail','x');
  insert into commit_reviews values ('s1','correctness-reviewer','fail','y');
  insert into commit_review_scope values ('s0','correctness-reviewer','DDD',30000,3);
  insert into commit_review_scope values ('s1','correctness-reviewer','LLL',25000,2);
  insert into commit_review_lenses values ('s1','correctness-reviewer','state-transitions','fail',null,'["Bug in src/a.ts:3 — off-by-one"]','2026-08-02T00:01:00Z');
`;
const CHILD_ROWS = `
  insert into commit_review_chunks values ('s1','correctness-reviewer',0,'aaaaaaaaaaaa',1,16000),('s1','correctness-reviewer',1,'bbbbbbbbbbbb',1,9000);
  insert into commit_review_lens_chunks values
    ('s1','correctness-reviewer','state-transitions',0,'aaaaaaaaaaaa','fail'),
    ('s1','correctness-reviewer','state-transitions',1,'bbbbbbbbbbbb','pass');
`;

function makeDb(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-warehouse-'));
  roots.push(dir);
  const db = join(dir, 'usage.db');
  execFileSync('sqlite3', [db, sql]);
  return db;
}

const DIFF_D =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n+const a = 1;\n+const b = 2;\n+const c = 3;\n';

const mine = (db: string) =>
  mineLabels({
    dbPath: db,
    branch: 'feat/x',
    diffSha256: 'DDD',
    diffText: DIFF_D,
    sinceTs: '2026-08-01T00:00:00Z',
  });

describe('assertMergedParentRows', () => {
  it('passes on merged parent rows, with or without chunk child tables', () => {
    expect(() => assertMergedParentRows(makeDb(PARENT_SCHEMA + PARENT_ROWS))).not.toThrow();
    expect(() =>
      assertMergedParentRows(makeDb(PARENT_SCHEMA + CHILD_SCHEMA + PARENT_ROWS + CHILD_ROWS)),
    ).not.toThrow();
  });

  it('a missing table (older warehouse) passes; an unreadable db throws instead of passing', () => {
    const noLenses = PARENT_SCHEMA.replace(/create table commit_review_lenses[^;]*;/, '');
    expect(noLenses).not.toContain('commit_review_lenses');
    expect(() => assertMergedParentRows(makeDb(noLenses))).not.toThrow();
    // "Could not verify" must never read as "verified": a corrupt/locked db rethrows.
    const dir = mkdtempSync(join(tmpdir(), 'devkit-warehouse-'));
    roots.push(dir);
    const notADb = join(dir, 'usage.db');
    writeFileSync(notADb, 'this is not a sqlite file');
    expect(() => assertMergedParentRows(notADb)).toThrow(/could not verify/);
  });

  it('throws on duplicate parent rows for any consumer key', () => {
    const dupScope = `insert into commit_review_scope values ('s1','correctness-reviewer','CH1',16000,1);`;
    expect(() => assertMergedParentRows(makeDb(PARENT_SCHEMA + PARENT_ROWS + dupScope))).toThrow(
      /sc-2073.*commit_review_scope/s,
    );
    const dupLens = `insert into commit_review_lenses values ('s1','correctness-reviewer','state-transitions','pass',null,null,'2026-08-02T00:02:00Z');`;
    expect(() => assertMergedParentRows(makeDb(PARENT_SCHEMA + PARENT_ROWS + dupLens))).toThrow(
      /sc-2073.*commit_review_lenses/s,
    );
  });
});

describe('mineLabels under the chunk-era warehouse', () => {
  it('chunk child rows change nothing: byte-identical labels vs the chunkless twin', () => {
    const plain = mine(makeDb(PARENT_SCHEMA + PARENT_ROWS));
    const chunked = mine(makeDb(PARENT_SCHEMA + CHILD_SCHEMA + PARENT_ROWS + CHILD_ROWS));
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ lens: 'state-transitions', file: 'src/a.ts', line: 3 });
    expect(JSON.stringify(chunked)).toBe(JSON.stringify(plain));
  });

  it('refuses a warehouse where per-chunk rows leaked into a parent table', () => {
    const leaked = `insert into commit_review_scope values ('s1','correctness-reviewer','CH1',16000,1);`;
    expect(() => mine(makeDb(PARENT_SCHEMA + PARENT_ROWS + leaked))).toThrow(/sc-2073/);
  });
});

describe('setHard (mine-telemetry indexes)', () => {
  it('indexes distinct keys and hard-errors on a duplicate instead of last-write-wins', () => {
    const m = new Map<string, string>();
    setHard(m, 's1::correctness-reviewer', 'fail', 'commit_reviews');
    setHard(m, 's2::correctness-reviewer', 'pass', 'commit_reviews');
    expect(m.size).toBe(2);
    expect(() => setHard(m, 's1::correctness-reviewer', 'pass', 'commit_reviews')).toThrow(
      /duplicate commit_reviews key s1::correctness-reviewer/,
    );
    expect(m.get('s1::correctness-reviewer')).toBe('fail');
  });
});
