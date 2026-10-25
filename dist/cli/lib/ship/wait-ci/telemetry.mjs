/** The `ship_ci` telemetry row `wait.mts` appends after its verdict line. */
import { appendShipRow } from '../telemetry/row.mjs';
/**
 * The queryable half of the verdict, beside ship_pr on the same JSONL stream. Best-effort: telemetry
 * must never be the thing that fails a ship (ship-branch.sh writes its own rows under `|| true`).
 */
export function recordCiEvent(result, pr, env = process.env) {
    const file = env.DEVKIT_GATE_EVENTS;
    const shipId = env.DEVKIT_SHIP_ID;
    if (!file || !shipId)
        return;
    const row = {
        type: 'ship_ci',
        ship_id: shipId,
        devkit_version: env.DEVKIT_TELEMETRY_VERSION ?? null,
        pr_number: /^\d+$/.test(pr) ? Number(pr) : null,
        outcome: result.outcome,
        failing: result.failures.map((f) => f.name),
        pending: result.pending.map((p) => p.name),
        waited_s: Math.round(result.elapsedMs / 1000),
        polls: result.polls,
        reason: result.unavailableReason ?? null,
        required: result.required ?? false,
        required_contexts: result.requiredContexts ?? null,
        attribution: result.attribution?.token ?? null,
        inherited: result.attribution?.inherited ?? null,
        new_failures: result.attribution?.fresh ?? null,
        ts: new Date().toISOString(),
    };
    appendShipRow(file, row, env);
}
