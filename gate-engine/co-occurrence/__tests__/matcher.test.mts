import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The gate's exit-code contract is what a pre-commit hook depends on — a flipped
// code silently bricks every commit or stops blocking dups. Pin it with a fixture
// index (SEARCH_CODE_DB seam) so the test is deterministic, no real index needed.
//   1 = new dups found → block · 0 = clean → allow · 2 = could-not-run → fail-open.

const here = dirname(fileURLToPath(import.meta.url));
const MATCHER = resolve(here, '..', 'matcher.mts');
const SIMILARITY_1_RE = /--similarity 1\b/;

let tmp: string;
let dbPath: string;

// 4-dim Float32 blob — any non-null value; the `exact` tier keys on code_hash, not
// the embedding, so identical hashes flag regardless of the vectors.
const emb = () => Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'matcher-fixture-'));
  dbPath = join(tmp, 'index.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
  );
  const ins = db.prepare(
    'INSERT INTO chunks (file_path, symbol_name, start_line, end_line, code_hash, embedding, code_embedding) VALUES (?,?,?,?,?,?,?)',
  );
  // Two files, identical code_hash → an exact-tier cross-file dup. Fake symbols so
  // it's never in the real allowlist → always surfaces as "new".
  ins.run('src/fixtureA.ts', 'fixtureDupA', 1, 10, 'SAME_HASH', emb(), emb());
  ins.run('src/fixtureB.ts', 'fixtureDupB', 1, 10, 'SAME_HASH', emb(), emb());
  db.close();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Run the gate against the fixture; return the process exit code.
function gate(env) {
  try {
    execFileSync('node', [MATCHER, 'scan', '--new', '--changed', '--gate'], {
      env: { SEARCH_CODE_DB: dbPath, MATCHER_CHANGED_FILES: '', ...process.env, ...env },
      stdio: 'pipe',
    });
    return 0;
  } catch (e) {
    return e.status;
  }
}

describe('matcher --gate exit-code contract', () => {
  it('exit 1 — a staged file introduces a new dup (block)', () => {
    expect(gate({ SEARCH_CODE_DB: dbPath, MATCHER_CHANGED_FILES: 'src/fixtureA.ts' })).toBe(1);
  });

  it('exit 0 — empty changed set, nothing scoped in (allow)', () => {
    expect(gate({ SEARCH_CODE_DB: dbPath, MATCHER_CHANGED_FILES: '' })).toBe(0);
  });

  it('exit 0 — staged files touch no dup (clean)', () => {
    expect(gate({ SEARCH_CODE_DB: dbPath, MATCHER_CHANGED_FILES: 'src/unrelated.ts' })).toBe(0);
  });

  it('parses comma- and newline-separated MATCHER_CHANGED_FILES', () => {
    expect(
      gate({ SEARCH_CODE_DB: dbPath, MATCHER_CHANGED_FILES: 'src/fixtureA.ts,src/x.ts' }),
    ).toBe(1);
    expect(
      gate({ SEARCH_CODE_DB: dbPath, MATCHER_CHANGED_FILES: 'src/y.ts\nsrc/fixtureB.ts' }),
    ).toBe(1);
  });

  it('exit 2 — missing index fails open (never bricks a commit)', () => {
    expect(gate({ SEARCH_CODE_DB: join(tmp, 'nonexistent.db'), MATCHER_CHANGED_FILES: '' })).toBe(
      2,
    );
  });

  it('prints a pre-filled approval command (symbols + similarity + ranges) on block', () => {
    let stdout = '';
    try {
      execFileSync('node', [MATCHER, 'scan', '--new', '--changed', '--gate'], {
        env: {
          ...process.env,
          SEARCH_CODE_DB: dbPath,
          MATCHER_CHANGED_FILES: 'src/fixtureA.ts',
          CO_OCCURRENCE_ALLOWLIST: '/nonexistent/empty.json', // missing → empty → pair is novel
        },
        encoding: 'utf8',
      });
    } catch (e) {
      stdout = `${e.stdout ?? ''}`;
    }
    // The whole point: an approved entry keeps its metadata because the agent pastes THIS.
    expect(stdout).toContain('add "fixtureDupA" "src/fixtureA.ts" "fixtureDupB" "src/fixtureB.ts"');
    expect(stdout).toMatch(SIMILARITY_1_RE);
    expect(stdout).toContain('--range-a 1-10');
    expect(stdout).toContain('--range-b 1-10');
  });
});

