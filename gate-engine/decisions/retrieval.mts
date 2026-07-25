/**
 * Decision retrieval: the candidate set, the lexical floor, and the per-axis semantic index.
 *
 * Split out of decisions.mts so the RECORD path (add/amend/show) and the RECALL path are separately
 * readable — and so the recall path can grow a benchmark without pushing the writer over its size
 * budget.
 *
 * Both rankers score IN-SCRIPT over the bounded corpus and return only top-k, so an agent's context
 * never loads the whole (monotonically growing) decision log. Semantic is the happy path; BM25 is
 * the always-available floor and the fallback when Ollama or the embedding model is absent.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mts';
import { currentTarget, type IndexRow, parseDecision, parseIndex } from './decision-format.mts';

export const EMBED_URL = 'http://localhost:11434/api/embed';
export const EMBED_MODEL = 'nomic-embed-text';

// Top-level regexes (these run in loops).
const WS_RE = /\s+/g;
const TOKEN_RE = /[a-z0-9]+/g;
const ANY_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
/** Legacy (pre-Target) schema: `**Ruling:**` / `**Why / target:**` under a bare `## <date> — …`. */
const RULING_FIELD_RE = /^\*\*Ruling:\*\*\s*(.+)$/gm;
const WHY_FIELD_RE = /^\*\*(?:Why \/ target|Context):\*\*\s*(.+)$/m;

/** Resolved on-disk paths for one consumer cwd (see decisions.mts `paths()`). */
export interface RetrievalPaths {
  cwd: string;
  decisionsDir: string;
  indexPath: string;
  vecIndexPath: string;
}

/** One cached per-axis embedding in the derived vector index. */
interface VecEntry {
  hash: string;
  vec: number[];
  model: string;
}
type VecIndex = Record<string, VecEntry>;

/** An INDEX row plus its retrieval score. */
type RankedRow = IndexRow & { score: number };

/**
 * Ranked axes plus which retrieval tier produced them.
 *
 * `empty` and `none` are different answers and must stay distinguishable: `empty` means nothing has
 * ever been recorded, `none` means the log was searched and NOTHING RULES on this question. Before,
 * both — and a genuine miss — rendered as an identical list of five axes, so an agent could not tell
 * "not decided" from "I got the wrong axis". Two live probes returned five confident-looking,
 * entirely unrelated axes for questions the corpus had no ruling on.
 */
export interface RankResult {
  source: 'semantic' | 'lexical' | 'empty' | 'none';
  rows: IndexRow[];
}

/** The Ollama /api/embed response (external boundary). */
interface EmbedResponse {
  embeddings?: number[][];
}

// ─── Candidate set ───────────────────────────────────────────────────────────────

/**
 * The retrieval candidate set is the decisions DIRECTORY, not INDEX.md.
 *
 * INDEX.md is an incrementally-upserted VIEW: `add --target` upserts a single row, only
 * `amend --target` full-rebuilds, and nothing reconciles the two. Measured on a real 86-axis corpus,
 * 23 axes (27%) had no INDEX row at all and so could not be returned by `query` at ANY k — including
 * live, recent ones. Every miss in a 14-query probe was this, not a ranking error: every axis that
 * WAS indexed ranked first.
 *
 * `check-alignment` has always read the directory (`loadScopedTargets`), so before this the two
 * halves of the gate disagreed about which axes existed. Files are now authoritative for retrieval;
 * INDEX stays the human-readable rendering, and supplies `ruling`/`why` only as a fallback for a
 * file we cannot parse a ruling out of.
 */
export function loadAxisRows(p: RetrievalPaths): IndexRow[] {
  const indexed = new Map(
    (existsSync(p.indexPath) ? parseIndex(readFileSync(p.indexPath, 'utf8')) : []).map((r) => [
      r.slug,
      r,
    ]),
  );
  const rows: IndexRow[] = [];
  const seen = new Set<string>();
  if (existsSync(p.decisionsDir)) {
    for (const file of readdirSync(p.decisionsDir).sort()) {
      if (!file.endsWith('.md') || file === 'INDEX.md') continue;
      const slug = file.slice(0, -3);
      seen.add(slug);
      rows.push(axisRow(p, slug, indexed.get(slug)));
    }
  }
  // An INDEX row whose file is gone is dead weight for retrieval (it can never be `show`n), but
  // dropping it silently would hide the drift — `doctor` reports it; retrieval simply omits it.
  return rows.filter((r) => seen.has(r.slug));
}

