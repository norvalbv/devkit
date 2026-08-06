import { emitGateTiming } from "../../judge/gate-events.mjs";
// 6, not 3: the correctness lens split turns one reviewer into up to four pool tasks, so a
// backend commit schedules ~8 (4 lenses + 4 domain reviewers). At 6 the lens wave and most of the
// fleet run in one wave and the review makespan approaches the slowest single judge instead of
// packing eight tasks into three slots. The bound that matters is subscription slots, not CPU or
// memory — watch judge timeout rates, not RSS, if this ever needs lowering.
const DEFAULT_REVIEW_CONCURRENCY = 6;
/** Max judge cascades in flight; invalid settings preserve the default. */
export function reviewConcurrency() {
    const n = Number.parseInt(process.env.GUARD_REVIEW_CONCURRENCY ?? process.env.FRINK_REVIEW_CONCURRENCY ?? '', 10);
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_REVIEW_CONCURRENCY;
}
/** Order-preserving bounded-pool makespan used by the live scheduler and effective telemetry. */
export function parallelMakespan(durationsMs, limit) {
    if (durationsMs.length === 0)
        return 0;
    const slots = Array.from({ length: Math.max(1, Math.min(Math.floor(limit), durationsMs.length)) }, () => 0);
    for (const raw of durationsMs) {
        let next = 0;
        for (let i = 1; i < slots.length; i++)
            if (slots[i] < slots[next])
                next = i;
        slots[next] += Number.isFinite(raw) ? Math.max(0, raw) : 0;
    }
    return Math.max(...slots);
}
/** Tracks cached and live reviewer work without serialising bounded-parallel durations. */
export class ReviewGateTiming {
    startedAt = Date.now();
    names = [];
    concurrency = 1;
    cachedCount = 0;
    observedDurations = new Map();
    effectiveDurations = new Map();
    configure(names, concurrency) {
        this.names = names;
        this.concurrency = concurrency;
    }
    cacheHit(name, durationMs) {
        this.cachedCount++;
        this.effectiveDurations.set(name, durationMs);
    }
    observed(name, durationMs) {
        this.observedDurations.set(name, durationMs);
        this.effectiveDurations.set(name, durationMs);
    }
    finish(code) {
        const actualDurationMs = Date.now() - this.startedAt;
        const makespan = (durations) => parallelMakespan(this.names.map((name) => durations.get(name) ?? 0), this.concurrency);
        const observedWorkMs = makespan(this.observedDurations);
        const effectiveWorkMs = makespan(this.effectiveDurations);
        const cacheState = this.cachedCount === 0 ? 'none' : this.cachedCount === this.names.length ? 'full' : 'partial';
        emitGateTiming('review', actualDurationMs, actualDurationMs + Math.max(0, effectiveWorkMs - observedWorkMs), cacheState, this.concurrency);
        return code;
    }
}
