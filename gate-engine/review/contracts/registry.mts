import {
  conventionWaiverLenses,
  parseConventionFindingCandidates,
} from '../evidence/conventions.mts';
import { type GroundingSource, groundConventionFindings } from './conventions-grounding.mts';

export interface ReviewerResponseContract {
  /** Stable cache salt; changing contract semantics invalidates verdicts earned under old rules. */
  identity: string;
  /** The waiver lenses (evidence/conventions.mts conventionWaiverLens) of a FAIL's findings that survive the contract, read against the reviewed
   * change (`source`); a FAIL blocks only when at least one survives, and only these can be waived. */
  blockingLenses: (raw: string, source: GroundingSource) => string[];
  retryInstruction: string;
  missingEvidenceReason: (retried: boolean) => string;
}

const RESPONSE_CONTRACTS = {
  'conventions-v1': Object.freeze({
    // The verdict cache salts on this. v2 (sc-2181): authoritative post-change line counts. v3
    // (sc-3580): an OFFENDING quote must exist in the change it cites, so v2 FAILs must not replay.
    // v4 (sc-3324): lenses are rule + file, from EVERY grounded pair, not one per path:line.
    identity: 'conventions-v4:rule-file-lens',
    blockingLenses: (raw: string, source: GroundingSource) =>
      conventionWaiverLenses(
        groundConventionFindings(parseConventionFindingCandidates(raw), source),
      ),
    retryInstruction:
      'EVIDENCE-CONTRACT RETRY: the prior FAIL had no complete cited VIOLATION/OFFENDING pair. ' +
      'Either emit at least one complete pair using the exact required format, or return ' +
      'VERDICT: PASS. Do not repeat an evidence-free FAIL. If the finding concerns a length, cite ' +
      'the supplied post-change line count — never a `--stat` or `@@` number, which is churn ' +
      '(insertions plus deletions) and never a file length. Every OFFENDING quote must be a line, ' +
      'copied verbatim, that this change adds or removes; a quote the gate cannot find there does ' +
      'not count, and a length that did not grow in this change is pre-existing, not a violation.',
    missingEvidenceReason: (retried: boolean) =>
      `response contract rejected an unsubstantiated FAIL${retried ? ' after retry' : ''} — ` +
      'no complete VIOLATION/OFFENDING pair whose quote is present in the reviewed change',
  }),
} satisfies Record<string, ReviewerResponseContract>;

export type ReviewerResponseContractName = keyof typeof RESPONSE_CONTRACTS;

export function responseContractFor(
  name: ReviewerResponseContractName | undefined,
): ReviewerResponseContract | null {
  return name ? RESPONSE_CONTRACTS[name] : null;
}
