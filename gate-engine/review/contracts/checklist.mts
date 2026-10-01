/** The CHECKLIST half of the reviewer response contract, beside response.mts (the prose half). */

import { z } from 'zod';
import { emitGateEvent } from '../../judge/gate-events.mts';
import { boundedCause, RETRIEVAL_REVIEWER } from '../evidence/base-context.mts';
import { attachItems } from '../evidence/items.mts';
import type { ReviewerSelection } from '../reviewers.mts';
import {
  type ChecklistState,
  cleanupChecklistState,
  isNamedSkip,
  readChecklistState,
  type ReviewOutcome,
  verifyChecklist,
} from '../runtime.mts';
import type { ReviewInconclusiveCause } from './response.mts';

/**
 * Verify the artifact behind a PASS and, when the caller SCHEDULED a recovery, hand the hole to it.
 * Eligibility is the caller's `recovery` mode, never `assetRoot` (sc-2088).
 */
export async function enforceChecklistContract(
  selection: ReviewerSelection,
  initial: ReviewOutcome,
  cwd: string,
  recoveryScheduled: boolean,
  retry: (reason: string) => Promise<ReviewOutcome>,
): Promise<ReviewOutcome> {
  // No stateFile means no artifact to verify; that reviewer's brief carries its own contract.
  if (initial.status !== 'pass' || !selection.reviewer.stateFile) return initial;
  let result = initial;
  const initialState = readChecklistState(cwd, selection.reviewer);
  const hole = verifyChecklist(initialState, 'PASS');
  if (hole && recoveryScheduled) {
    console.error(
      `guard-review: ${selection.reviewer.name} — checklist contract not satisfied; retrying once (${hole})`,
    );
    cleanupChecklistState(cwd, selection.reviewer);
    result = await retry(hole);
    if (initial.transcript && result.transcript)
      result.transcript = `${initial.transcript}\n\n───── CHECKLIST-CONTRACT RETRY ─────\n${result.transcript}`;
    // The freshest artifact wins: a callback that ran its own judge left one, and classifying that
    // attempt from the pre-cleanup state would report the FIRST attempt's kind of hole. Falls back
    // to the captured state for today's callbacks, which run no judge and leave nothing.
    const settled = readChecklistState(cwd, selection.reviewer) ?? initialState;
    if (result.status !== 'pass') attachItems(result, settled, new Map());
    // Only when the retry left the cause open: an outage/timeout carries its own, and the operator
    // needs its auth/quota remedy rather than an artifact one.
    if (result.status === 'inconclusive' && result.inconclusiveCause === undefined)
      result.inconclusiveCause = checklistHoleCause(settled);
  } else if (hole) {
    result.status = 'inconclusive';
    result.reason = hole;
    result.inconclusiveCause = checklistHoleCause(initialState);
  }
  return result;
}

function checklistHoleCause(state: ChecklistState | null): ReviewInconclusiveCause {
  // Keyed on whether an artifact EXISTS, not on whether it has rows. `readChecklistState` returns
  // null only when the file is absent or unreadable — the shape a never-synced script leaves. A
  // present artifact, even an empty one, proves the script ran, so its hole is the judge's.
  return state === null ? 'sync' : 'response-contract';
}

/** The recorded retrieval outcome. Anything else — absent, a typo'd status, a blank cause — is not
 * evidence that retrieval ran, so the gate reads it as DEGRADED rather than as `ok`. */
const retrievalSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('unavailable'), cause: z.string().trim().min(1) }),
]);

export const RETRIEVAL_UNRECORDED =
  'retrieval status not recorded — finalize ran without --retrieval, or the synced checklist ' +
  'script predates it (devkit sync-skills)';

/** Why a commit-guard PASS did not fully verify (sc-2317). Only an explicit `{status:'ok'}` clears
 * it — an absent or malformed record is no evidence retrieval ran; a named skip never degrades. */
export function retrievalDegradation(
  reviewerName: string,
  state: ChecklistState | null,
  status: ReviewOutcome['status'],
): { cause: string } | undefined {
  if (reviewerName !== RETRIEVAL_REVIEWER || status !== 'pass' || isNamedSkip(state))
    return undefined;
  const recorded = retrievalSchema.safeParse(state?.retrieval);
  if (!recorded.success) return { cause: RETRIEVAL_UNRECORDED };
  return recorded.data.status === 'ok' ? undefined : { cause: boundedCause(recorded.data.cause) };
}

/** The status token a completion line prints — never a bare PASS for a degraded one. */
export function verdictToken(res: Pick<ReviewOutcome, 'status' | 'degraded'>): string {
  return `${res.status.toUpperCase()}${res.degraded ? ' (DEGRADED)' : ''}`;
}

/**
 * Surface a degraded PASS on every channel an operator or agent audits: a ⚠️ stderr line (the ship
 * log's documented marker) and a `gate_degraded` event (the ship digest's "unverified" row).
 */
export function reportRetrievalDegraded(name: string, rawCause: string): void {
  const cause = boundedCause(rawCause); // the sink re-bounds, whatever path the cause took here
  const detail = `semantic retrieval unavailable: ${cause} — only the deterministic matcher and clone gates checked duplication`;
  console.error(`⚠️  guard-review: ${name} — DEGRADED: ${detail}`);
  emitGateEvent({ type: 'gate_degraded', judge: name, cause, detail });
}