// No index configured at all (config indexPath null + no SEARCH_CODE_DB) is the common
// case in a repo without search-code: the matcher must OPT OUT — fail open (exit 2), not
// crash. We assert exit 2 by deliberately unsetting every index source.
describe('matcher no-index opt-out (W-3 portability)', () => {
  it('exit 2 — no index configured anywhere fails open gracefully (no crash)', () => {
    const env = { ...process.env, MATCHER_CHANGED_FILES: '' };
    // Force every index source empty: no SEARCH_CODE_DB, no GUARD_INDEX_PATH/FRINK_INDEX_PATH.
    delete env.SEARCH_CODE_DB;
    delete env.GUARD_INDEX_PATH;
    delete env.FRINK_INDEX_PATH;
    let status = 0;
    let stderr = '';
    try {
      execFileSync('node', [MATCHER, 'scan', '--new', '--changed', '--gate'], {
        env,
        // cwd is a fresh empty tmp dir with no guard.config.json → indexPath default (null).
        cwd: tmp,
        encoding: 'utf8',
      });
    } catch (e) {
      status = e.status;
      stderr = `${e.stderr ?? ''}`;
    }
    expect(status).toBe(2);
    expect(stderr).toContain('no search-code index configured');
  });
});

// reconcile drops allowlist pairs detect() no longer produces (dead entries). The fixture
// index emits exactly one pair (fixtureDupA <> fixtureDupB), so any other allowlist entry
// is "dead". The CO_OCCURRENCE_ALLOWLIST seam points at a throwaway file per test.
const DETECTED = {
  symbolA: 'fixtureDupA',
  fileA: 'src/fixtureA.ts',
  rangeA: '1-10',
  symbolB: 'fixtureDupB',
  fileB: 'src/fixtureB.ts',
  rangeB: '1-10',
  similarity: 1,
  description: 'baseline 2020-01-01 — frozen',
  date: '2020-01-01',
  decayDays: 3650,
};
const DEAD = {
  ...DETECTED,
  symbolA: 'goneX',
  fileA: 'src/gone-x.ts',
  symbolB: 'goneY',
  fileB: 'src/gone-y.ts',
};
const CLONES = [
  { fragmentHash: 'deadbeefdeadbeef', fileA: 'x', fileB: 'y', date: '2020-01-01', decayDays: 3650 },
];
const DROP_GONE_RE = /drop\s+goneX/;
const DRY_RUN_RE = /Dry run/;

