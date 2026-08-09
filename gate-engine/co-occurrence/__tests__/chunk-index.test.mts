import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bodyPresence,
  canVerify,
  chunkBody,
  createVerifier,
  FRESH_RATIO,
  freshnessNotice,
  judgeBody,
  partitionFresh,
  verifierForIndex,
} from '../chunk-index.mts';

// The dup gate's evidence is an index it does not own: shared across concurrent ship worktrees,
// refreshed out of band, revertible under the gate. When it holds a PRE-change version of a file it
// names a symbol at a range where the file no longer defines it, and the only remedy it prints is an
// allowlist `add` — a permanent approval for a pair that does not co-exist. These tests pin the two
// halves of the fix: the body-tail comparison (unit), and the drop-only wiring through the real gate.

const here = dirname(fileURLToPath(import.meta.url));
const MATCHER = resolve(here, '..', 'matcher.mts');
const NOT_FOUND_ON_DISK_RE = /indexed body not found on disk/;
const NOT_VERIFIED_RE = /Freshness NOT verified/;

// A symbol as search-code stores it: an import PRELUDE (which survives an extract refactor
// untouched — the reason whole-raw_code comparison misses 17% of extractions) plus the BODY.
const PRELUDE = [
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  '',
];
const BODY = [
  'export function collectWidgetTotals(items) {',
  '  const totals = new Map();',
  '  for (const item of items) totals.set(item.identifier, item.value);',
  '  return totals;',
  '}',
];
const body = BODY.join('\n');
const rawCode = [...PRELUDE, ...BODY].join('\n');
// Chunk ranges are the SYMBOL's, not raw_code's: 5 lines of body starting wherever it starts.
const BODY_LOC = BODY.length;

describe('chunkBody — the prelude must be stripped', () => {
  it('returns only the last (end - start + 1) lines of raw_code', () => {
    expect(chunkBody(rawCode, 10, 10 + BODY_LOC - 1)).toBe(body);
  });

  it('clamps when the range is longer than raw_code (never throws, never pads)', () => {
    expect(chunkBody(rawCode, 1, 999)).toBe(rawCode);
  });

  it('normalizes CRLF so a Windows-written index compares against a LF working tree', () => {
    expect(chunkBody(rawCode.replace(/\n/g, '\r\n'), 10, 10 + BODY_LOC - 1)).toBe(body);
  });

  it('degrades to the whole of raw_code on a nonsensical range', () => {
    expect(chunkBody(rawCode, 10, 4)).toBe(rawCode);
  });

  it('is not shifted by a trailing newline in raw_code', () => {
    // "…}\n".split('\n') ends in an empty element; taking the tail window before stripping it drops
    // the body's first line (the declaration) and appends a blank — evidence off by one line, which
    // silently weakens every verdict computed from it.
    const withNewline = "import x from './x';\n\nfunction f() {\n  return 1;\n}\n";
    expect(chunkBody(withNewline, 3, 5)).toBe('function f() {\n  return 1;\n}');
    expect(chunkBody(`${withNewline}\n  \n`, 3, 5)).toBe('function f() {\n  return 1;\n}');
  });

  it('a trailing-newline body still verifies against the file it came from', () => {
    expect(judgeBody(chunkBody(`${rawCode}\n`, 10, 10 + BODY_LOC - 1), `x\n${body}\ny`)).toBe(
      'fresh',
    );
  });
});

