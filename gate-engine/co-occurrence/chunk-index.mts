/**
 * Everything that reads the search-code `chunks` table: the row shape, the embedding-blob math the
 * matcher's pair sweep runs on, and — the reason this module exists — the WORKING-TREE FRESHNESS
 * check that decides whether an indexed chunk still describes code that is actually on disk.
 *
 * ── Why a gate needs this ────────────────────────────────────────────────────────────────────────
 * The dup gate's whole evidence base is an index it does not own. That index is shared (a ship
 * worktree symlinks the primary checkout's copy — the documented way to gate there), refreshed out
 * of band, and can be reverted under the gate by any concurrent writer. When it holds a PRE-change
 * version of a file, the matcher reports a symbol at a line range where the file no longer defines
 * it, and the only remedy it prints is an allowlist `add` — which would record a permanent approval
 * for a pair that does not co-exist. Re-indexing from inside the gate is not an option: through a
 * symlinked index it overwrites the PRIMARY checkout's rows (see index-refresh.mts). So the gate
 * verifies instead: every pair it reports must be backed by code that is in the working tree.
 *
 * ── Why the body TAIL, not raw_code ──────────────────────────────────────────────────────────────
 * search-code's `raw_code` is the file's import prelude PLUS the symbol body (prelude median 18
 * lines, p90 37 on this repo). The prelude survives an extract refactor untouched, so comparing
 * whole raw_code judges a symbol "still here" purely on its neighbours' imports: measured over 898
 * chunks with the symbol's lines deleted from its file, whole-raw_code called 17% of them FRESH —
 * one false block in six survives. The body is exactly the LAST (endLine - startLine + 1) lines of
 * raw_code; on that slice the same simulation leaves 0.2%.
 *
 * ── Why "anywhere in the file", not "at the recorded range" ──────────────────────────────────────
 * Comparing at start_line..end_line is sharper still, and would be wrong: adding a line ABOVE a
 * symbol shifts every range below it, and the gate would go quiet on ordinary commits. Line drift
 * must stay invisible; only the disappearance of the code itself is evidence of staleness.
 *
 * Every verdict here can only DROP a reported pair, never add one — see partitionFresh.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Index row shape (moved from matcher.mts — this module owns the chunks-table boundary) ────────
// One sqlite output column. Mirrors node:sqlite's (non-exported) SQLOutputValue so a `.all()` row
// (Record<string, SqlValue>) asserts to ChunkRow at the DB-read boundary.
export type SqlValue = null | number | bigint | string | NodeJS.NonSharedUint8Array;
// A row of the search-code `chunks` table (external DB data). file_path is normalized in place by
// the matcher; `id` is present only when the index carries it (see canVerify).
export interface ChunkRow {
  // Index signature mirrors the sqlite row type (Record<string, SqlValue>) so the .all() result
  // asserts to ChunkRow[] without laundering through `unknown`; the named columns refine the
  // specific fields the matcher reads.
  [column: string]: SqlValue;
  file_path: string;
  symbol_name: string;
  start_line: number;
  end_line: number;
  code_hash: string;
  // BLOB columns — sqlite returns these as NonSharedUint8Array (matches SQLOutputValue, so the
  // `.all()` result casts to ChunkRow[] cleanly). decode() reads them as Uint8Array.
  embedding: NodeJS.NonSharedUint8Array;
  code_embedding: NodeJS.NonSharedUint8Array;
}

// ── Embedding math (moved from matcher.mts, unchanged except dot()'s explicit dim) ───────────────
export function decode(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
export function normInto(v: Float32Array, target: Float32Array, base: number): void {
  let s = 0;
  for (let k = 0; k < v.length; k++) s += v[k] * v[k];
  s = Math.sqrt(s) || 1;
  for (let k = 0; k < v.length; k++) target[base + k] = v[k] / s;
}
export function dot(a: Float32Array, ba: number, b: Float32Array, bb: number, dim: number): number {
  let s = 0;
  for (let k = 0; k < dim; k++) s += a[ba + k] * b[bb + k];
  return s;
}

/**
 * The two L2-normalized vector matrices the pair sweep dots against, flattened into one Float32Array
 * each (row i occupies [i*dim, i*dim+dim)) so a comparison is a plain offset walk with no per-row
 * allocation. Dimension comes from the first row — the index is single-model by construction.
 */
export function buildVectors(rows: readonly ChunkRow[]): {
  dim: number;
  codeV: Float32Array;
  descV: Float32Array;
} {
  const dim = decode(rows[0].code_embedding).length;
  const codeV = new Float32Array(rows.length * dim);
  const descV = new Float32Array(rows.length * dim);
  for (let i = 0; i < rows.length; i++) {
    normInto(decode(rows[i].code_embedding), codeV, i * dim);
    normInto(decode(rows[i].embedding), descV, i * dim);
  }
  return { dim, codeV, descV };
}

