/**
 * The shared settle path for judge outcomes + post-wave checklist recovery (sc-1476).
 *
 * Evidence: haiku judges' compliance with the mechanical checklist workflow degrades under
 * concurrent judge load — a solo judge over the same big diff completes 12/12 items; at 3
 * concurrent, a judge returned its verdict without engaging the workflow and its retry succeeded
 * only because a sibling had drained; at 10 judges, first attempts AND inline retries all failed.
 * The recovery retry therefore runs AFTER the wave, serially — the empirically-clean condition —
 * with the SAME one-attempt-per-reviewer budget the inline retry had.
 *
 * Scope, WIDENED by sc-2088: every STRICT path (ship, reship, review), not review alone. The
 * review-only bound was inherited from the inline retry rather than justified, and it left ship
 * failing closed over a judge that skipped its checklist while the gate's own remedy told the
 * operator to perform the retry by hand. Plain `git commit` still schedules none — it has no gate
 * supervisor to bound a serial phase, and it already fails open at exit 2.
 *
 * `settleReviewOutcome` is the ONE code path that checkpoints, records progress, holds lens
 * parts, and emits telemetry — the first wave and the deferred phase both go through it, so the
 * two can never drift. A retryable outcome short-circuits: no timing, no cache write, no completed
 * push, no lens hold, no review_result — the deferred attempt's settle does all of that (progress/
 * banner semantics: a parked reviewer is NOT completed until its recovery settles, so a kill
 * mid-phase still names it unfinished and the re-run converges on it).
 */

import { reportRetrievalDegraded, verdictToken } from '../contracts/checklist.mts';
import { parseAdvisories } from '../contracts/response.mts';
import { emitGateEvent } from '../../judge/gate-events.mts';
import { composeTranscript, saveTranscript } from '../../judge/transcript-store.mts';
import { savePasses } from '../cache.mts';
import {
  reportAdvisories,
  reportMcpDegraded,
  RETRIEVAL_REVIEWER,
  reviewBaseContext,
} from '../evidence/base-context.mts';
import { coverageFields, partialEvidenceNote } from '../evidence/packet/coverage.mts';
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
  // Only a PASS can be degraded: asset re-verification may have voided the verdict since.
  const degraded = res.status === 'pass' ? res.degraded : undefined;
  const mcpDegraded = res.status === 'pass' ? res.mcpDegraded : undefined;
  const advisories = res.status === 'pass' ? parseAdvisories(res.transcript ?? '') : [];
  if (res.status === 'pass')
    // res.model = the model that actually judged (a Reviewer.model pin wins over the cascade
    // default) — recording firstModel here mislabeled every pinned reviewer's cached PASS.
    savePasses(ctx.cwd, {
      [t.key]: {
        at: new Date().toISOString(),
        model: res.model ?? ctx.firstModel,
        duration_ms: durationMs,
        // The tree this verdict was judged against — the gate pins it before any evidence is read,
        // so a later replay can name it instead of borrowing its own run's base (sc-3468).
        base_sha: reviewBaseContext(ctx.cwd).baseSha,
        ...(t.splitOf ? cachedLensFields(res) : {}), // spill-safe lens re-seed (sc-1475)
        // A cache hit must replay DEGRADED, not a bare PASS (sc-2317). Undefined → dropped by JSON.
        degraded_cause: degraded?.cause,
        retrieval: res.name === RETRIEVAL_REVIEWER && !degraded ? 'ok' : undefined,
        // Its own field (sc-2837): `retrieval` above must keep describing retrieval alone.
        mcp_degraded_cause: mcpDegraded?.cause,
        // A replay names the waivers this PASS rests on, and a revoked one voids it (loadCache).
        waivers: res.waivers?.map(({ lens, fingerprint }) => ({ lens, fingerprint })),
        // Replayed on a cache hit, so a re-ship still shows what to resolve before merge.
        advisories: advisories.length ? advisories : undefined,
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
  // What the judge's packet actually covered (sc-2305) — on the verdict row, so a PASS over a
  // partial packet reaches the digest as unverified instead of reading like a whole-diff PASS.
  const coverage = coverageFields([t]);
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
    // Machine cause, so a consumer never parses the human-readable reason (gate-verdict-attribution).
    // JSON.stringify drops it when absent, which is exactly the pass/fail case.
    inconclusive_cause: res.inconclusiveCause,
    degraded_cause: degraded?.cause,
    mcp_degraded_cause: mcpDegraded?.cause,
    secs,
    // A recovered outcome stays measurable (gate-telemetry-self-describing): without this flag
    // the fix would erase the field rate of the very failure mode it schedules around. NEVER in
    // any cache key or salt — a recovered PASS must serve the next run's hit.
    ...(retried ? { retried: true, retry_phase: 'deferred' } : {}),
    ...(res.waivers?.length ? { waivers: res.waivers } : {}),
    // The per-lens vector, passes included; empty when the judge left no artifact (see
    // evidence/items.mts for the shape and the spill rule).
    ...itemFields(res),
    ...coverage,
    ...(transcriptRef ? { transcript_ref: transcriptRef } : {}),
  });
  // Surface the one-line verdict reason on the completion line too (fails get theirs in the
  // dedicated block below, with the full transcript — don't double-print it here).
  const tail =
    (!['fail', 'error'].includes(res.status) && res.reason ? ` — ${res.reason}` : '') +
    (res.status === 'pass' ? partialEvidenceNote(coverage) : '') +
    (res.status === 'pass' && transcriptRef ? ` · transcript ${transcriptRef}` : '');
  console.error(
    `guard-review: ${res.name} — ${verdictToken({ status: res.status, degraded, mcpDegraded })}${res.escalated ? ' (escalated)' : ''} in ${secs}s${res.status === 'pass' ? ' (checkpointed)' : ''}${tail}`,
  );
  // commit-guard never lens-splits (only correctness does), so the split branch above needs no
  // retrieval report; an MCP-degraded split reviewer is reported once at its merge (lens/split.mts).
  if (degraded) reportRetrievalDegraded(res.name, degraded.cause);
  if (mcpDegraded) reportMcpDegraded(res.name, mcpDegraded.cause);
  reportAdvisories(res.name, advisories, transcriptRef);
  return res;
}

