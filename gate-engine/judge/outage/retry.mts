/** The ONE outage retry policy for every fail-closed judge gate, so the cascade and completeness
 *  cannot drift apart on what a re-spawn is allowed to clear. */
import type { JudgeOutage } from './classify.mts';

/** Below this much budget a retry cannot finish a real judgement, so the outage stands. */
export const RETRY_FLOOR_MS = 60_000;

export interface SpawnRetryOpts {
  /** Off outside strict ship: a fail-open gate gains nothing from a second spawn. */
  retry: boolean;
  label: string;
  /** ONE cap across both attempts, from the first spawn: a retry gets only what remains. */
  capMs: number;
  beforeRetry?: () => void;
}

/** Spawn a judge, re-spawning ONCE when the failure is one a re-spawn can clear. The outage
 *  returned is the last attempt's, so a remedy names the cause that actually ended the run. */
export async function spawnWithRetry<T>(
  spawn: (timeout: number, onOutage: (outage: JudgeOutage) => void) => Promise<T | null>,
  { retry, label, capMs, beforeRetry }: SpawnRetryOpts,
): Promise<{ result: T | null; outage?: JudgeOutage; retried: boolean }> {
  const deadline = Date.now() + capMs;
  const budgetLeft = () => Math.max(0, deadline - Date.now());
  let outage: JudgeOutage | undefined;
  const attempt = (timeout: number) => {
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
    console.error(
      `guard-review: ${label}: judge run failed (${outage?.kind ?? 'transient'}), retrying once…`,
    );
    beforeRetry?.();
    result = await attempt(budgetLeft());
  }
  return { result, outage, retried };
}