/** Derive one candidate row from an axis FILE, falling back to its INDEX row where unparseable. */
function axisRow(p: RetrievalPaths, slug: string, fallback: IndexRow | undefined): IndexRow {
  let body = '';
  try {
    body = parseDecision(readFileSync(slugPath(p, slug), 'utf8')).body;
  } catch {
    return fallback ?? { slug, ruling: '', why: '', updated: '' };
  }
  const target = currentTarget(body);
  // Legacy (pre-Target) blocks carry the same `**Ruling:**` field under a bare `## <date>` heading;
  // append-only ordering makes the LAST one current, matching currentTarget's last-block rule.
  const legacyRulings = [...body.matchAll(RULING_FIELD_RE)];
  const ruling = target?.ruling || legacyRulings.at(-1)?.[1]?.trim() || fallback?.ruling || '';
  const why = target?.fields.context || body.match(WHY_FIELD_RE)?.[1] || fallback?.why || '';
  const dates = [...body.matchAll(ANY_DATE_RE)].map((m) => m[1]).sort();
  return { slug, ruling, why, updated: dates.at(-1) ?? fallback?.updated ?? '' };
}

function slugPath(p: RetrievalPaths, slug: string) {
  return path.join(p.decisionsDir, `${slug}.md`);
}

// ─── Lexical floor (BM25) ────────────────────────────────────────────────────────

// Prose tokenizer: lowercase, alphanumeric runs, drop single chars. NO stopword list — BM25's IDF
// down-weights common terms in a principled way (a hand-rolled stoplist is brittle + English-only).
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text).toLowerCase().matchAll(TOKEN_RE)) {
    if (m[0].length > 1) out.push(m[0]);
  }
  return out;
}

// Lexical floor (the Ollama-down fallback): rank candidate rows by BM25. IDF rewards rare shared
// terms and discounts common ones (so "the"/"and" carry ~no weight without a stoplist); k1/b are the
// standard defaults. Pure, zero-dep.
export function bm25Rank(
  queryText: string,
  rows: IndexRow[],
  k = 5,
  k1 = 1.5,
  b = 0.75,
): RankedRow[] {
  const qTerms = [...new Set(tokenize(queryText))];
  if (qTerms.length === 0 || rows.length === 0) return [];
  const docs = rows.map((r) => tokenize(`${r.slug} ${r.ruling} ${r.why}`));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map<string, number>(
    qTerms.map((t) => [t, docs.filter((d) => d.includes(t)).length]),
  );
  return rows
    .map((r, i) => {
      const d = docs[i];
      let score = 0;
      for (const t of qTerms) {
        const n = df.get(t);
        if (!n) continue;
        const tf = d.filter((w) => w === t).length;
        if (!tf) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgdl)));
      }
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

// ─── Semantic tier (per-axis embeddings, local Ollama) ───────────────────────────

export function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Embed via Ollama. Returns number[] or null (opted out / Ollama down / model absent / bad
// response) → the caller falls back to the lexical floor. Never throws.
// nomic-embed-text REQUIRES task prefixes (`search_query:` / `search_document:`) for calibrated
// retrieval similarity — without them, query↔doc cosine is poorly ranked.
export async function embed(
  text: string,
  kind: 'query' | 'document' = 'document',
): Promise<number[] | null> {
  if (process.env.DECISIONS_NO_EMBED) return null;
  const prefixed = `${kind === 'query' ? 'search_query: ' : 'search_document: '}${String(text).slice(0, 8000)}`;
  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: prefixed }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as EmbedResponse | null;
    const vec = data?.embeddings?.[0];
    return Array.isArray(vec) && vec.length ? vec : null;
  } catch {
    return null;
  }
}

function axisHash(text: string) {
  return createHash('sha1').update(text).digest('hex');
}

// Cap the gist at the TAIL (newest entries), never the head — the current ruling is the LAST
// entry (append-only), and that's what retrieval most needs to match on a hot, oft-flipped axis.
export function clampGist(body: string, max = 6000) {
  const t = body.replace(WS_RE, ' ').trim();
  return t.length > max ? t.slice(-max) : t;
}

