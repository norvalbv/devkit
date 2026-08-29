import { parseConventionFindings } from '../evidence/conventions.mjs';
const RESPONSE_CONTRACTS = {
    'conventions-v1': Object.freeze({
        // Bumped for sc-2181: the verdict cache salts on this, and the conventions prompt now carries
        // authoritative post-change line counts, so verdicts earned without them must not replay.
        identity: 'conventions-v2:quote-and-cite',
        validatesFail: (raw) => parseConventionFindings(raw).length > 0,
        retryInstruction: 'EVIDENCE-CONTRACT RETRY: the prior FAIL had no complete cited VIOLATION/OFFENDING pair. ' +
            'Either emit at least one complete pair using the exact required format, or return ' +
            'VERDICT: PASS. Do not repeat an evidence-free FAIL. If the finding concerns a length, cite ' +
            'the supplied post-change line count — never a `--stat` or `@@` number, which is churn ' +
            '(insertions plus deletions) and never a file length.',
        missingEvidenceReason: (retried) => `response contract rejected an unsubstantiated FAIL${retried ? ' after retry' : ''} — ` +
            'no complete VIOLATION/OFFENDING pair',
    }),
};
export function responseContractFor(name) {
    return name ? RESPONSE_CONTRACTS[name] : null;
}
