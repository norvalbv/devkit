/** Below this much budget a retry cannot finish a real judgement, so the outage stands. */
export const RETRY_FLOOR_MS = 60_000;
/** Spawn a judge, re-spawning ONCE when the failure is one a re-spawn can clear. The outage
 *  returned is the last attempt's, so a remedy names the cause that actually ended the run. */
export async function spawnWithRetry(spawn, { retry, label, capMs, beforeRetry }) {
    const deadline = Date.now() + capMs;
    const budgetLeft = () => Math.max(0, deadline - Date.now());
    let outage;
    const attempt = (timeout) => {
        outage = undefined;
        return spawn(timeout, (o) => {
            outage = o;
        });
    };
    let result = await attempt(capMs);
    // `permanent`, not `!== 'timeout'`: a usage lock cannot clear inside a retry, and re-spawning it
    // cost EIGHT wasted judge calls per ship for six days. A timeout stays permanent as before.
    const retried = result === null && retry && !outage?.permanent && budgetLeft() >= RETRY_FLOOR_MS;
    if (retried) {
        console.error(`guard-review: ${label}: judge run failed (${outage?.kind ?? 'transient'}), retrying once…`);
        beforeRetry?.();
        result = await attempt(budgetLeft());
    }
    return { result, outage, retried };
}
