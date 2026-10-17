/** The CHECKLIST half of the reviewer response contract, beside response.mts (the prose half). */

import { z } from 'zod';
import { emitGateEvent } from '../../judge/gate-events.mts';
import {
  boundedCause,
  degradedSuffix,
  reportAdvisories,
  reportMcpDegraded,
  RETRIEVAL_REVIEWER,
} from '../evidence/base-context.mts';
import { attachItems } from '../evidence/items.mts';
import { lensGroupId } from '../lens/groups.mts';
import type { CachedHit } from '../lens/split.mts';
import { overriddenLine } from '../overrides.mts';
import type { Reviewer, ReviewerSelection } from '../reviewers.mts';
import {
  type ChecklistItem,
  type ChecklistState,
  cleanupChecklistState,
  deniedCalls,
  isNamedSkip,
  readChecklistState,
  type ReviewOutcome,
  verifyChecklist,
} from '../runtime.mts';

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
  denied?: string[] | null,
): Promise<ReviewOutcome> {
  // No stateFile means no artifact to verify; that reviewer's brief carries its own contract.
  if (initial.status !== 'pass' || !selection.reviewer.stateFile) return initial;
  let result = initial;
  const initialState = readChecklistState(cwd, selection.reviewer);
  const hole = verifyChecklist(initialState, 'PASS', denied);
  if (hole) reportFailedItems(selection.reviewer, initialState);
  if (hole && recoveryScheduled) {
    // No "retrying" here: the callback runs no judge, and the solo phase announces itself.
    console.error(
      `guard-review: ${selection.reviewer.name}${lensTag(selection.reviewer)} — checklist contract not satisfied (${hole})`,
    );
    cleanupChecklistState(cwd, selection.reviewer);
    result = await retry(hole);
    // The freshest artifact wins: a callback that ran its own judge left one, and classifying that
    // attempt from the pre-cleanup state would report the FIRST attempt's items. Falls back
    // to the captured state for today's callbacks, which run no judge and leave nothing.
    const settled = readChecklistState(cwd, selection.reviewer) ?? initialState;
    if (result.status !== 'pass') attachItems(result, settled, new Map());
    // Only when the retry left the cause open: an outage/timeout carries its own, and the operator
    // needs its auth/quota remedy rather than an artifact one.
    if (result.status === 'inconclusive' && result.inconclusiveCause === undefined)
      result.inconclusiveCause = 'response-contract';
  } else if (hole) {
    result.status = 'inconclusive';
    result.reason = hole;
    result.inconclusiveCause = 'response-contract';
  }
  return result;
}

/** The refused tool calls of a cascade's latest spawn; null until a spawn measures them. */
export interface SpawnDenials {
  denied: string[] | null;
}

const DENIED_SHOWN = 3;
const FAILED_SHOWN = 3;

/** Print the FAILED items behind a voided PASS, so a retry that passes cannot erase them. Display
 * only: the retry prompt keeps names alone, so the next judge is never asked to refute its finding. */
export function reportFailedItems(reviewer: Reviewer, state: ChecklistState | null): void {
  const failed = failedItems(state);
  for (const item of failed.slice(0, FAILED_SHOWN)) {
    const issue = Array.isArray(item.issues) ? boundedCause(String(item.issues[0] ?? '')) : '';
    console.error(
      `⚠️  guard-review: ${reviewer.name}${lensTag(reviewer)} — FAILED checklist item under a PASS verdict: ${boundedCause(String(item.name ?? item.path))}${issue ? ` — ${issue}` : ''}`,
    );
  }
  if (failed.length > FAILED_SHOWN)
    console.error(
      `⚠️  guard-review: ${reviewer.name}${lensTag(reviewer)} — (+${failed.length - FAILED_SHOWN} more)`,
    );
}

/** The artifact's failed items (`items[]`, or commit-guard's `files[]`); none when it is absent. */
function failedItems(state: ChecklistState | null): ChecklistItem[] {
  const items = state?.items ?? state?.files;
  return Array.isArray(items) ? items.filter((i) => i.status === 'fail') : [];
}

/** ` [lens]` for a split lens part, so its log lines match its completion line; '' otherwise. */
const lensTag = (reviewer: Reviewer): string =>
  reviewer.lens?.length ? ` [${lensGroupId(reviewer.lens)}]` : '';

/**
 * Name the refused tool calls beside a non-pass outcome; a PASS that lost a test run stays quiet.
 * A checklist FAIL with no failed item also gets the likely cause, but keeps its block.
 */
export function reportDeniedCalls(
  reviewer: Reviewer,
  res: Pick<ReviewOutcome, 'status'>,
  denied: string[] | null,
  state: ChecklistState | null = null,
): void {
  if (res.status === 'pass' || !denied?.length) return;
  const more = denied.length > DENIED_SHOWN ? ` (+${denied.length - DENIED_SHOWN} more)` : '';
  const shown = denied.slice(0, DENIED_SHOWN).map(boundedCause).join(' | ');
  const prefix = `⚠️  guard-review: ${reviewer.name}${lensTag(reviewer)} —`;
  console.error(`${prefix} ${deniedCalls(denied)}: ${shown}${more}`);
  if (res.status !== 'fail' || !reviewer.stateFile || failedItems(state).length > 0) return;
  // Only a pinned reviewer's FAIL reaches the override valve, so only it can be waived.
  const waive = reviewer.model ? ', and if it repeats, waive it citing the refusal' : '';
  console.error(
    `${prefix} no checklist item failed: if the reason cites no file:line defect, the refused calls are the likely cause — re-run${waive}`,
  );
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
export function verdictToken(
  res: Pick<ReviewOutcome, 'status' | 'degraded' | 'mcpDegraded'>,
): string {
  return `${res.status.toUpperCase()}${degradedSuffix(res)}`;
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

/** What a cached PASS replays beside its line: any degradation, and every waiver it rests on. */
export function reportCachedHitNotes(hit: CachedHit): void {
  // A cached split PART is reported once at its reviewer's merge, with the freshly judged groups.
  if (hit.mcpDegradedCause && !hit.part) reportMcpDegraded(hit.label, hit.mcpDegradedCause, true);
  for (const w of hit.waivers)
    console.error(overriddenLine(hit.label, w.lens, w.fingerprint, ' (cached PASS)'));
  reportAdvisories(hit.label, hit.advisories);
}
