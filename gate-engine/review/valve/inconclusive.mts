/** Reports the reviewers that stayed inconclusive. Under strict ship each row fails closed, and
 * rows sharing a cause and binary share ONE Remedy, so an outage cannot bury the log in copies. */

import { strictRemedy } from '../../judge/run-judge.mts';
import { ENGINE_ERROR_REMEDY, RESPONSE_CONTRACT_REMEDY } from '../contracts/response.mts';
import type { ReviewOutcome } from '../runtime.mts';

/** One group's remedy. An outage group names its latest reset: the conservative wait. */
function remedyFor(group: ReviewOutcome[]): string {
  const { inconclusiveCause: cause = 'outage', outageBin } = group[0];
  if (cause === 'response-contract') return RESPONSE_CONTRACT_REMEDY;
  if (cause === 'engine') return ENGINE_ERROR_REMEDY;
  const resets = group.flatMap((r) => r.outageResetsAt ?? []);
  return strictRemedy(cause, outageBin, resets.length ? Math.max(...resets) : undefined);
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
    const key = `${cause}|${r.outageBin ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (!strict) return;
  for (const group of groups.values()) {
    console.error(`   Remedy: ${remedyFor(group)} (completed verdicts are cached).`);
  }
}