// Never START a deferred cascade the ceiling is about to kill — a killed ship converges anyway
// (nothing checkpointed), but a named budget skip is honest where a 124 kill is opaque.
const MIN_RECOVERY_BUDGET_MS = 60_000;

// Held back from the judge's cap so the settle that follows it (cache write, transcript, telemetry)
// still lands inside the ceiling. A judge capped to the WHOLE remainder would finish exactly as the
// supervisor fires and lose the verdict it just paid for.
const RECOVERY_SETTLE_MARGIN_MS = 15_000;

/**
 * Milliseconds left before the gate chain is killed.
 *
 * The supervisor's absolute deadline wins whenever it is present (sc-2088). The fallback — the
 * duration minus THIS gate's own elapsed time — is only correct when guard-review is the whole
 * chain, which it never is under ship: gate-supervisor.mts wraps the entire `git commit`, so the
 * deterministic prefix and decisions cascade have already spent budget that `gateStartMs` cannot
 * see. Left as the fallback for the benches and direct invocations, which run no supervisor.
 *
 * The 3600 default matches run-gates-with-capture.sh and is the RULED value:
 * ship-gates-converge-not-restart records its own Ruling text of '1800s' as stale (2026-08-05 note,
 * recovering the evidence behind 0d759d4). Do not reconcile one literal to the other.
 */
function recoveryBudgetMs(gateStartMs: number): number {
  const deadline = Number(process.env.DEVKIT_GATE_DEADLINE_MS);
  if (Number.isFinite(deadline) && deadline > 0) return deadline - Date.now();
  return Number(process.env.SHIP_COMMIT_TIMEOUT ?? 3600) * 1000 - (Date.now() - gateStartMs);
}

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
  runOne: (task: ReviewTask, reason: string, budgetMs: number) => Promise<ReviewOutcome>,
  gateStartMs: number,
): Promise<void> {
  for (const p of parked) {
    const remaining = recoveryBudgetMs(gateStartMs);
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
    const res = await runOne(p.task, p.reason, remaining - RECOVERY_SETTLE_MARGIN_MS);
    results[p.index] = settleReviewOutcome(ctx, p.task, res, Date.now() - t0, true);
  }
}
