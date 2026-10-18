/** Reports the reviewers that stayed inconclusive. Under strict ship each row fails closed, and
 * rows needing the same Remedy share ONE copy, so an outage cannot bury the log in repeats. */

import { printRemedyOnce } from '../../judge/outage/remedy-once.mts';
import { strictRemedy } from '../../judge/run-judge.mts';
import { ENGINE_ERROR_REMEDY, RESPONSE_CONTRACT_REMEDY } from '../contracts/response.mts';
import type { ReviewOutcome } from '../runtime.mts';

function remedyText(r: ReviewOutcome, resetsAt?: number): string {
  const cause = r.inconclusiveCause ?? 'outage';
  if (cause === 'response-contract') return RESPONSE_CONTRACT_REMEDY;
  if (cause === 'engine') return ENGINE_ERROR_REMEDY;
  return strictRemedy(cause, r.outageBin, resetsAt);
}

/** An outage group names its latest reset: the conservative wait. */
function latestReset(group: ReviewOutcome[]): number | undefined {
  const resets = group.flatMap((r) => r.outageResetsAt ?? []);
  return resets.length ? Math.max(...resets) : undefined;
}

export function reportInconclusive(rows: ReviewOutcome[], strict: boolean): void {
  const groups = new Map<string, ReviewOutcome[]>();
  for (const r of rows) {
    // Producers carry the machine cause; human-readable reasons are never parsed as an API.
    const cause = r.inconclusiveCause ?? 'outage';
    console.error(
      strict
        ? `guard-review: ${r.name} INCONCLUSIVE (${r.reason}) — strict ship mode fails closed; see Remedy below.`
        : `guard-review: ${r.name} inconclusive — ${r.reason} (fail-open, not cached)`,
    );
    if (cause === 'response-contract' && r.transcript) console.error(r.transcript.trim());
    // Keyed on the wording minus its reset: a binary splits groups only where the remedy names it.
    const key = remedyText(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (!strict) return;
  for (const [key, group] of groups) {
    const resetsAt = latestReset(group);
    printRemedyOnce(key, remedyText(group[0], resetsAt), 'completed verdicts are cached', resetsAt);
  }
}

/** A judge that answered without a VERDICT line, worded as the fleet's; returns the gate exit. */
export function reportNoVerdict(name: string, transcript: string, strict: boolean): number {
  const row = {
    name,
    status: 'inconclusive',
    reason: 'no VERDICT line',
    escalated: false,
  } as const;
  reportInconclusive([{ ...row, inconclusiveCause: 'response-contract', transcript }], strict);
  return strict ? 3 : 2;
}
