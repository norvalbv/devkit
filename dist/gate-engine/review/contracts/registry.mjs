import { parseConventionFindings } from "../evidence/conventions.mjs";
const RESPONSE_CONTRACTS = {
    'conventions-v1': Object.freeze({
        identity: 'conventions-v1:quote-and-cite',
        validatesFail: (raw) => parseConventionFindings(raw).length > 0,
        retryInstruction: 'EVIDENCE-CONTRACT RETRY: the prior FAIL had no complete cited VIOLATION/OFFENDING pair. ' +
            'Either emit at least one complete pair using the exact required format, or return ' +
            'VERDICT: PASS. Do not repeat an evidence-free FAIL.',
        missingEvidenceReason: (retried) => `response contract rejected an unsubstantiated FAIL${retried ? ' after retry' : ''} — ` +
            'no complete VIOLATION/OFFENDING pair',
    }),
};
export function responseContractFor(name) {
    return name ? RESPONSE_CONTRACTS[name] : null;
}
