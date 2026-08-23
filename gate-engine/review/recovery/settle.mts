/**
 * The shared settle path for judge outcomes + post-wave checklist recovery (sc-1476).
 *
 * Evidence: haiku judges' compliance with the mechanical checklist workflow degrades under
 * concurrent judge load — a solo judge over the same big diff completes 12/12 items; at 3
 * concurrent, a judge returned its verdict without engaging the workflow and its retry succeeded
 * only because a sibling had drained; at 10 judges, first attempts AND inline retries all failed.
 * The recovery retry therefore runs AFTER the wave, serially — the empirically-clean condition —
 * with the SAME one-attempt-per-reviewer budget the inline retry had. REVIEW-ONLY, unchanged from
 * the inline retry it replaces (review-gate-in-chain 2026-07-16: commit/ship never had a
 * checklist retry and keep none; their voided PASSes stay inconclusive).
 *
 * `settleReviewOutcome` is the ONE code path that checkpoints, records progress, holds lens
 * parts, and emits telemetry — the first wave and the deferred phase both go through it, so the
 * two can never drift. A retryable outcome short-circuits: no timing, no cache write, no completed
 * push, no lens hold, no review_result — the deferred attempt's settle does all of that (progress/
 * banner semantics: a parked reviewer is NOT completed until its recovery settles, so a kill
 * mid-phase still names it unfinished and the re-run converges on it).
 */

import { emitGateEvent } from '../../judge/gate-events.mts';
import { composeTranscript, saveTranscript } from '../../judge/transcript-store.mts';
import { savePasses } from '../cache.mts';
import { archiveFailedDiff } from '../evidence/diff-archive.mts';
import { cachedLensFields, itemFields } from '../evidence/items.mts';
import { holdLensPart, type LensPart, type ReviewTask, taskLabel } from '../lens/split.mts';
import { writeProgress } from '../progress.mts';
import type { ReviewerSelection } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';
import type { ReviewGateTiming } from '../telemetry/timing.mts';

/** A cascade outcome that a defer-mode contract check parked for post-wave recovery. The field
 * lives here (not on ReviewOutcome) because only this module and runCascade's defer callback ever
 * read it — the exit-code scans and telemetry must never see a parked outcome at all. */
export interface RecoverableOutcome extends ReviewOutcome {
  retryable?: string;
}

export const retryableReason = (res: ReviewOutcome): string | undefined =>
  (res as RecoverableOutcome).retryable;

/** Everything the settle path touches, captured once per gate run. */
export interface SettleCtx {
  cwd: string;
  firstModel: string;
  progressFile: string | null;
  running: string[];
  completed: string[];
  splitParts: Map<string, LensPart[]>;
  timing: ReviewGateTiming;
  verifyAssets: (outcome: ReviewOutcome, base: ReviewerSelection) => ReviewOutcome;
}

/**
 * Settle one cascade outcome: asset re-verification, timing, PASS checkpoint, fail archive,
 * progress, and telemetry-or-lens-hold. Extracted verbatim from runReviewGate's mapLimit `.then`
 * so the deferred phase settles through the identical path. Returns the (possibly replaced)
 * outcome that belongs in `results`.
 */
