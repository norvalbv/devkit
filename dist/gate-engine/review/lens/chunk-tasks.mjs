/**
 * Chunked-mode task planning (sc-1907) — split out of split.mts (guard-size). planReviewWork
 * calls planChunkedParts per correctness selection; null (off / under trigger) falls back to the
 * un-chunked shape whose keys stay byte-identical to the pre-chunking engine.
 */
import { diffCacheIdentity } from "../../judge/diff-focus.mjs";
import { chunkDiffText, chunkFilesSha, chunkPlanHash, identityBytesByPath, packDiffIntoChunks, unquoteGitPath, } from "./chunk.mjs";
import { deriveLensReviewer, lensGroupId } from "./groups.mjs";
/**
 * Parse `GUARD_CORRECTNESS_CHUNK` into a chunk cap in LOC, or null when chunking is off — the
 * DEFAULT. Off means planReviewWork's keys and tasks are byte-identical to the pre-chunking
 * engine (the kill switch the sc-1907 rollout registers on). A malformed value throws rather
 * than silently running unchunked: a correctness knob that quietly no-ops is exactly the
 * blindness this reviewer exists to prevent.
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
    // The unit is LOC; an earlier design draft used BYTES (24000). A byte-scale value is
    // valid-but-wrong and would make chunking silently never trigger — the exact quiet no-op the
    // malformed-value throw exists to prevent. The whole-diff evidence cap is 60KB (~1500 LOC), so
    // no honest LOC cap approaches this bound.
    if (n > 4000)
        throw new Error(`GUARD_CORRECTNESS_CHUNK: '${spec}' looks like a BYTE count — the unit is LOC (try ${Math.round(n / 40)})`);
    return n;
}
/** LOC→identity-bytes conversion used everywhere chunk caps are sized (~40 bytes/line). */
const CHUNK_BYTES_PER_LOC = 40;
/** Chunk only when the diff meaningfully exceeds the cap — at or under 1.5x, one judge per lens
 * reads the whole diff better than two judges reading halves (bench: whole beats chunks on small
 * diffs for every default-effort model). */
const CHUNK_TRIGGER_RATIO = 1.5;
/** Hard ceiling on judge fan-out per reviewer: 4 chunks x 3 local lenses + 1 cross-file judge.
 * Oversized diffs re-pack at doubled caps until they fit — fewer, larger chunks, never more
 * judges (recovery scheduling is proven at this concurrency, sc-1476). */
const MAX_CHUNKS = 4;
/**
 * The chunked task plan for ONE correctness selection, or null when the diff is under the
 * trigger (callers then fall back to the un-chunked shape). Local lens groups fan out per chunk
 * over the CHUNK'S files — the judge's evidence, override-valve diff, and checklist state all
 * derive from `sel.files`, so scoping the derived selection scopes the whole judge. Any group
 * carrying `writer-reader-contracts` stays whole-diff (its lens is the cross-file guard), and its
 * key deliberately matches the un-chunked key: the judged content is identical in both modes, so
 * a verdict earned either side of the flag serves the other.
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
        // Same unquote fallback as packDiffIntoChunks' own lookup: a git-QUOTED staged name (space/
        // non-ASCII under core.quotePath) misses the raw key and would silently zero this chunk's
        // telemetry bytes — the very field the sc-1907 rollout readout consumes.
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
                    // SAFETY: planReviewWork only calls this planner when sel.reviewer.skill is set — the
                    // checklist type guard's own predicate — so the correctness entry is a ChecklistReviewer.
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