describe('bodyPresence — alignment-based, indentation-agnostic', () => {
  it('scores 1 when the body is present verbatim', () => {
    expect(bodyPresence(body, `${PRELUDE.join('\n')}\n${body}\n`)).toBe(1);
  });

  it('scores 1 when the symbol merely MOVED and was re-indented (line drift is not staleness)', () => {
    const drifted = `${'// padding\n'.repeat(40)}${BODY.map((l) => `    ${l}`).join('\n')}\n`;
    expect(bodyPresence(body, drifted)).toBe(1);
  });

  it('scores ~0 for an EXTRACTED-AWAY symbol whose file kept its prelude', () => {
    // The reported failure, exactly: the body moved to a new file, the parent kept its imports and
    // gained one more. Whole-raw_code comparison scores this over the threshold; the body does not.
    const parent = `${PRELUDE.join('\n')}\nimport { collectWidgetTotals } from './totals';\n`;
    expect(bodyPresence(body, parent)).toBeLessThan(0.2);
  });

  it('scores 0 against an unrelated file', () => {
    expect(bodyPresence(body, 'const somethingEntirelyDifferent = 1;\n')).toBe(0);
  });

  it('is NOT fooled by a deleted symbol whose boilerplate lives on in sibling functions', () => {
    // Guard clauses are generic enough to recur verbatim. Scored as bare set-membership across the
    // whole file, this deleted 5-line body reaches 4/5 = 0.8 — over the threshold, symbol gone.
    // Requiring the lines to line up in ONE place is what closes it.
    const deleted = [
      'export function processRecord(record) {',
      '  if (!record) return null;',
      '  if (!record.value) return null;',
      '  if (!record.value.length) return null;',
      '  return record.value;',
      '}',
    ].join('\n');
    const siblings = [
      'export function readName(record) {',
      '  if (!record) return null;',
      '  return record.name;',
      '}',
      'export function readValue(record) {',
      '  if (!record.value) return null;',
      '  return record.value;',
      '}',
      'export function readFirst(record) {',
      '  if (!record.value.length) return null;',
      '  return record.value[0];',
      '}',
    ].join('\n');
    expect(bodyPresence(deleted, siblings)).toBeLessThan(FRESH_RATIO);
    expect(judgeBody(deleted, siblings)).toBe('stale');
  });

  it('still scores 1 when blank lines and short lines churn around an intact body', () => {
    const churned = `${BODY[0]}\n\n${BODY[1]}\n  })\n${BODY[2]}\n${BODY[3]}\n${BODY[4]}\n`;
    expect(bodyPresence(body, churned)).toBe(1);
  });

  it('returns -1 (no evidence) for a body with too few significant lines', () => {
    expect(bodyPresence('const a = 1;\n}\n', 'anything')).toBe(-1);
  });

  it('uses two aligned distinctive lines to disprove an extracted short helper (sc-1509)', () => {
    const helper = 'function fail(message: string): never {\n  throw new Error(message);\n}';
    const extractedParent = "import { fail } from './common';\n";
    expect(bodyPresence(helper, extractedParent)).toBe(-1);
    expect(judgeBody(helper, extractedParent)).toBe('stale');
    expect(judgeBody(helper, 'function fail(message: string): never {\n  return never;\n}')).toBe(
      'unverifiable',
    );
  });
});

describe('judgeBody — verbatim first, ratio as whitespace tolerance', () => {
  it('fresh when the body is a verbatim substring', () => {
    expect(judgeBody(body, `x\n${body}\ny`)).toBe('fresh');
  });

  it('fresh when only whitespace differs (ratio path)', () => {
    expect(judgeBody(body, BODY.map((l) => `\t${l}  `).join('\n'))).toBe('fresh');
  });

  it('stale when the body is gone from the file', () => {
    expect(judgeBody(body, `${PRELUDE.join('\n')}\nimport { x } from './x';\n`)).toBe('stale');
  });

  it('stale when the file could not be read (deleted / not in this checkout)', () => {
    expect(judgeBody(body, null)).toBe('stale');
  });

  it('unverifiable — never stale — when the body carries no scorable evidence', () => {
    expect(judgeBody('', 'whatever')).toBe('unverifiable');
    expect(judgeBody('const a = 1;\n}', 'unrelated file text')).toBe('unverifiable');
  });
});

describe('canVerify — an index that cannot be checked turns the layer off, it does not guess', () => {
  it('needs both raw_code and id', () => {
    expect(canVerify(['id', 'raw_code', 'file_path'])).toBe(true);
    expect(canVerify(['raw_code', 'file_path'])).toBe(false);
    expect(canVerify(['id', 'file_path'])).toBe(false);
    expect(canVerify([])).toBe(false);
  });
});

// A verifier over injected evidence — no sqlite, no disk.
function fakeVerifier(
  chunks: Record<number, { rawCode: string | null; startLine: number; endLine: number }>,
  files: Record<string, string | null>,
  columns = ['id', 'raw_code'],
) {
  const reads: string[] = [];
  const verifier = createVerifier({
    cwd: '/repo',
    columns,
    fetchChunk: (id) => chunks[id] ?? null,
    readFileText: (abs) => {
      reads.push(abs);
      return files[abs] ?? null;
    },
  });
  return { verifier, reads };
}