// ── Freshness ────────────────────────────────────────────────────────────────────────────────────
/** Ratio floor for the whitespace-tolerance fallback. Only ever adjudicates reformats: the verbatim
 *  stage already separates fresh (1112/1112) from wrong-file (11/1107), and self-p1 there is 1.00. */
export const FRESH_RATIO = 0.8;
/** A line short enough to be punctuation/boilerplate (`}`, `};`, `return;`) carries no evidence. */
const SIG_LINE_MIN_LEN = 12;
/** Below this, the ordinary ratio is too coarse; judgeBody handles exactly two lines separately. */
const MIN_BODY_SIG_LINES = 3;
/** A file this large is a generated blob, not something the matcher should hold in memory twice. */
const MAX_FILE_BYTES = 2_000_000;
// Hoisted per useTopLevelRegex — every comparison below normalizes line endings first, because the
// index may have been written on Windows and the file read here is whatever is on this disk.
const CRLF_RE = /\r\n/g;
// Trailing blank lines — stripped before any tail window is taken (see chunkBody).
const TRAILING_BLANK_RE = /\s*\n\s*$/;

/** fresh = the code is on disk · stale = it is not · unverifiable = no usable evidence either way. */
export type Freshness = 'fresh' | 'stale' | 'unverifiable';

/**
 * The symbol body: the last `endLine - startLine + 1` lines of raw_code, with search-code's import
 * prelude dropped. Clamped (a body longer than raw_code yields the whole of it) and CRLF-normalized,
 * because the comparison target is a file read as-is from disk.
 *
 * Trailing blank lines are stripped BEFORE the tail window is taken. `"…}\n".split('\n')` yields a
 * final empty element, which would shift the window by one — dropping the body's real first line
 * (usually the declaration) and appending a blank. The verdict would then be computed from evidence
 * that is off by a line: no false block (the layer only drops) but a silently weakened gate.
 */
export function chunkBody(rawCode: string, startLine: number, endLine: number): string {
  const text = rawCode.replace(CRLF_RE, '\n').replace(TRAILING_BLANK_RE, '');
  const loc = endLine - startLine + 1;
  if (!Number.isFinite(loc) || loc <= 0) return text;
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - loc)).join('\n');
}

/** Trimmed lines long enough to be distinctive. Trimming is what makes the ratio re-indent-proof. */
export function significantLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= SIG_LINE_MIN_LEN);
}

function alignedPresence(wanted: readonly string[], have: readonly string[]): number {
  let best = 0;
  for (let offset = 0; offset <= Math.max(0, have.length - wanted.length); offset++) {
    let hits = 0;
    for (let i = 0; i < wanted.length; i++) if (have[offset + i] === wanted[i]) hits++;
    if (hits > best) best = hits;
    if (best === wanted.length) break;
  }
  return best / wanted.length;
}

/**
 * How much of the body survives IN ONE PLACE in the file: the best score over every aligned window
 * of the file's significant lines. -1 when the body is too small to score — the caller must read
 * that as "no evidence", never as "absent".
 *
 * Alignment is the point. Scoring bare set-membership across the whole file lets a DELETED symbol
 * score fresh purely on boilerplate: four guard clauses like `if (!record) return null;` living on
 * in four unrelated sibling functions are 4/5 of a five-line body, over the threshold, with the
 * symbol itself gone. Requiring the lines to line up contiguously keeps exactly the tolerance this
 * path is for — re-indentation (lines are trimmed) and blank/short-line churn (they are filtered out
 * of both sides) — while a body scattered across the file scores at most one accidental hit.
 */
export function bodyPresence(body: string, fileText: string): number {
  const wanted = significantLines(body);
  if (wanted.length < MIN_BODY_SIG_LINES) return -1;
  const have = significantLines(fileText.replace(CRLF_RE, '\n'));
  return alignedPresence(wanted, have);
}

/**
 * Verbatim first (no threshold, and it is what fires ~100% of the time on a fresh index), then the
 * ratio as whitespace tolerance. A body with no significant content, or a body we cannot score, is
 * UNVERIFIABLE — biasing small chunks toward being reported, which is the safe direction for a
 * filter that can only drop. A file that could not be read is STALE: a deleted file, or one absent
 * from this checkout, is exactly the evidence gap this exists to catch.
 */
