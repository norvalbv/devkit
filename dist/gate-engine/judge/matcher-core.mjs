// Shared per-slot forced-choice matcher engine — the third consumer arrived (conventions-eval,
// sc-1058's own ticket having named this as the extraction trigger for its second: critique-eval),
// so the ~90%-identical core that used to live duplicated in review/eval/matcher.mts and
// critique/eval/matcher.mts now lives here. Each bench keeps its OWN Finding/GoldSlot/DecoySlot
// shapes, its own transcript parser, its own prompt nouns (buildGoldPrompt/buildDecoyPrompt), and
// its own scoreCase severity rule — those genuinely diverge. This module owns only what was
// byte-for-byte identical: bounded-concurrency mapping, per-slot vote counting, the forced-choice
// reply parser, the K-vote runner, and the audit kappa.
//
// A matcher-core edit invalidates ALL THREE benches' matcherHash simultaneously — a new cross-bench
// hazard versus each bench owning its own matcher file. Re-run every consumer's `matcher-audit`
// after touching this file.
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from "./judge-isolation.mjs";
import { execJudgeAsync } from "./run-judge.mjs";
export const MATCH_TIMEOUT_MS = 60000;
/** Tiny bounded-concurrency map — dep-free, order-preserving. */
export async function mapPool(items, width, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next;
            next += 1;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
    return results;
}
/**
 * Parse one forced-choice reply. The LAST `SLOT:` line wins (models sometimes think aloud first).
 * Returns the 1-based finding number, 0 for NONE, or null when unparseable / out of range — null
 * is a matcher outage for that trial, never a silent NONE.
 */
export function parseSlotReply(raw, findingCount) {
    const lines = [
        ...String(raw).matchAll(/^[\s>*#-]*\**SLOT\**\s*:\s*(NONE|F?\s*(\d+))\s*\**\s*$/gim),
    ];
    if (lines.length === 0)
        return null;
    const last = lines[lines.length - 1];
    if (last[1].toUpperCase() === 'NONE')
        return 0;
    const n = Number(last[2]);
    return Number.isInteger(n) && n >= 1 && n <= findingCount ? n : null;
}
/** Majority vote over per-trial matches; a full tie or an all-null slot fails safe. Votes are
 * stringified finding numbers ('0' = NONE); null trials vote 'NULL'. */
export function voteSlot(trials) {
    const counts = new Map();
    for (const t of trials) {
        const key = t === null ? 'NULL' : String(t);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const tie = sorted.length > 1 && sorted[0][1] === sorted[1][1];
    const winner = tie ? 'NULL' : sorted[0][0];
    if (winner === 'NULL') {
        // Distinguish "all trials dark" (outage) from "the votes disagreed" (instability → NONE).
        const allNull = trials.every((t) => t === null);
        return { match: 0, stable: false, outage: allNull };
    }
    return { match: Number(winner), stable: sorted.length === 1, outage: false };
}
/**
 * Ask every slot's pre-built question against `findingCount` numbered findings. Zero findings
 * short-circuits deterministically (all gold missed, all decoys clean) — no claude call. Each
 * trial retries once on a dark/unparseable reply before voting NULL.
 */
export async function runSlotQuestions(slots, findingCount, { model = 'haiku', runs = 3, concurrency = 4, exec = execJudgeAsync, cwd, labelPrefix = 'matcher', } = {}) {
    if (findingCount === 0)
        return slots.map(({ slotId, kind }) => ({
            slotId,
            kind,
            match: 0,
            stable: true,
            outage: false,
        }));
    // One work item per (slot, trial) so the pool bounds TOTAL concurrent claude calls, not slots.
    const trials = slots.map(() => []);
    const work = slots.flatMap((_, si) => Array.from({ length: runs }, () => ({ si })));
    await mapPool(work, concurrency, async ({ si }) => {
        const ask = () => exec({
            label: `${labelPrefix}:matcher:${slots[si].slotId}`,
            args: ['-p', slots[si].prompt, '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION],
            timeout: MATCH_TIMEOUT_MS,
            cwd,
        });
        let raw = await ask();
        let parsed = raw === null ? null : parseSlotReply(raw, findingCount);
        if (parsed === null) {
            raw = await ask(); // one retry — a single flake shouldn't cost the slot
            parsed = raw === null ? null : parseSlotReply(raw, findingCount);
        }
        trials[si].push(parsed);
    });
    return slots.map(({ slotId, kind }, si) => ({ slotId, kind, ...voteSlot(trials[si]) }));
}
/**
 * Cohen's kappa between two label sequences (the matcher-audit agreement stat). Chance-corrected
 * because raw percent agreement flatters a matcher on skewed slots — most slots are NONE, and a
 * matcher that always says NONE "agrees" often (arXiv:2606.19544's exact-match inflation).
 */
export function kappa(a, b) {
    if (a.length !== b.length || a.length === 0)
        return Number.NaN;
    const n = a.length;
    const labels = [...new Set([...a, ...b])];
    let observed = 0;
    const countA = new Map();
    const countB = new Map();
    for (let i = 0; i < n; i += 1) {
        if (a[i] === b[i])
            observed += 1;
        countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
        countB.set(b[i], (countB.get(b[i]) ?? 0) + 1);
    }
    const po = observed / n;
    let pe = 0;
    for (const l of labels)
        pe += ((countA.get(l) ?? 0) / n) * ((countB.get(l) ?? 0) / n);
    return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