const chunkAt = (raw: string | null) => ({ rawCode: raw, startLine: 1, endLine: BODY_LOC });
const pair = (over = {}) => ({
  idA: 1,
  symbolA: 'collectWidgetTotals',
  fileA: 'src/alpha.ts',
  idB: 2,
  symbolB: 'collectWidgetTotals',
  fileB: 'src/beta.ts',
  ...over,
});

describe('createVerifier', () => {
  it('is disabled — everything unverifiable — on an index without raw_code/id', () => {
    const { verifier } = fakeVerifier({}, {}, ['file_path']);
    expect(verifier.enabled).toBe(false);
    expect(verifier.judge({ chunkId: 1, symbol: 's', file: 'src/alpha.ts' })).toBe('unverifiable');
  });

  it('unverifiable when the row carries no raw_code (a partially-populated index)', () => {
    const { verifier } = fakeVerifier({ 1: chunkAt(null) }, {});
    expect(verifier.judge({ chunkId: 1, symbol: 's', file: 'src/alpha.ts' })).toBe('unverifiable');
  });

  it('caches per path — one read for repeated sides', () => {
    const { verifier, reads } = fakeVerifier(
      { 1: chunkAt(rawCode), 2: chunkAt(rawCode) },
      { '/repo/src/alpha.ts': body },
    );
    verifier.judge({ chunkId: 1, symbol: 's', file: 'src/alpha.ts' });
    verifier.judge({ chunkId: 2, symbol: 't', file: 'src/alpha.ts' });
    expect(reads).toHaveLength(1);
  });

  it('blows the root-mismatch fuse when EVERY probed path is missing', () => {
    // An index rooted somewhere else (monorepo subdir, indexer run from the wrong cwd) would
    // otherwise drop every pair and take the gate permanently dark.
    const { verifier } = fakeVerifier({ 1: chunkAt(rawCode), 2: chunkAt(rawCode) }, {});
    const { fresh, dropped } = partitionFresh([pair()], verifier);
    expect(verifier.enabled).toBe(false);
    expect(dropped).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });
});

describe('verifierForIndex — a DB failure never becomes a block', () => {
  it('disables verification when the lookup statement cannot be prepared', () => {
    const v = verifierForIndex(
      {
        prepare: () => {
          throw new Error('database disk image is malformed');
        },
      },
      '/repo',
      ['id', 'raw_code'],
    );
    expect(v.enabled).toBe(false);
    expect(partitionFresh([pair()], v).dropped).toHaveLength(0);
  });

  it('treats a failing row read as unverifiable, not as stale', () => {
    const v = verifierForIndex(
      {
        prepare: () => ({
          get: () => {
            throw new Error('SQLITE_BUSY');
          },
          all: () => [],
        }),
      },
      '/repo',
      ['id', 'raw_code'],
    );
    expect(partitionFresh([pair()], v).fresh).toHaveLength(1);
  });
});

describe('partitionFresh — drop-only', () => {
  const fresh2 = { 1: chunkAt(rawCode), 2: chunkAt(rawCode) };

  it('keeps a pair whose both sides are on disk', () => {
    const { verifier } = fakeVerifier(fresh2, {
      '/repo/src/alpha.ts': body,
      '/repo/src/beta.ts': `zzz\n${body}`,
    });
    expect(partitionFresh([pair()], verifier).fresh).toHaveLength(1);
  });

  it('drops when EITHER side is gone, and names that side', () => {
    const { verifier } = fakeVerifier(fresh2, {
      '/repo/src/alpha.ts': `${PRELUDE.join('\n')}\nimport { collectWidgetTotals } from './b';\n`,
      '/repo/src/beta.ts': body,
    });
    const { fresh, dropped } = partitionFresh([pair()], verifier);
    expect(fresh).toHaveLength(0);
    expect(dropped[0].stale.map((s) => s.file)).toEqual(['src/alpha.ts']);
  });

  it('keeps a pair one of whose sides is merely unverifiable', () => {
    const { verifier } = fakeVerifier(
      { 1: chunkAt(rawCode), 2: chunkAt(null) },
      { '/repo/src/alpha.ts': body },
    );
    expect(partitionFresh([pair()], verifier).fresh).toHaveLength(1);
  });

  it('never returns more pairs than it received (it can only turn a block into a pass)', () => {
    const { verifier } = fakeVerifier(fresh2, { '/repo/src/alpha.ts': body });
    const pairs = [pair(), pair({ fileB: 'src/gamma.ts' })];
    const { fresh, dropped } = partitionFresh(pairs, verifier);
    expect(fresh.length + dropped.length).toBeLessThanOrEqual(pairs.length);
    expect(fresh.length).toBeLessThanOrEqual(pairs.length);
  });
});

