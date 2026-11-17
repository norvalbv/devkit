// The evidence vocabulary ship writes into a PR body and a merge verdict reads back. One definition:
// the verdict imports these, it never re-declares them.
import { SKIPPED_ON_GREEN, } from '../../baseline-status/regression-evidence.mjs';
export const EVIDENCE_STATUSES = ['captured', 'inconclusive', 'not-run'];
/** Why no red/green pair was captured. Set only on `not-run`, a deliberate abstention. */
export const EVIDENCE_ABSTENTIONS = [
    'no-test-change',
    'docs-only',
    'declared-no-behaviour-change',
    'platform-skipped',
    'not-configured',
];
export const notRun = (reason, detail, headSha, baseSha) => ({ status: 'not-run', reason, detail, headSha, baseSha });
export const inconclusive = (detail, headSha, baseSha) => ({ status: 'inconclusive', reason: null, detail, headSha, baseSha });
/** A run whose deciding tests skipped on this host never ran them, so it abstains instead. */
export function outcomeFromRegression(evidence, headSha, baseSha) {
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
