// The evidence vocabulary ship writes into a PR body and a merge verdict reads back. One definition:
// the verdict imports these, it never re-declares them.
import {
  type RegressionEvidence,
  SKIPPED_ON_GREEN,
} from '../../baseline-status/regression-evidence.mts';

export const EVIDENCE_STATUSES = ['captured', 'inconclusive', 'not-run'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Why no red/green pair was captured. Set only on `not-run`, a deliberate abstention. */
export const EVIDENCE_ABSTENTIONS = [
  'no-test-change',
  'docs-only',
  'declared-no-behaviour-change',
  'platform-skipped',
  'not-configured',
] as const;
export type EvidenceAbstention = (typeof EVIDENCE_ABSTENTIONS)[number];

export interface EvidenceOutcome {
  status: EvidenceStatus;
  reason: EvidenceAbstention | null;
  detail: string;
  headSha: string;
  baseSha: string | null;
}

export const notRun = (
  reason: EvidenceAbstention,
  detail: string,
  headSha: string,
  baseSha: string | null,
): EvidenceOutcome => ({ status: 'not-run', reason, detail, headSha, baseSha });

export const inconclusive = (
  detail: string,
  headSha: string,
  baseSha: string | null,
): EvidenceOutcome => ({ status: 'inconclusive', reason: null, detail, headSha, baseSha });

/** A run whose deciding tests skipped on this host never ran them, so it abstains instead. */
export function outcomeFromRegression(
  evidence: RegressionEvidence,
  headSha: string,
  baseSha: string,
): EvidenceOutcome {
  if (evidence.status === 'captured') {
    return { status: 'captured', reason: null, detail: evidence.reason, headSha, baseSha };
  }
  const green = evidence.green.testCounts;
  const noneRanHere = green !== null && green.passed + green.failed === 0 && green.total > 0;
  if (evidence.reason === SKIPPED_ON_GREEN || noneRanHere) {
    return notRun('platform-skipped', 'the selected tests skipped on this host', headSha, baseSha);
  }
  return inconclusive(evidence.reason, headSha, baseSha);
}