describe('freshnessNotice', () => {
  const dropped = [
    { pair: pair(), stale: [{ chunkId: 1, symbol: 'collectWidgetTotals', file: 'src/alpha.ts' }] },
  ];

  it('names every dropped side and points at re-indexing', () => {
    const text = freshnessNotice(dropped, { verified: true, blocking: false }).join('\n');
    expect(text).toContain('collectWidgetTotals');
    expect(text).toContain('src/alpha.ts');
    expect(text).toMatch(/Re-index/);
  });

  it('NEVER offers the allowlist command as the remedy for a stale pair', () => {
    // Approving a pair that does not co-exist writes a falsehood into the allowlist — the exact
    // trap the reported incident fell into. A caller scanning output for a paste-able `add` must
    // not find one here.
    const text = freshnessNotice(dropped, { verified: false, blocking: true }).join('\n');
    expect(text).not.toContain('guard-dup-allowlist add ');
    expect(text).not.toContain(' add "');
  });

  it('says so when a block was decided on unverified evidence', () => {
    expect(freshnessNotice([], { verified: false, blocking: true }).join('\n')).toMatch(
      NOT_VERIFIED_RE,
    );
    expect(freshnessNotice([], { verified: true, blocking: true })).toEqual([]);
    expect(freshnessNotice([], { verified: false, blocking: false })).toEqual([]);
  });
});

// ── End-to-end through the real gate ────────────────────────────────────────────────────────────
// A fixture index carrying the REAL column set (id + raw_code) plus a real working tree as cwd, so
// the whole path runs: PRAGMA probe → id in the SELECT → rowid lookup → body compare → exit code.

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const emb = () => Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);

interface Chunk {
  file: string;
  symbol: string;
  startLine: number;
  raw: string;
}

/** A working tree + an index over it, wired so the pair is an exact-tier (same hash) cross-file dup. */
function scenario(files: Record<string, string>, chunks: Chunk[]) {
  const dir = mkdtempSync(join(tmpdir(), 'dup-freshness-'));
  tmpRoots.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const dbPath = join(dir, 'index.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, raw_code TEXT, embedding BLOB, code_embedding BLOB)',
  );
  const ins = db.prepare(
    'INSERT INTO chunks (file_path, symbol_name, start_line, end_line, code_hash, raw_code, embedding, code_embedding) VALUES (?,?,?,?,?,?,?,?)',
  );
  for (const c of chunks) {
    ins.run(
      c.file,
      c.symbol,
      c.startLine,
      c.startLine + BODY_LOC - 1,
      'SAME_HASH',
      c.raw,
      emb(),
      emb(),
    );
  }
  db.close();
  writeFileSync(join(dir, 'allowlist.json'), JSON.stringify({ pairs: [], clones: [] }));
  return { dir, dbPath };
}

/** Run the gate inside a scenario; return its exit code and stdout. */
function gate(
  s: { dir: string; dbPath: string },
  changed: string,
  env: Record<string, string> = {},
) {
  const opts = {
    cwd: s.dir,
    env: {
      ...process.env,
      SEARCH_CODE_DB: s.dbPath,
      CO_OCCURRENCE_ALLOWLIST: join(s.dir, 'allowlist.json'),
      MATCHER_CHANGED_FILES: changed,
      ...env,
    },
    encoding: 'utf8' as const,
  };
  try {
    return {
      status: 0,
      stdout: execFileSync('node', [MATCHER, 'scan', '--new', '--changed', '--gate'], opts),
    };
  } catch (e) {
    return { status: e.status as number, stdout: `${e.stdout ?? ''}` };
  }
}

const dupChunk = (file: string, startLine = 1): Chunk => ({
  file,
  symbol: 'collectWidgetTotals',
  startLine,
  raw: rawCode,
});
// The parent AFTER an extract refactor: prelude intact, body gone, an import of the new file added.
const extractedParent = `${PRELUDE.join('\n')}\nimport { collectWidgetTotals } from './beta';\n`;
const fileWithBody = `${PRELUDE.join('\n')}\n${body}\n`;

