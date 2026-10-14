import { conventionWaiverLenses, parseConventionFindingCandidates, } from '../evidence/conventions.mjs';
import { groundConventionFindings } from './conventions-grounding.mjs';
const RESPONSE_CONTRACTS = {
    'conventions-v1': Object.freeze({
        // The verdict cache salts on this. v3 grounds the OFFENDING quote, v4 keys lenses on rule + file,
        // v5 grounds the quoted rule in a governing CLAUDE.md, so older FAILs must not replay.
        identity: 'conventions-v5:rule-grounded',
        blockingLenses: (raw, source) => conventionWaiverLenses(groundConventionFindings(parseConventionFindingCandidates(raw), source)),
        retryInstruction: 'EVIDENCE-CONTRACT RETRY: the prior FAIL had no complete cited VIOLATION/OFFENDING pair. ' +
            'Either emit at least one complete pair using the exact required format, or return ' +
            'VERDICT: PASS. Do not repeat an evidence-free FAIL. If the finding concerns a length, cite ' +
            'the supplied post-change line count — never a `--stat` or `@@` number, which is churn ' +
            '(insertions plus deletions) and never a file length. Every OFFENDING quote must be a line, ' +
            'copied verbatim, that this change adds or removes; a quote the gate cannot find there does ' +
            'not count, and a length that did not grow in this change is pre-existing, not a violation. ' +
            'Every VIOLATION must quote, verbatim, a rule from one of the governing CLAUDE.md files ' +
            'supplied above and cite that file; a rule from any other file (AGENTS.md, a README, a ' +
            "sibling directory's CLAUDE.md) does not count.",
        missingEvidenceReason: (retried) => `response contract rejected an unsubstantiated FAIL${retried ? ' after retry' : ''} — ` +
            'no complete VIOLATION/OFFENDING pair quoting a governing CLAUDE.md rule and a line present ' +
            'in the reviewed change',
    }),
};
export function responseContractFor(name) {
    return name ? RESPONSE_CONTRACTS[name] : null;
}
