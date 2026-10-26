import { conventionWaiverLenses, parseConventionFindingCandidates, } from '../evidence/conventions.mjs';
import { groundConventionFindings } from './conventions-grounding.mjs';
const RESPONSE_CONTRACTS = {
    'conventions-v1': Object.freeze({
        // The verdict cache salts on this, so older FAILs never replay. v3 grounds the OFFENDING quote,
        // v4 keys lenses on rule + file, v5 grounds the rule in a CLAUDE.md, v6 a whole-file OFFENDING.
        identity: 'conventions-v6:whole-file',
        blockingLenses: (raw, source) => conventionWaiverLenses(groundConventionFindings(parseConventionFindingCandidates(raw), source)),
        retryInstruction: 'EVIDENCE-CONTRACT RETRY: the prior FAIL had no complete cited VIOLATION/OFFENDING pair. ' +
            'Either emit at least one complete pair using the exact required format, or return ' +
            'VERDICT: PASS. Do not repeat an evidence-free FAIL. If the finding concerns a length, cite ' +
            'the supplied post-change line count — never a `--stat` or `@@` number, which is churn ' +
            '(insertions plus deletions) and never a file length. Every OFFENDING quote must be a line, ' +
            'copied verbatim, that this change adds or removes; a quote the gate cannot find there does ' +
            'not count, and a length that did not grow in this change is pre-existing, not a violation. ' +
            'A rule about a file itself (its name or location) may instead cite ' +
            '`OFFENDING: <file basename> — <file path>`, with nothing after the path, for a file this ' +
            'change adds. ' +
            'Every VIOLATION must quote, verbatim, a rule from one of the governing CLAUDE.md files ' +
            'supplied above and cite that file; a rule from any other file (AGENTS.md, a README, a ' +
            "sibling directory's CLAUDE.md) does not count.",
        missingEvidenceReason: (retried) => `response contract rejected an unsubstantiated FAIL${retried ? ' after retry' : ''} — ` +
            'no complete VIOLATION/OFFENDING pair quoting a governing CLAUDE.md rule and a line present ' +
            'in the reviewed change, or the name of a file it adds',
    }),
};
export function responseContractFor(name) {
    return name ? RESPONSE_CONTRACTS[name] : null;
}
