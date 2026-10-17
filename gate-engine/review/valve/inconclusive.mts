/** Reports the reviewers that stayed inconclusive. Under strict ship each row fails closed, and
 * rows needing the same Remedy share ONE copy, so an outage cannot bury the log in repeats. */

import { FAMILY_ENV_KEYS } from '../../judge/outage/family-override.mts';
import { strictRemedy } from '../../judge/run-judge.mts';
import {
  CONTRACT_MISS,
  ENGINE_ERROR_REMEDY,
  RESPONSE_CONTRACT_REMEDY,
} from '../contracts/response.mts';
import type { ReviewOutcome } from '../runtime.mts';

const MODEL_KEYS = FAMILY_ENV_KEYS.filter((k) => k.key !== 'correctnessChunkLoc');

/** A refused-call miss has no finding to fix; the levers are a re-run and the judge's model. */
function refusedCallsRemedy(strict: boolean): string {
  const envs = MODEL_KEYS.map((k) => k.env).join(' / ');
  const keys = MODEL_KEYS.map((k) => `review.${k.key}`).join(' / ');
  return (
    'the judge was refused tool call(s) (listed above), which can leave its checklist unfinished ' +
    `without any finding in the diff; ${strict ? 're-run devkit ship, and if it repeats' : 'if it repeats,'} ` +
    `move that judge to another model (${envs}, or ${keys})`
  );
}

function remedyText(r: ReviewOutcome, strict: boolean, resetsAt?: number): string {
  const cause = r.inconclusiveCause ?? 'outage';
  if (cause === 'response-contract') {
    if (r.refusedCalls) return refusedCallsRemedy(strict);
    return strict ? RESPONSE_CONTRACT_REMEDY : CONTRACT_MISS;
  }
  if (cause === 'engine') return ENGINE_ERROR_REMEDY;
  return strictRemedy(cause, r.outageBin, resetsAt);
}

/** One group's remedy. An outage group names its latest reset: the conservative wait. */
function remedyFor(group: ReviewOutcome[]): string {
  const resets = group.flatMap((r) => r.outageResetsAt ?? []);
  return remedyText(group[0], true, resets.length ? Math.max(...resets) : undefined);
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
    // Fail-open stays quiet on an outage; a contract miss still names what the author can do.
    if (!strict && cause !== 'response-contract') continue;
    // Keyed on the wording minus its reset: a binary splits groups only where the remedy names it.
    const key = remedyText(r, strict);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, group] of groups) {
    console.error(
      strict
        ? `   Remedy: ${remedyFor(group)} (completed verdicts are cached).`
        : `   Remedy: ${key}.`,
    );
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