function reconcile(alPath, args, env) {
  try {
    const stdout = execFileSync('node', [MATCHER, 'reconcile', ...args], {
      env: {
        SEARCH_CODE_DB: dbPath,
        MATCHER_CHANGED_FILES: '',
        ...process.env,
        CO_OCCURRENCE_ALLOWLIST: alPath,
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status, stdout: `${e.stdout ?? ''}` };
  }
}

describe('matcher reconcile', () => {
  it('--apply keeps the detected pair, drops a dead one, preserves clones[]', () => {
    const al = join(tmp, 'reconcile-apply.json');
    writeFileSync(al, JSON.stringify({ pairs: [DETECTED, DEAD], clones: CLONES }));
    expect(reconcile(al, ['--apply']).status).toBe(0);
    const after = JSON.parse(readFileSync(al, 'utf8'));
    expect(after.pairs).toHaveLength(1);
    expect(after.pairs[0].symbolA).toBe('fixtureDupA');
    expect(after.clones).toEqual(CLONES); // clones array untouched
  });

  it('keeps the original date/decayDays on kept entries (remove-only, no refreeze)', () => {
    const al = join(tmp, 'reconcile-nodatereset.json');
    writeFileSync(al, JSON.stringify({ pairs: [DETECTED, DEAD], clones: [] }));
    reconcile(al, ['--apply']);
    const after = JSON.parse(readFileSync(al, 'utf8'));
    expect(after.pairs[0].date).toBe('2020-01-01');
    expect(after.pairs[0].decayDays).toBe(3650);
  });

  it('dry-run (no --apply) leaves the file byte-identical and prints the drop', () => {
    const al = join(tmp, 'reconcile-dryrun.json');
    const before = JSON.stringify({ pairs: [DETECTED, DEAD], clones: CLONES });
    writeFileSync(al, before);
    const { status, stdout } = reconcile(al, []);
    expect(status).toBe(0);
    expect(readFileSync(al, 'utf8')).toBe(before); // unchanged
    expect(stdout).toMatch(DROP_GONE_RE);
    expect(stdout).toMatch(DRY_RUN_RE);
  });

  it('missing index exits 2 and never writes (no wipe)', () => {
    const al = join(tmp, 'reconcile-noindex.json');
    const before = JSON.stringify({ pairs: [DETECTED, DEAD], clones: CLONES });
    writeFileSync(al, before);
    expect(reconcile(al, ['--apply'], { SEARCH_CODE_DB: join(tmp, 'nonexistent.db') }).status).toBe(
      2,
    );
    expect(readFileSync(al, 'utf8')).toBe(before);
  });

  it('empty index exits 0 and never writes (no wipe)', () => {
    const emptyDb = join(tmp, 'empty.db');
    const edb = new DatabaseSync(emptyDb);
    edb.exec(
      'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
    );
    edb.close();
    const al = join(tmp, 'reconcile-emptyindex.json');
    const before = JSON.stringify({ pairs: [DETECTED, DEAD], clones: CLONES });
    writeFileSync(al, before);
    expect(reconcile(al, ['--apply'], { SEARCH_CODE_DB: emptyDb }).status).toBe(0);
    expect(readFileSync(al, 'utf8')).toBe(before);
  });

  // A corrupt allowlist (truncated write, merge-conflict markers) must NOT be treated as
  // empty and overwritten — that would silently wipe every baselined pair. loadAllowlist
  // refuses (exit 2) on a corrupt-but-present file; reconcile inherits that.
  it('refuses to overwrite a malformed allowlist — no silent wipe (exit 2)', () => {
    const al = join(tmp, 'reconcile-malformed.json');
    const before = '{ "pairs": [ {"symbolA": "x"  <<<<<<< merge conflict garbage';
    writeFileSync(al, before);
    expect(reconcile(al, ['--apply']).status).toBe(2);
    expect(readFileSync(al, 'utf8')).toBe(before); // untouched
  });

  // Valid JSON that isn't an object (`null`, a number — a garbage write landing on parseable
  // JSON) must also refuse (exit 2), not crash on `v.pairs` → exit 1 = false-block.
  it('refuses a valid-JSON-but-non-object allowlist (null) — exit 2, no crash', () => {
    const al = join(tmp, 'reconcile-null.json');
    writeFileSync(al, 'null');
    expect(reconcile(al, ['--apply']).status).toBe(2);
    expect(readFileSync(al, 'utf8')).toBe('null'); // untouched
  });

  // Nothing dead (every allowlist pair still detected) → reconcile must not rewrite the file,
  // so a no-op run never churns mtime or produces a spurious diff.
  it('--apply with no dead entries leaves the file byte-identical (no-op write-skip)', () => {
    const al = join(tmp, 'reconcile-noop.json');
    const before = JSON.stringify({ pairs: [DETECTED], clones: CLONES });
    writeFileSync(al, before);
    expect(reconcile(al, ['--apply']).status).toBe(0);
    expect(readFileSync(al, 'utf8')).toBe(before); // untouched
  });

  // A human allowlist `add` can store a pair with A/B in the opposite order from the
  // matcher's orderKey. symFileKey sorts both sides, so reconcile must KEEP it — dropping it
  // would re-surface a live, intentional approval and false-block the next commit.
  it('keeps a detected pair stored with A/B reversed (symFileKey is order-insensitive)', () => {
    const al = join(tmp, 'reconcile-reversed.json');
    const reversed = {
      ...DETECTED,
      symbolA: 'fixtureDupB',
      fileA: 'src/fixtureB.ts',
      symbolB: 'fixtureDupA',
      fileB: 'src/fixtureA.ts',
    };
    writeFileSync(al, JSON.stringify({ pairs: [reversed], clones: [] }));
    expect(reconcile(al, ['--apply']).status).toBe(0);
    expect(JSON.parse(readFileSync(al, 'utf8')).pairs).toHaveLength(1); // kept, not dropped
  });
});

function runMatcher(args, env) {
  try {
    execFileSync('node', [MATCHER, ...args], {
      env: { SEARCH_CODE_DB: dbPath, MATCHER_CHANGED_FILES: '', ...process.env, ...env },
      stdio: 'pipe',
    });
    return 0;
  } catch (e) {
    return e.status;
  }
}

// The corrupt-allowlist guard lives in loadAllowlist(), so EVERY destructive mode inherits it —
// not just reconcile. baseline + backfill-ranges must refuse too.
describe('matcher destructive modes refuse a corrupt allowlist', () => {
  const CORRUPT = '{ "pairs": [ {"symbolA": <<<<<<< merge';
  for (const mode of ['baseline', 'backfill-ranges']) {
    it(`${mode} → exit 2, file untouched`, () => {
      const al = join(tmp, `corrupt-${mode}.json`);
      writeFileSync(al, CORRUPT);
      expect(runMatcher([mode], { CO_OCCURRENCE_ALLOWLIST: al })).toBe(2);
      expect(readFileSync(al, 'utf8')).toBe(CORRUPT);
    });
  }
});

// Path keys must be OS-agnostic: a Windows index storing `\` must still match the allowlist's
// `/` and the `/`-style staged set git emits. The matcher normalizes file_path at the read
// boundary — pin it with a backslash-path fixture index.
describe('matcher path normalization', () => {
  let winDb: string;
  beforeAll(() => {
    winDb = join(tmp, 'win-index.db');
    const db = new DatabaseSync(winDb);
    db.exec(
      'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, start_line INTEGER, end_line INTEGER, code_hash TEXT, embedding BLOB, code_embedding BLOB)',
    );
    const ins = db.prepare(
      'INSERT INTO chunks (file_path, symbol_name, start_line, end_line, code_hash, embedding, code_embedding) VALUES (?,?,?,?,?,?,?)',
    );
    // Backslash paths (as a Windows index might store) → an exact-tier cross-file dup.
    ins.run('src\\winA.ts', 'winDupA', 1, 10, 'WIN_HASH', emb(), emb());
    ins.run('src\\winB.ts', 'winDupB', 1, 10, 'WIN_HASH', emb(), emb());
    db.close();
  });

  it('symFileKey matches a forward-slash allowlist entry → reconcile keeps it (not over-dropped)', () => {
    const al = join(tmp, 'win-allowlist.json');
    // Allowlist stored with forward slashes (the only format on disk). If file_path weren't
    // normalized, the detected pair's key would be backslash → no match → wrongly dropped.
    writeFileSync(
      al,
      JSON.stringify({
        pairs: [
          {
            symbolA: 'winDupA',
            fileA: 'src/winA.ts',
            symbolB: 'winDupB',
            fileB: 'src/winB.ts',
            similarity: 1,
            description: 'x',
            date: '2020-01-01',
            decayDays: 3650,
          },
        ],
        clones: [],
      }),
    );
    expect(reconcile(al, ['--apply'], { SEARCH_CODE_DB: winDb }).status).toBe(0);
    expect(JSON.parse(readFileSync(al, 'utf8')).pairs).toHaveLength(1); // kept
  });

  it('--changed --gate matches the /-style staged set against a \\-style index (exit 1)', () => {
    // git emits 'src/winA.ts'; the index has 'src\\winA.ts'. Without normalization the
    // changed.has() compare misses → pair out of scope → silent fail-open (exit 0).
    const emptyAl = join(tmp, 'win-gate-allowlist.json'); // isolate from the real allowlist
    writeFileSync(emptyAl, JSON.stringify({ pairs: [], clones: [] }));
    expect(
      runMatcher(['scan', '--new', '--changed', '--gate'], {
        SEARCH_CODE_DB: winDb,
        MATCHER_CHANGED_FILES: 'src/winA.ts',
        CO_OCCURRENCE_ALLOWLIST: emptyAl,
      }),
    ).toBe(1);
  });
});
