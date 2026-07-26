/**
 * Ranking a decision's own notes against a query.
 *
 * Split from retrieval.mts because it answers a different question. Retrieval picks WHICH AXIS
 * answers a question; this picks WHICH NOTES of that axis a reader should see first — callers show
 * only a few, and the note that falsifies a ruling is rarely the newest one.
 */
const TOKEN_RE = /[a-z0-9]+/g;
// Prose tokenizer: lowercase, alphanumeric runs, drop single chars. NO stopword list — BM25's IDF
// down-weights common terms in a principled way (a hand-rolled stoplist is brittle + English-only).
export function tokenize(text) {
    const out = [];
    for (const m of String(text).toLowerCase().matchAll(TOKEN_RE)) {
        if (m[0].length > 1)
            out.push(m[0]);
    }
    return out;
}
/**
 * Order an axis's qualifying notes by relevance to the query. Used by EVERY retrieval tier.
 *
 * Callers show only the first few (the CLI prints 3), so this decides which notes a reader actually
 * sees — and the note that falsifies a ruling is rarely the newest. On the real frink corpus the
 * load-bearing "Hooks-follow PARKED" note is 4th of 20 by date, so date order would drop it.
 *
 * Deliberately LEXICAL even on the semantic tier: that tier embeds one vector per axis, so it has no
 * per-note score to sort by. Ordering within an already-chosen axis is a much easier problem than
 * choosing the axis, and term overlap does it deterministically and for free. Having one ordering
 * for both tiers is the point — the first version of this sorted only on the BM25 path, so the
 * semantic path silently served chronological notes into a 3-note cap and hid the falsifying one.
 */
export function orderQualifiers(queryText, quals, idf) {
    const qTerms = [...new Set(tokenize(queryText))];
    if (!qTerms.length || quals.length < 2)
        return [...quals];
    const docs = quals.map((e) => tokenize(e.text));
    const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
    const score = (d) => {
        let total = 0;
        for (const t of qTerms) {
            const tf = d.filter((w) => w === t).length;
            if (!tf)
                continue;
            total += (idf.get(t) ?? 0) * ((tf * 2.5) / (tf + 1.5 * (0.25 + (0.75 * d.length) / avgdl)));
        }
        return total;
    };
    return quals
        .map((e, i) => ({ e, s: score(docs[i]) }))
        .sort((x, y) => y.s - x.s || y.e.date.localeCompare(x.e.date))
        .map((x) => x.e);
}
/**
 * IDF over the WHOLE corpus's entries, for weighting within-axis qualifier order.
 *
 * It must be corpus-wide, not per-axis. Scoring an axis's notes against IDF computed over only
 * those notes demotes exactly the terms that make the axis the right one — "hooks" is common across
 * an axis about hooks, so per-axis IDF buried the note that falsified its ruling. Corpus-wide, the
 * cheap words ("the", "each") are common and the topical ones are rare, which is the behaviour the
 * rest of this file already relies on instead of a stoplist.
 */
export function corpusIdf(rows) {
    const docs = rows.flatMap((r) => (r.entries ?? []).map((e) => new Set(tokenize(e.text))));
    const N = docs.length || 1;
    const df = new Map();
    for (const d of docs)
        for (const t of d)
            df.set(t, (df.get(t) ?? 0) + 1);
    const idf = new Map();
    for (const [t, n] of df)
        idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    return idf;
}
