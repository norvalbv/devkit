import { groundedConventionFindings } from './conventions-grounding.mjs';
const RESPONSE_CONTRACTS = {
    'conventions-v1': Object.freeze({
        // The verdict cache salts on this. v2 (sc-2181): authoritative post-change line counts. v3
        // (sc-3580): an OFFENDING quote must exist in the change it cites, so v2 FAILs must not replay.
        identity: 'conventions-v3:grounded-quote',
        blockingLenses: (raw, source) => groundedConventionFindings(raw, source).map((f) => `${f.offendingPath}:${f.offendingLine}`),
        retryInstruction: 'EVIDENCE-CONTRACT RETRY: the prior FAIL had no complete cited VIOLATION/OFFENDING pair. ' +
            'Either emit at least one complete pair using the exact required format, or return ' +
            'VERDICT: PASS. Do not repeat an evidence-free FAIL. If the finding concerns a length, cite ' +
            'the supplied post-change line count — never a `--stat` or `@@` number, which is churn ' +
            '(insertions plus deletions) and never a file length. Every OFFENDING quote must be a line, ' +
            'copied verbatim, that this change adds or removes; a quote the gate cannot find there does ' +
            'not count, and a length that did not grow in this change is pre-existing, not a violation.',
        missingEvidenceReason: (retried) => `response contract rejected an unsubstantiated FAIL${retried ? ' after retry' : ''} — ` +
            'no complete VIOLATION/OFFENDING pair whose quote is present in the reviewed change',
    }),
};
export function responseContractFor(name) {
    return name ? RESPONSE_CONTRACTS[name] : null;
}
