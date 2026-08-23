import { parseConventionFindings } from '../evidence/conventions.mts';

export interface ReviewerResponseContract {
  /** Stable cache salt; changing contract semantics invalidates verdicts earned under old rules. */
  identity: string;
  validatesFail: (raw: string) => boolean;
  retryInstruction: string;
  missingEvidenceReason: (retried: boolean) => string;
}

const RESPONSE_CONTRACTS = {
  'conventions-v1': Object.freeze({
    identity: 'conventions-v1:quote-and-cite',
    validatesFail: (raw: string) => parseConventionFindings(raw).length > 0,
    retryInstruction:
      'EVIDENCE-CONTRACT RETRY: the prior FAIL had no complete cited VIOLATION/OFFENDING pair. ' +
      'Either emit at least one complete pair using the exact required format, or return ' +
      'VERDICT: PASS. Do not repeat an evidence-free FAIL.',
    missingEvidenceReason: (retried: boolean) =>
      `response contract rejected an unsubstantiated FAIL${retried ? ' after retry' : ''} — ` +
      'no complete VIOLATION/OFFENDING pair',
  }),
} satisfies Record<string, ReviewerResponseContract>;

export type ReviewerResponseContractName = keyof typeof RESPONSE_CONTRACTS;

export function responseContractFor(
  name: ReviewerResponseContractName | undefined,
): ReviewerResponseContract | null {
  return name ? RESPONSE_CONTRACTS[name] : null;
}
