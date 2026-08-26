/**
 * Retention policy for a verdict store: which entries survive a write, and saying so out loud when
 * some do not.
 *
 * Split out of verdict-store.mts rather than inlined there because eviction is a POLICY decision
 * (how much judgement history is worth keeping) sitting inside a module whose job is atomicity and
 * locking. Keeping it here also lets the rationale below live next to the code it explains.
 *
 * Why the event exists: dropping a cached PASS is the one cache outcome that costs real money — the
 * next run re-spawns a judge (50-100s median, 30-min cap) for a verdict that was already earned —
 * and it was previously SILENT. A replay of ~/.devkit/telemetry/gate-events.jsonl over 3,035 review
 * judge executions found 99.5% of misses were on keys never cached before and ZERO were
 * evicted-then-needed, so the entry cap (100 at measurement time; 400 since sc-1907's chunked fan-out) was not costing anything. That measurement is a
 * snapshot of one machine's working set, not a property of the design: more worktrees per repo, more
 * reviewers, or a wider lens split all push toward the cap. Emitting the drop makes the next such
 * investigation a query instead of a study, per docs/decisions/gate-telemetry-self-describing.md.
 */
import path from 'node:path';
import { emitGateEvent } from './gate-events.mjs';
/** Newest-first by `at`, capped — and any drop is reported before it happens. */
export function retainNewest(entries, maxEntries, file) {
    const ranked = Object.entries(entries).sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')));
    if (ranked.length > maxEntries) {
        // Best-effort, like every other emitter here: telemetry must never fail a gate.
        emitGateEvent({
            type: 'cache_evicted',
            store: file ? path.basename(file) : 'unknown',
            dropped: ranked.length - maxEntries,
            retained: maxEntries,
        });
    }
    return Object.fromEntries(ranked.slice(0, maxEntries));
}