// Searchable gist of an axis = its CURRENT Target block (the stable ruling we want `query` to
// surface), not the note tail — a hot axis's notes would otherwise outrank the Target (clampGist is
// tail-biased). Falls back to the whole body for unmigrated / note-only / old-format axes.
export function gistOf(p: RetrievalPaths, slug: string): string | null {
  const file = slugPath(p, slug);
  if (!existsSync(file)) return null;
  const { body } = parseDecision(readFileSync(file, 'utf8'));
  const t = currentTarget(body);
  return clampGist(t ? t.block : body);
}

function loadVecIndex(p: RetrievalPaths): VecIndex {
  if (!existsSync(p.vecIndexPath)) return {};
  try {
    return JSON.parse(readFileSync(p.vecIndexPath, 'utf8')) as VecIndex;
  } catch {
    return {}; // corrupt derived cache → rebuilt lazily, never fatal
  }
}

function saveVecIndex(p: RetrievalPaths, idx: VecIndex) {
  mkdirSync(path.dirname(p.vecIndexPath), { recursive: true });
  writeFileAtomic(p.vecIndexPath, `${JSON.stringify(idx)}\n`);
}

// Lazy content-hash rehash: (re)embed an axis only if its gist changed (or is new/missing).
// Returns true if it (re)embedded. No manual reindex discipline — drift self-heals on query.
export async function embedAxis(p: RetrievalPaths, slug: string, idx: VecIndex): Promise<boolean> {
  const gist = gistOf(p, slug);
  if (!gist) return false;
  const h = axisHash(gist);
  // Skip only if BOTH content and embedding model are unchanged — a model swap must re-embed
  // (vectors from different models aren't comparable, even at the same dimension).
  if (idx[slug]?.hash === h && idx[slug]?.model === EMBED_MODEL) return false;
  const vec = await embed(gist, 'document');
  if (!vec) return false; // embed unavailable → leave for the lexical floor; retry next query
  idx[slug] = { hash: h, vec, model: EMBED_MODEL };
  return true;
}

// ─── Ranking ─────────────────────────────────────────────────────────────────────

// Rank the recorded axes against a free-text query and RETURN the ranked rows (data, not printed) so
// both `query` (which prints them) and `scoped-targets` (which emits JSON) share one ranker.
// Reason: the branches ARE the query ranking algorithm's fallback tiers (semantic cosine over the vector index, then BM25 lexical floor, then raw first-k); the embed-availability and stale-dim filtering are inherent to degrading gracefully and flattening scatters one ranked lookup
// fallow-ignore-next-line complexity
export async function rankAxes(text: string, k = 5, p: RetrievalPaths): Promise<RankResult> {
  const rows = loadAxisRows(p);
  if (rows.length === 0) return { source: 'empty', rows: [] };
  const qvec = await embed(text, 'query');
  if (qvec) {
    const idx = loadVecIndex(p);
    let dirty = false;
    for (const r of rows) if (await embedAxis(p, r.slug, idx)) dirty = true;
    if (dirty) saveVecIndex(p, idx);
    const ranked = rows
      .filter((r) => idx[r.slug]?.vec?.length === qvec.length) // skip stale-dim vectors → lexical covers
      .map((r) => ({ ...r, score: cosine(qvec, idx[r.slug].vec) }))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, k);
    if (ranked.length) return { source: 'semantic', rows: ranked };
  }
  // Fallback floor: BM25 over the candidate rows. Zero lexical overlap is an ABSTAIN, not a reason
  // to hand back `rows.slice(0, k)` — that old fallback returned the alphabetically-first k axes and
  // was indistinguishable from a real hit, which is how "nothing rules on this" came to look exactly
  // like an answer. Callers get an empty set and a `none` source instead.
  const lex = bm25Rank(text, rows, k);
  return lex.length ? { source: 'lexical', rows: lex } : { source: 'none', rows: [] };
}

/** Force a full re-embed of every axis (ignoring the content hash) — `guard-decisions reindex`. */
export async function reindexAll(p: RetrievalPaths) {
  const rows = loadAxisRows(p);
  const idx = loadVecIndex(p);
  let done = 0;
  for (const r of rows) {
    const gist = gistOf(p, r.slug);
    if (!gist) continue;
    const vec = await embed(gist, 'document');
    if (!vec) continue;
    idx[r.slug] = { hash: axisHash(gist), vec, model: EMBED_MODEL };
    done += 1;
  }
  if (done) saveVecIndex(p, idx);
  return { done, total: rows.length };
}
