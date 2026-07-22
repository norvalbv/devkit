/**
 * Best-effort append-only telemetry sink for `devkit ship`/`reship` gate events. Mirrors
 * progress.mts (env-keyed, fs-only, never throws) and lives in the judge domain for the same reason
 * verdict-store.mts does: it is a shared side-channel service every verdict-producing engine
 * (deterministic, decisions, review) depends on — one emitter here, not a vendored copy per engine.
 *
 * A ship exports DEVKIT_GATE_EVENTS (sink path) + DEVKIT_SHIP_ID (correlates every gate/reviewer
 * event of one ship attempt) through the hook chain — the SAME inheritance path git→husky→node that
 * carries DEVKIT_REVIEW_PROGRESS — so each in-chain gate stamps the same ship_id. When the env is
 * unset (an ad-hoc commit, not a ship) emit is a no-op, so ONLY ships produce telemetry.
 *
 * Failure direction: any IO error is swallowed — telemetry must NEVER fail a gate. Each event is one
 * JSON line appended with a single O_APPEND write, so concurrent judges can't tear each other's lines
 * (sub-4KB writes are atomic on APFS/ext4). The downstream reader (the usage tracker's collector)
 * tail-ingests this file and skips/retries any partial trailing line.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runEnvelope, telemetrySink } from "./run-context.mjs";
/**
 * Append one gate/reviewer/ship event to the telemetry sink (no-op when there is none). The sink is
 * the ship's DEVKIT_GATE_EVENTS, or — by default for every commit, unless DEVKIT_NO_TELEMETRY=1 — the
 * default ~/.devkit/telemetry sink. runEnvelope() stamps the correlation id (ship_id) plus, for a
 * commit run, run_mode/repo/branch so the collector can synthesise a run. Never throws.
 */
export function emitGateEvent(ev) {
    const file = telemetrySink();
    if (!file)
        return;
    try {
        mkdirSync(path.dirname(file), { recursive: true });
        const line = `${JSON.stringify({
            ...ev,
            ...runEnvelope(),
            ts: new Date().toISOString(),
        })}\n`;
        appendFileSync(file, line, { flag: 'a' });
    }
    catch {
        /* telemetry is best-effort — never fail a gate over it */
    }
}
