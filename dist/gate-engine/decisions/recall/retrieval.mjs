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
import { writeFileAtomic } from "../atomic-write.mjs";
import { currentTarget, parseDecision, parseIndex } from "../decision-format.mjs";
import { sections } from "./markdown.mjs";
import { corpusIdf, orderQualifiers, tokenize } from "./qualifiers.mjs";
// Re-exported so retrieval stays the single entry point for the recall path.
export { corpusIdf, orderQualifiers } from "./qualifiers.mjs";
export const EMBED_URL = 'http://localhost:11434/api/embed';
export const EMBED_MODEL = 'nomic-embed-text';
// Top-level regexes (these run in loops).
const WS_RE = /\s+/g;
const ANY_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
/** Legacy (pre-Target) schema: `**Ruling:**` / `**Why / target:**` under a bare `## <date> — …`. */
const RULING_FIELD_RE = /^\*\*Ruling:\*\*\s*(.+)$/gm;
const WHY_FIELD_RE = /^\*\*(?:Why \/ target|Context):\*\*\s*(.+)$/m;
const TARGET_HEADING_RE = /^## Target · (\d{4}-\d{2}-\d{2})/gm;
const LEGACY_HEADING_RE = /^## (\d{4}-\d{2}-\d{2}) /gm;
const NOTE_LINE_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/;
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
export function loadAxisRows(p) {
    const indexed = new Map((existsSync(p.indexPath) ? parseIndex(readFileSync(p.indexPath, 'utf8')) : []).map((r) => [
        r.slug,
        r,
    ]));
    const rows = [];
    const seen = new Set();
    if (existsSync(p.decisionsDir)) {
        for (const file of readdirSync(p.decisionsDir).sort()) {
            if (!file.endsWith('.md') || file === 'INDEX.md')
                continue;
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
function axisRow(p, slug, fallback) {
    let body = '';
    try {
        body = parseDecision(readFileSync(slugPath(p, slug), 'utf8')).body;
    }
    catch {
        return {
            ...(fallback ?? { slug, ruling: '', why: '', updated: '' }),
            liveRulingId: null,
            entries: [],
            qualifiers: [],
        };
    }
    const target = currentTarget(body);
    // Legacy (pre-Target) blocks carry the same `**Ruling:**` field under a bare `## <date>` heading;
    // append-only ordering makes the LAST one current, matching currentTarget's last-block rule.
    const legacyRulings = [...body.matchAll(RULING_FIELD_RE)];
    const ruling = target?.ruling || legacyRulings.at(-1)?.[1]?.trim() || fallback?.ruling || '';
    const why = target?.fields.context || body.match(WHY_FIELD_RE)?.[1] || fallback?.why || '';
    const dates = [...body.matchAll(ANY_DATE_RE)].map((m) => m[1]).sort();
    const liveRulingId = liveRulingIdOf(body, Boolean(target));
    const entries = axisEntries(body, liveRulingId);
    return {
        slug,
        ruling,
        why,
        updated: dates.at(-1) ?? fallback?.updated ?? '',
        liveRulingId,
        entries,
        qualifiers: entries.filter((e) => e.kind === 'note'),
    };
}
/**
 * Split an axis into independently-searchable ENTRIES: the current ruling block, then each note
 * appended after it.
 *
 * Retrieval scores entries and rolls up to the axis by MAX, never by sum or concatenation. Both
 * alternatives are wrong in opposite directions: concatenating puts the notes in the tail, and
 * `clampGist` is tail-biased so a hot axis's churn would outrank its own ruling; summing would let
 * an axis with twenty notes beat a better-matching axis with one. Max means a note CAN be the hit
 * that surfaces an axis, while note count buys no advantage — the same segment-then-max shape that
 * makes long-document scoring work (SummaC, arXiv:2111.09525).
 */
export function axisEntries(body, liveRulingId) {
    const target = currentTarget(body);
    const rulingDate = liveRulingId?.split(':')[1] ?? '';
    const all = sections(body);
    // The ruling's own section, found by its heading rather than by position. Both schema generations
    // are named here because both are current somewhere: `## Target · <date>` and the legacy
    // `## <date> — …` that still accounts for 49 of the real corpus's blocks.
    // findLast, never find: EVERY other resolution in this engine takes the last match —
    // currentTarget() takes the last Target block, axisRow takes legacyRulings.at(-1), and the
    // string-arithmetic this replaced used lastIndexOf. Two blocks share a date whenever an axis is
    // amended twice in one calendar day (today() is day-granularity, and the real corpus has such
    // files), and first-match would bind to the SUPERSEDED one — attaching its notes to the current
    // ruling and orphaning the real ones. That is the same notes-detached-from-their-ruling class the
    // six earlier review rounds closed.
    const lastMatching = (prefix) => {
        for (let i = all.length - 1; i >= 0; i -= 1)
            if (all[i].depth === 2 && all[i].heading.startsWith(prefix))
                return all[i];
        return undefined;
    };
    const own = lastMatching(`## Target · ${rulingDate}`) ?? lastMatching(`## ${rulingDate} `);
    const entries = [
        {
            id: liveRulingId ?? 'ruling:unknown',
            kind: 'ruling',
            date: rulingDate,
            // The modern schema already has a parsed block; the legacy branch takes its OWN section's
            // prose. Never the whole body — that folded every superseded block into the current ruling.
            text: target ? target.block : (own?.prose ?? body),
        },
    ];
    // Qualifiers are the dated bullets inside the ruling's OWN section. Bullets under any other
    // heading — a superseded block, or a trailing `## [archived …]` — belong to that heading, and the
    // section boundary now comes from the parser instead of being inferred.
    for (const item of own?.items ?? []) {
        const m = item.match(NOTE_LINE_RE);
        if (m)
            entries.push({ id: `note:${m[1]}`, kind: 'note', date: m[1], text: m[2].trim() });
    }
    return entries;
}
/** Name the block a ruling was read from: `target:<date>`, `entry:<date>` (legacy), or null. */
function liveRulingIdOf(body, hasTarget) {
    const re = hasTarget ? TARGET_HEADING_RE : LEGACY_HEADING_RE;
    const dates = [...body.matchAll(re)].map((m) => m[1]);
    // Last heading wins, matching currentTarget's rule — append order IS chronological order here.
    const last = dates.at(-1);
    return last ? `${hasTarget ? 'target' : 'entry'}:${last}` : null;
}
function slugPath(p, slug) {
    return path.join(p.decisionsDir, `${slug}.md`);
}
// ─── Lexical floor (BM25) ────────────────────────────────────────────────────────
// Lexical floor (the Ollama-down fallback): rank candidate rows by BM25. IDF rewards rare shared
// terms and discounts common ones (so "the"/"and" carry ~no weight without a stoplist); k1/b are the
// standard defaults. Pure, zero-dep.
export function bm25Rank(queryText, rows, k = 5, k1 = 1.5, b = 0.75, idf = corpusIdf(rows)) {
    const qTerms = [...new Set(tokenize(queryText))];
    if (qTerms.length === 0 || rows.length === 0)
        return [];
    // One BM25 document per ENTRY, not per axis: a note has to be able to win on its own terms.
    const units = rows.flatMap((r, ri) => (r.entries?.length
        ? r.entries
        : [
            {
                id: r.liveRulingId ?? 'ruling:unknown',
                kind: 'ruling',
                date: '',
                text: `${r.ruling} ${r.why}`,
            },
        ]).map((e) => ({ ri, entry: e, doc: tokenize(`${r.slug} ${e.text}`) })));
    const N = units.length;
    const avgdl = units.reduce((s, u) => s + u.doc.length, 0) / N || 1;
    const df = new Map(qTerms.map((t) => [t, units.filter((u) => u.doc.includes(t)).length]));
    // Roll up to the axis by MAX. Summing would make note count a ranking advantage; max means the
    // best-matching single unit speaks for the axis, and records WHICH unit it was.
    const best = new Map();
    for (const u of units) {
        let score = 0;
        for (const t of qTerms) {
            const n = df.get(t);
            if (!n)
                continue;
            const tf = u.doc.filter((w) => w === t).length;
            if (!tf)
                continue;
            const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
            score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * u.doc.length) / avgdl)));
        }
        const prior = best.get(u.ri);
        if (!prior || score > prior.score)
            best.set(u.ri, { score, entryId: u.entry.id });
    }
    return (rows
        .map((r, i) => ({
        ...r,
        score: best.get(i)?.score ?? 0,
        matchedEntryId: best.get(i)?.entryId ?? null,
        qualifiers: orderQualifiers(queryText, r.qualifiers ?? [], idf),
    }))
        .filter((r) => r.score > 0)
        // Slug breaks a score tie so rank is REPRODUCIBLE: the bench asserts two runs agree on order,
        // and Array.sort is not required to be stable across engines for equal keys.
        .sort((x, y) => y.score - x.score || x.slug.localeCompare(y.slug))
        .slice(0, k));
}
// ─── Semantic tier (per-axis embeddings, local Ollama) ───────────────────────────
export function cosine(a, b) {
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
export async function embed(text, kind = 'document') {
    if (process.env.DECISIONS_NO_EMBED)
        return null;
    const prefixed = `${kind === 'query' ? 'search_query: ' : 'search_document: '}${String(text).slice(0, 8000)}`;
    try {
        const res = await fetch(EMBED_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: EMBED_MODEL, input: prefixed }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        const vec = data?.embeddings?.[0];
        return Array.isArray(vec) && vec.length ? vec : null;
    }
    catch {
        return null;
    }
}
function axisHash(text) {
    return createHash('sha1').update(text).digest('hex');
}
// Cap the gist at the TAIL (newest entries), never the head — the current ruling is the LAST
// entry (append-only), and that's what retrieval most needs to match on a hot, oft-flipped axis.
export function clampGist(body, max = 6000) {
    const t = body.replace(WS_RE, ' ').trim();
    return t.length > max ? t.slice(-max) : t;
}
// Searchable gist of an axis = its CURRENT ruling block PLUS the notes that qualify it. The notes
// used to be excluded because clampGist is tail-biased and a hot axis's churn would outrank its own
// ruling — a real objection, which is why the lexical tier now scores per ENTRY and rolls up by max.
// The single-vector semantic tier cannot express that, so it takes the composite and accepts the
// bias; per-entry embeddings are the next step if the tier sweep shows it matters.
export function gistOf(p, slug) {
    const file = slugPath(p, slug);
    if (!existsSync(file))
        return null;
    const { body } = parseDecision(readFileSync(file, 'utf8'));
    const t = currentTarget(body);
    const live = axisEntries(body, liveRulingIdOf(body, Boolean(t)));
    return clampGist(live.length ? live.map((e) => e.text).join('\n') : t ? t.block : body);
}
function loadVecIndex(p) {
    if (!existsSync(p.vecIndexPath))
        return {};
    try {
        return JSON.parse(readFileSync(p.vecIndexPath, 'utf8'));
    }
    catch {
        return {}; // corrupt derived cache → rebuilt lazily, never fatal
    }
}
function saveVecIndex(p, idx) {
    mkdirSync(path.dirname(p.vecIndexPath), { recursive: true });
    writeFileAtomic(p.vecIndexPath, `${JSON.stringify(idx)}\n`);
}
// Lazy content-hash rehash: (re)embed an axis only if its gist changed (or is new/missing).
// Returns true if it (re)embedded. No manual reindex discipline — drift self-heals on query.
export async function embedAxis(p, slug, idx) {
    const gist = gistOf(p, slug);
    if (!gist)
        return false;
    const h = axisHash(gist);
    // Skip only if BOTH content and embedding model are unchanged — a model swap must re-embed
    // (vectors from different models aren't comparable, even at the same dimension).
    if (idx[slug]?.hash === h && idx[slug]?.model === EMBED_MODEL)
        return false;
    const vec = await embed(gist, 'document');
    if (!vec)
        return false; // embed unavailable → leave for the lexical floor; retry next query
    idx[slug] = { hash: h, vec, model: EMBED_MODEL };
    return true;
}
// ─── Ranking ─────────────────────────────────────────────────────────────────────
// Rank the recorded axes against a free-text query and RETURN the ranked rows (data, not printed) so
// both `query` (which prints them) and `scoped-targets` (which emits JSON) share one ranker.
// Reason: the branches ARE the query ranking algorithm's fallback tiers (semantic cosine over the vector index, then BM25 lexical floor, then raw first-k); the embed-availability and stale-dim filtering are inherent to degrading gracefully and flattening scatters one ranked lookup
// fallow-ignore-next-line complexity
export async function rankAxes(text, k = 5, p) {
    const rows = loadAxisRows(p);
    if (rows.length === 0)
        return { source: 'empty', rows: [] };
    const idf = corpusIdf(rows);
    const qvec = await embed(text, 'query');
    if (qvec) {
        const idx = loadVecIndex(p);
        let dirty = false;
        for (const r of rows)
            if (await embedAxis(p, r.slug, idx))
                dirty = true;
        if (dirty)
            saveVecIndex(p, idx);
        const ranked = rows
            .filter((r) => idx[r.slug]?.vec?.length === qvec.length) // skip stale-dim vectors → lexical covers
            .map((r) => ({
            ...r,
            score: cosine(qvec, idx[r.slug].vec),
            // NULL, not the ruling id: this tier embeds the whole axis (ruling + qualifiers) as ONE
            // vector, so it genuinely cannot say which unit matched. Naming the ruling would be a false
            // provenance claim — a query matching only note text would be reported as ruling-sourced.
            // Null means "this tier cannot attribute the match", which is the truth. Per-entry
            // embeddings would let it answer properly; until then it declines to guess.
            matchedEntryId: null,
            qualifiers: orderQualifiers(text, r.qualifiers ?? [], idf),
        }))
            .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
            .slice(0, k);
        if (ranked.length)
            return { source: 'semantic', rows: ranked };
    }
    // Fallback floor: BM25 over the candidate rows. Zero lexical overlap is an ABSTAIN, not a reason
    // to hand back `rows.slice(0, k)` — that old fallback returned the alphabetically-first k axes and
    // was indistinguishable from a real hit, which is how "nothing rules on this" came to look exactly
    // like an answer. Callers get an empty set and a `none` source instead.
    const lex = bm25Rank(text, rows, k, undefined, undefined, idf);
    return lex.length ? { source: 'lexical', rows: lex } : { source: 'none', rows: [] };
}
/** Force a full re-embed of every axis (ignoring the content hash) — `guard-decisions reindex`. */
export async function reindexAll(p) {
    const rows = loadAxisRows(p);
    const idx = loadVecIndex(p);
    let done = 0;
    for (const r of rows) {
        const gist = gistOf(p, r.slug);
        if (!gist)
            continue;
        const vec = await embed(gist, 'document');
        if (!vec)
            continue;
        idx[r.slug] = { hash: axisHash(gist), vec, model: EMBED_MODEL };
        done += 1;
    }
    if (done)
        saveVecIndex(p, idx);
    return { done, total: rows.length };
}