export function settleReviewOutcome(
  ctx: SettleCtx,
  t: ReviewTask,
  outcome: ReviewOutcome,
  durationMs: number,
  retried = false,
): ReviewOutcome {
  const res = ctx.verifyAssets(outcome, t.base);
  // Parked for post-wave recovery: NOTHING lands, the duration included. ReviewGateTiming keys
  // observed work by reviewer name and OVERWRITES (Map.set), so recording the voided attempt here
  // would only be clobbered by the deferred settle — the gate's own wall clock counts that time
  // either way. The deferred attempt's settle is the one that counts.
  if (retryableReason(res)) return res;
  ctx.timing.observed(res.name, durationMs);
  if (res.status === 'pass')
    // res.model = the model that actually judged (a Reviewer.model pin wins over the cascade
    // default) — recording firstModel here mislabeled every pinned reviewer's cached PASS.
    savePasses(ctx.cwd, {
      [t.key]: {
        at: new Date().toISOString(),
        model: res.model ?? ctx.firstModel,
        duration_ms: durationMs,
        ...(t.splitOf ? cachedLensFields(res) : {}), // spill-safe lens re-seed (sc-1475)
      },
    });
  if (res.status === 'fail') archiveFailedDiff(t.diffText);
  if (ctx.progressFile) {
    ctx.completed.push(taskLabel(t));
    writeProgress(ctx.progressFile, { running: ctx.running, completed: ctx.completed });
  }
  const secs = Math.round(durationMs / 1000);
  // Persist the full judge transcript — the reviewed diff AND the agent's output — so a PASS
  // reviewer's reasoning is fetchable on demand rather than discarded; the event carries only
  // the ref + one-liner. No-op off-run (see run-context.mts).
  if (t.splitOf) {
    holdLensPart(ctx.splitParts, t.splitOf, { res, secs, task: t, retried }, taskLabel(t));
    return res;
  }
  const transcriptRef = res.transcript
    ? saveTranscript(`review-${res.name}`, composeTranscript(t.diffText, res.transcript))
    : null;
  // Ship telemetry (best-effort, no-op off-ship): every reviewer outcome (pass/fail/
  // inconclusive) so the usage tracker can report per-reviewer error counts and fail-rate.
  emitGateEvent({
    type: 'review_result',
    reviewer: res.name,
    status: res.status,
    escalated: res.escalated,
    // First-pass model that actually ran (pin-aware); firstModel only when no judge ran at
    // all (missing brief / engine error), keeping the field always present for consumers.
    model: res.model ?? ctx.firstModel,
    reason: res.reason,
    secs,
    // A recovered outcome stays measurable (gate-telemetry-self-describing): without this flag
    // the fix would erase the field rate of the very failure mode it schedules around. NEVER in
    // any cache key or salt — a recovered PASS must serve the next run's hit.
    ...(retried ? { retried: true, retry_phase: 'deferred' } : {}),
    ...(res.waivers?.length ? { waivers: res.waivers } : {}),
    // The per-lens vector, passes included; empty when the judge left no artifact (see
    // evidence/items.mts for the shape and the spill rule).
    ...itemFields(res),
    ...(transcriptRef ? { transcript_ref: transcriptRef } : {}),
  });
  // Surface the one-line verdict reason on the completion line too (fails get theirs in the
  // dedicated block below, with the full transcript — don't double-print it here).
  const tail = !['fail', 'error'].includes(res.status) && res.reason ? ` — ${res.reason}` : '';
  console.error(
    `guard-review: ${res.name} — ${res.status.toUpperCase()}${res.escalated ? ' (escalated)' : ''} in ${secs}s${res.status === 'pass' ? ' (checkpointed)' : ''}${tail}`,
  );
  return res;
}

// Never START a deferred cascade the ceiling is about to kill — a killed ship converges anyway
// (nothing checkpointed), but a named budget skip is honest where a 124 kill is opaque.
const MIN_RECOVERY_BUDGET_MS = 60_000;

/** One parked first-wave outcome awaiting its post-wave attempt. */
export interface ParkedRecovery {
  task: ReviewTask;
  reason: string;
  index: number;
}

/**
 * Re-run each parked cascade SERIALLY (the whole point: one judge in flight), settle it through
 * the shared path with `retried` marked, and replace its slot in `results`. One attempt per
 * reviewer total — the deferred run IS the retry, so it must be invoked with the terminal
 * recovery mode and retryFirst OFF (an outage there stays inconclusive; stacking the strict
 * outage retry would triple the worst-case cost of a phase that runs against the same ceiling).
 */
export async function runDeferredRecoveries(
  parked: ParkedRecovery[],
  results: ReviewOutcome[],
  ctx: SettleCtx,
  runOne: (task: ReviewTask, reason: string) => Promise<ReviewOutcome>,
  gateStartMs: number,
): Promise<void> {
  const ceilingMs = Number(process.env.SHIP_COMMIT_TIMEOUT ?? 3600) * 1000;
  for (const p of parked) {
    const remaining = ceilingMs - (Date.now() - gateStartMs);
    if (remaining < MIN_RECOVERY_BUDGET_MS) {
      const skipped: ReviewOutcome = {
        name: p.task.sel.reviewer.name,
        status: 'inconclusive',
        reason: `recovery deferred, budget exhausted — re-run to converge (${p.reason})`,
        inconclusiveCause: 'timeout',
        escalated: false,
      };
      // NOT marked retried: no deferred judge ran. The flag measures attempts that happened, so
      // counting a skip would inflate the very recovery rate it exists to report — the reason
      // string is what names this outcome.
      results[p.index] = settleReviewOutcome(ctx, p.task, skipped, 0);
      continue;
    }
    console.error(
      `guard-review: ${p.task.sel.reviewer.name} — checklist contract not satisfied under the concurrent wave; retrying solo (${p.reason})`,
    );
    const t0 = Date.now();
    const res = await runOne(p.task, p.reason);
    results[p.index] = settleReviewOutcome(ctx, p.task, res, Date.now() - t0, true);
  }
}