export function judgeBody(body: string, fileText: string | null): Freshness {
  if (body.trim() === '') return 'unverifiable';
  if (fileText == null) return 'stale';
  const normalized = fileText.replace(CRLF_RE, '\n');
  if (normalized.includes(body)) return 'fresh';
  const wanted = significantLines(body);
  if (wanted.length === 2) {
    const ratio = alignedPresence(wanted, significantLines(normalized));
    if (ratio === 0) return 'stale';
    return ratio === 1 ? 'fresh' : 'unverifiable';
  }
  const ratio = bodyPresence(body, normalized);
  if (ratio < 0) return 'unverifiable';
  return ratio >= FRESH_RATIO ? 'fresh' : 'stale';
}

/**
 * Verification needs `raw_code` (the evidence) and `id` (the only lookup key that survives the
 * matcher's `\`→`/` path normalization — a path-keyed WHERE misses on a Windows-written index).
 * An index carrying neither turns the whole layer off rather than guessing.
 */
export function canVerify(columns: readonly string[]): boolean {
  return columns.includes('raw_code') && columns.includes('id');
}

/** One side of a reported pair, as the verifier needs it. */
export interface ChunkRef {
  chunkId: number;
  symbol: string;
  file: string;
}
/** The chunk's stored evidence, as fetched from the index by rowid. */
export interface StoredChunk {
  rawCode: string | null;
  startLine: number;
  endLine: number;
}
export interface VerifierDeps {
  /** Consumer cwd — repo-relative `file_path` values resolve against this. */
  cwd: string;
  /** Column names from `PRAGMA table_info(chunks)`. */
  columns: readonly string[];
  fetchChunk: (chunkId: number) => StoredChunk | null;
  /** Injected by tests; the default reads from disk. null = unreadable. Cached by the verifier. */
  readFileText?: (absPath: string) => string | null;
}
export interface Verifier {
  /** False when the index cannot be verified, or when the root-mismatch fuse has blown. */
  readonly enabled: boolean;
  judge(ref: ChunkRef): Freshness;
}

