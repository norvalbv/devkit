/**
 * The dense tier's plumbing: the Ollama embedding call, cosine similarity, and the derived
 * per-axis vector cache.
 *
 * Split from retrieval.mts because it is the half with no opinion about decision records — it moves
 * text to vectors and vectors to disk, and depends on nothing that parses markdown. Keeping it
 * separate means the dependency runs one way (retrieval → embeddings, never back), so the tier can
 * be swapped for a maintained hybrid-search engine without unpicking the candidate-set logic.
 *
 * Everything here fails SOFT: no Ollama, no model, a corrupt cache or a bad response all return
 * null/empty so the caller falls through to the lexical floor. A dead dense tier must degrade the
 * ranking, never break the query — but the caller is responsible for SAYING it degraded.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from "../atomic-write.mjs";
export const EMBED_URL = 'http://localhost:11434/api/embed';
export const EMBED_MODEL = 'nomic-embed-text';
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
/**
 * Was the dense tier switched OFF on purpose, rather than being unavailable?
 *
 * `embed()` returns null for both, but they are opposite situations: an opt-out is the expected
 * state in tests and on the CI bench tier, while an unavailable model is a degraded install worth
 * shouting about. Callers that report degradation must consult this first, or every routine test run
 * accuses the machine of a broken Ollama and tells the reader to pull a model they disabled.
 */
export const embedDisabled = () => Boolean(process.env.DECISIONS_NO_EMBED);
export async function embed(text, kind = 'document') {
    if (embedDisabled())
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
export function axisHash(text) {
    return createHash('sha1').update(text).digest('hex');
}
export function loadVecIndex(p) {
    if (!existsSync(p.vecIndexPath))
        return {};
    try {
        return JSON.parse(readFileSync(p.vecIndexPath, 'utf8'));
    }
    catch {
        return {}; // corrupt derived cache → rebuilt lazily, never fatal
    }
}
export function saveVecIndex(p, idx) {
    mkdirSync(path.dirname(p.vecIndexPath), { recursive: true });
    writeFileAtomic(p.vecIndexPath, `${JSON.stringify(idx)}\n`);
}
