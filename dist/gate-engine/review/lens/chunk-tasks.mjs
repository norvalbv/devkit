/**
 * Chunked-mode task planning (sc-1907) — split out of split.mts (guard-size). planReviewWork
 * calls planChunkedParts per correctness selection; null (off / under trigger) falls back to the
 * un-chunked shape whose keys stay byte-identical to the pre-chunking engine.
 */
import { diffCacheIdentity } from "../../judge/diff-focus.mjs";
import { chunkDiffText, chunkFilesSha, chunkPlanHash, identityBytesByPath, packDiffIntoChunks, unquoteGitPath, } from "./chunk.mjs";
import { deriveLensReviewer, lensGroupId } from "./groups.mjs";
/**
 * Parse `GUARD_CORRECTNESS_CHUNK` into a chunk cap in LOC, or null when chunking is off (the
 * default — off keeps planReviewWork's keys and tasks byte-identical to the un-chunked engine).
 * A malformed value throws rather than silently running unchunked.
 */
export function resolveChunkCap(raw = process.env.GUARD_CORRECTNESS_CHUNK) {
    const spec = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (spec === '' || spec === '0' || spec === 'off')
        return null;
    const n = Number(spec);
    if (!Number.isInteger(n) || n <= 0)
        throw new Error(`GUARD_CORRECTNESS_CHUNK: expected 'off' or a positive LOC cap, got '${spec}'`);
    // A BYTE-count misconfiguration parses fine but would never trigger; no honest LOC cap
    // exceeds 4000 (the whole-diff evidence cap is 60KB ≈ 1500 LOC).
    if (n > 4000)
        throw new Error(`GUARD_CORRECTNESS_CHUNK: '${spec}' looks like a BYTE count — the unit is LOC (try ${Math.round(n / 40)})`);
    return n;
}
/** LOC→identity-bytes conversion used everywhere chunk caps are sized (~40 bytes/line). */
const CHUNK_BYTES_PER_LOC = 40;
/** Chunk only when the diff meaningfully exceeds the cap — at or under 1.5x, one judge reading
 * the whole diff beats two reading halves. */
const CHUNK_TRIGGER_RATIO = 1.5;
/** Safety backstop, NOT chunking policy: the configured cap governs granularity so production
 * matches the benched condition (the largest benched diff, 7.2k LOC at cap 400, packs 18 chunks).
 * Only a pathological diff repacks at doubled caps. Concurrency is bounded by the runner's judge
 * pool (reviewConcurrency, default 6), not by chunk count, and sc-1476 recovery already defers
 * out of the contended wave — so chunk count costs judge SPEND, not scheduling safety. */
const MAX_CHUNKS = 24;
/**
 * The chunked task plan for ONE correctness selection, or null when the diff is under the
 * trigger. Local lens groups fan out per chunk, scoped through the derived `sel.files` (evidence,
 * override valve, and checklist state all derive from it). Groups carrying
 * `writer-reader-contracts` stay whole-diff on the un-chunked key, so a verdict earned either
 * side of the flag serves the other.
 */
export function planChunkedParts(sel, diffText, wholeIdText, salt, keyOf, groups, capLoc) {
    const capBytes = capLoc * CHUNK_BYTES_PER_LOC;
    const bytes = identityBytesByPath(diffText);
    let total = 0;
    for (const b of bytes.values())
        total += b;
    if (total <= capBytes * CHUNK_TRIGGER_RATIO)
        return null;
    let effectiveCap = capBytes;
    let packed = packDiffIntoChunks(sel.files, diffText, effectiveCap);
    while (packed.chunks.length > MAX_CHUNKS) {
        effectiveCap *= 2;
        packed = packDiffIntoChunks(sel.files, diffText, effectiveCap);
    }
    if (packed.chunks.length < 2)
        return null;
    const planHash = chunkPlanHash(packed.chunks);
    const name = sel.reviewer.name;
    const isCross = (g) => g.includes('writer-reader-contracts');
    const parts = [];
    const planEntries = [];
    packed.chunks.forEach((files, index) => {
        const filesSha = chunkFilesSha(files);
        const sub = chunkDiffText(diffText, files);
        const subId = diffCacheIdentity(sub);
        let chunkBytes = 0;
        // Same unquote fallback as packDiffIntoChunks: a git-quoted staged name misses the raw key
        // and would zero this chunk's telemetry bytes.
        for (const f of files)
            chunkBytes += packed.bytesByPath.get(f) ?? packed.bytesByPath.get(unquoteGitPath(f)) ?? 0;
        planEntries.push({ index, files_sha: filesSha, file_count: files.length, bytes: chunkBytes });
        const chunk = {
            index,
            filesSha,
            count: packed.chunks.length,
            capBytes: effectiveCap,
            planHash,
        };
        for (const g of groups) {
            if (isCross(g))
                continue;
            parts.push({
                sel: {
                    ...sel,
                    // SAFETY: planReviewWork only calls this planner when sel.reviewer.skill is set, so
                    // the entry is a ChecklistReviewer.
                    reviewer: deriveLensReviewer(sel.reviewer, g, index),
                    files: [...files],
                },
                key: keyOf(name, subId, `${salt}|split:${lensGroupId(g)}|chunk:${filesSha}`),
                diffText: sub,
                splitOf: name,
                group: lensGroupId(g),
                base: sel,
                chunk,
            });
        }
    });
    for (const g of groups) {
        if (!isCross(g))
            continue;
        parts.push({
            // SAFETY: same guard as the local-lens branch above — callers pass a checklist reviewer.
            sel: { ...sel, reviewer: deriveLensReviewer(sel.reviewer, g) },
            key: keyOf(name, wholeIdText, `${salt}|split:${lensGroupId(g)}`),
            diffText,
            splitOf: name,
            group: lensGroupId(g),
            base: sel,
        });
    }
    return {
        parts,
        planEntries,
        facts: { count: packed.chunks.length, capBytes: effectiveCap, planHash },
    };
}