function readFromDisk(absPath: string): string | null {
  try {
    return statSync(absPath).size > MAX_FILE_BYTES ? null : readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Read-through cache: both sides of many pairs land on the same handful of files. */
function cachedReader(read: (absPath: string) => string | null) {
  const cache = new Map<string, string | null>();
  return (absPath: string) => {
    const hit = cache.get(absPath);
    if (hit !== undefined) return hit;
    const text = read(absPath);
    cache.set(absPath, text);
    return text;
  };
}

/**
 * A per-run verifier. Beyond the per-chunk verdict it carries one fuse: if EVERY distinct path it
 * probed is missing from disk, the index is almost certainly rooted somewhere else (a monorepo
 * subdir, an indexer run from the wrong cwd) rather than stale — and a filter that drops everything
 * would take the gate permanently dark. Two distinct misses with no hit is enough to disable itself;
 * partitionFresh then keeps every pair and the caller says so out loud.
 */
export function createVerifier(deps: VerifierDeps): Verifier {
  const read = cachedReader(deps.readFileText ?? readFromDisk);
  const on = canVerify(deps.columns);
  const probed = new Set<string>();
  const missing = new Set<string>();
  return {
    get enabled() {
      return on && !(probed.size >= 2 && missing.size === probed.size);
    },
    judge(ref) {
      if (!on) return 'unverifiable';
      const stored = deps.fetchChunk(ref.chunkId);
      if (stored?.rawCode == null) return 'unverifiable';
      probed.add(ref.file);
      const text = read(resolve(deps.cwd, ref.file));
      if (text == null) missing.add(ref.file);
      return judgeBody(chunkBody(stored.rawCode, stored.startLine, stored.endLine), text);
    },
  };
}

// ── The sqlite surface this module needs (structural: node:sqlite's DatabaseSync satisfies it) ───
export interface SqlStatement {
  get(...params: (number | string)[]): Record<string, SqlValue> | undefined;
  all(): Record<string, SqlValue>[];
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
}

/** Chunks-table column names — the input to canVerify. */
export function chunkColumns(db: SqlDb): string[] {
  return db
    .prepare('PRAGMA table_info(chunks)')
    .all()
    .map((c) => String(c.name));
}

/**
 * The verifier for a real index: same contract as createVerifier, with the rowid lookup wired to
 * the DB. The statement is prepared once per run, and only when the index can be verified at all.
 *
 * Every DB touch here is swallowed. The gate's standing contract is that it never crashes for its
 * index — a could-not-run is exit 2, fail-open — and an uncaught throw from a verification read
 * would surface as exit 1, i.e. a BLOCK caused by the very staleness machinery meant to prevent
 * one. A prepare that fails disables verification; a row read that fails is unverifiable (kept).
 */
export function verifierForIndex(db: SqlDb, cwd: string, columns: readonly string[]): Verifier {
  let stmt: SqlStatement | null = null;
  try {
    stmt = canVerify(columns)
      ? db.prepare('SELECT raw_code, start_line, end_line FROM chunks WHERE id = ?')
      : null;
  } catch {
    stmt = null;
  }
  return createVerifier({
    cwd,
    // A failed prepare must read as "cannot verify", not as "verified and everything is stale".
    columns: stmt ? columns : [],
    fetchChunk: (chunkId) => {
      let row: Record<string, SqlValue> | undefined;
      try {
        row = stmt?.get(chunkId);
      } catch {
        return null;
      }
      if (!row) return null;
      return {
        rawCode: typeof row.raw_code === 'string' ? row.raw_code : null,
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
      };
    },
  });
}

/** The pair fields this layer needs. matcher.mts's Pair satisfies it structurally. */
export interface VerifiablePair {
  idA: number;
  symbolA: string;
  fileA: string;
  idB: number;
  symbolB: string;
  fileB: string;
}
/** A dropped pair plus the side(s) whose code is not on disk — printed, never silently swallowed. */
export interface DroppedPair<P extends VerifiablePair> {
  pair: P;
  stale: ChunkRef[];
}

/**
 * DROP-ONLY: returns the input pairs minus those with a stale side. It can only turn a gate BLOCK
 * into a PASS, never the reverse — which is what makes it safe to add under a cache whose key
 * cannot see the index, and why it must never run in reconcile/baseline (dropping there deletes
 * real human approvals from the allowlist).
 */
export function partitionFresh<P extends VerifiablePair>(
  pairs: P[],
  verifier: Verifier,
): { fresh: P[]; dropped: DroppedPair<P>[] } {
  // Judge everything BEFORE reading `enabled`: the root-mismatch fuse only knows it has blown once
  // it has seen every probe, and a pair judged before that must not be dropped on its evidence.
  const verdicts = pairs.map((pair) => {
    const sides: ChunkRef[] = [
      { chunkId: pair.idA, symbol: pair.symbolA, file: pair.fileA },
      { chunkId: pair.idB, symbol: pair.symbolB, file: pair.fileB },
    ];
    return { pair, stale: sides.filter((side) => verifier.judge(side) === 'stale') };
  });
  if (!verifier.enabled) return { fresh: pairs, dropped: [] };
  return {
    fresh: verdicts.filter((v) => v.stale.length === 0).map((v) => v.pair),
    dropped: verdicts.filter((v) => v.stale.length > 0),
  };
}

/**
 * What to print about freshness. Two cases, both of which exist because the alternative is a silent
 * one: a DROP is a finding the gate deliberately withheld (name it, with the action that restores
 * coverage — re-index, never an allowlist entry), and an UNVERIFIED block is a finding whose ranges
 * nobody has checked (say so, so a symbol missing at its printed range reads as a stale index rather
 * than an approval candidate). Deliberately never contains the allowlist `add` command: a caller
 * scanning the output for a paste-able remedy must not find one here.
 */
export function freshnessNotice(
  dropped: DroppedPair<VerifiablePair>[],
  opts: { verified: boolean; blocking: boolean },
): string[] {
  const out: string[] = [];
  if (dropped.length > 0) {
    const files = [...new Set(dropped.flatMap((d) => d.stale.map((s) => s.file)))];
    out.push(
      `Stale index — dropped ${dropped.length} candidate pair(s) whose indexed code is NOT in the working tree:`,
    );
    for (const d of dropped) {
      for (const s of d.stale)
        out.push(`  ${s.symbol}  ${s.file}  (indexed body not found on disk)`);
    }
    out.push(
      `  Re-index these file(s) to restore coverage — do not approve them: ${files.join(', ')}`,
      '',
    );
  }
  if (opts.blocking && !opts.verified) {
    out.push(
      'Freshness NOT verified (this index carries no raw_code/id, or its paths do not resolve here).',
      'If a symbol above is not defined at its printed range, the index is stale: re-index instead.',
      '',
    );
  }
  return out;
}

/**
 * Stable side ordering for a detected pair: symbol+path lexical order, so the same two chunks
 * always produce the same A/B assignment and therefore the same allowlist key, whichever order the
 * sweep visited them in.
 */
export function orderKey(
  rows: readonly { symbol_name: string; file_path: string }[],
  i: number,
  j: number,
): [number, number] {
  const ai = `${rows[i].symbol_name} ${rows[i].file_path}`;
  const aj = `${rows[j].symbol_name} ${rows[j].file_path}`;
  return ai < aj ? [i, j] : [j, i];
}