describe('dup gate vs a stale index (the reported failure)', () => {
  it('does NOT block on a symbol the working file no longer defines', () => {
    const s = scenario({ 'src/alpha.ts': extractedParent, 'src/beta.ts': fileWithBody }, [
      dupChunk('src/alpha.ts'),
      dupChunk('src/beta.ts'),
    ]);
    const { status, stdout } = gate(s, 'src/alpha.ts,src/beta.ts');
    expect(status).toBe(0);
    expect(stdout).toMatch(NOT_FOUND_ON_DISK_RE);
    expect(stdout).toContain('src/alpha.ts');
    // and it must not hand over the remedy that would record the falsehood permanently
    expect(stdout).not.toContain('guard-dup-allowlist add ');
  });

  it('still BLOCKS a real dup whose code is on disk (the fix must not gut the gate)', () => {
    const s = scenario({ 'src/alpha.ts': fileWithBody, 'src/beta.ts': fileWithBody }, [
      dupChunk('src/alpha.ts'),
      dupChunk('src/beta.ts'),
    ]);
    const { status, stdout } = gate(s, 'src/alpha.ts');
    expect(status).toBe(1);
    expect(stdout).toContain('add "collectWidgetTotals"');
    expect(stdout).not.toMatch(NOT_VERIFIED_RE);
  });

  it('does not drop on LINE DRIFT — a symbol pushed down the file is still real', () => {
    // The index says lines 1-5; on disk the body sits 40 lines lower. Comparing at the recorded
    // range would call this stale and the gate would go quiet on ordinary commits.
    const drifted = `${'// padding\n'.repeat(40)}${body}\n`;
    const s = scenario({ 'src/alpha.ts': drifted, 'src/beta.ts': fileWithBody }, [
      dupChunk('src/alpha.ts'),
      dupChunk('src/beta.ts'),
    ]);
    expect(gate(s, 'src/alpha.ts').status).toBe(1);
  });

  it('drops a pair whose file no longer exists at all', () => {
    const s = scenario({ 'src/beta.ts': fileWithBody }, [
      dupChunk('src/gone.ts'),
      dupChunk('src/beta.ts'),
    ]);
    const { status, stdout } = gate(s, 'src/beta.ts');
    expect(status).toBe(0);
    expect(stdout).toContain('src/gone.ts');
  });

  it('keeps blocking, with a caveat, when NO indexed path resolves here (root-mismatch fuse)', () => {
    const s = scenario({ 'unrelated.ts': 'x\n' }, [
      dupChunk('elsewhere/alpha.ts'),
      dupChunk('elsewhere/beta.ts'),
    ]);
    const { status, stdout } = gate(s, 'elsewhere/alpha.ts');
    expect(status).toBe(1);
    expect(stdout).toMatch(NOT_VERIFIED_RE);
  });

  it('GUARD_DUP_VERIFY_TREE=0 restores the unverified behaviour, and says the block is unverified', () => {
    const s = scenario({ 'src/alpha.ts': extractedParent, 'src/beta.ts': fileWithBody }, [
      dupChunk('src/alpha.ts'),
      dupChunk('src/beta.ts'),
    ]);
    const { status, stdout } = gate(s, 'src/alpha.ts', { GUARD_DUP_VERIFY_TREE: '0' });
    expect(status).toBe(1);
    expect(stdout).toMatch(NOT_VERIFIED_RE);
  });

  it('a legacy index without raw_code/id still blocks (verification never fails a gate closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dup-legacy-'));
    tmpRoots.push(dir);
    const dbPath = join(dir, 'index.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
    );
    const ins = db.prepare(
      'INSERT INTO chunks (file_path, symbol_name, start_line, end_line, code_hash, embedding, code_embedding) VALUES (?,?,?,?,?,?,?)',
    );
    ins.run('src/alpha.ts', 'legacyDupA', 1, 10, 'SAME_HASH', emb(), emb());
    ins.run('src/beta.ts', 'legacyDupB', 1, 10, 'SAME_HASH', emb(), emb());
    db.close();
    writeFileSync(join(dir, 'allowlist.json'), JSON.stringify({ pairs: [], clones: [] }));
    const { status, stdout } = gate({ dir, dbPath }, 'src/alpha.ts');
    expect(status).toBe(1);
    expect(stdout).toMatch(NOT_VERIFIED_RE);
  });
});
