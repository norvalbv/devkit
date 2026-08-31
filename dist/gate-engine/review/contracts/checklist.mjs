/** The CHECKLIST half of the reviewer response contract, beside response.mts (the prose half). */
import { attachItems } from '../evidence/items.mjs';
import { cleanupChecklistState, readChecklistState, verifyChecklist, } from '../runtime.mjs';
/**
 * Verify the artifact behind a PASS and, when the caller SCHEDULED a recovery, hand the hole to it.
 * Eligibility is the caller's `recovery` mode, never `assetRoot` (sc-2088).
 */
export async function enforceChecklistContract(selection, initial, cwd, recoveryScheduled, retry) {
    // No stateFile means no artifact to verify; that reviewer's brief carries its own contract.
    if (initial.status !== 'pass' || !selection.reviewer.stateFile)
        return initial;
    let result = initial;
    const initialState = readChecklistState(cwd, selection.reviewer);
    const hole = verifyChecklist(initialState, 'PASS');
    if (hole && recoveryScheduled) {
        console.error(`guard-review: ${selection.reviewer.name} — checklist contract not satisfied; retrying once (${hole})`);
        cleanupChecklistState(cwd, selection.reviewer);
        result = await retry(hole);
        if (initial.transcript && result.transcript)
            result.transcript = `${initial.transcript}\n\n───── CHECKLIST-CONTRACT RETRY ─────\n${result.transcript}`;
        // The freshest artifact wins: a callback that ran its own judge left one, and classifying that
        // attempt from the pre-cleanup state would report the FIRST attempt's kind of hole. Falls back
        // to the captured state for today's callbacks, which run no judge and leave nothing.
        const settled = readChecklistState(cwd, selection.reviewer) ?? initialState;
        if (result.status !== 'pass')
            attachItems(result, settled, new Map());
        // Only when the retry left the cause open: an outage/timeout carries its own, and the operator
        // needs its auth/quota remedy rather than an artifact one.
        if (result.status === 'inconclusive' && result.inconclusiveCause === undefined)
            result.inconclusiveCause = checklistHoleCause(settled);
    }
    else if (hole) {
        result.status = 'inconclusive';
        result.reason = hole;
        result.inconclusiveCause = checklistHoleCause(initialState);
    }
    return result;
}
function checklistHoleCause(state) {
    // Keyed on whether an artifact EXISTS, not on whether it has rows. `readChecklistState` returns
    // null only when the file is absent or unreadable — the shape a never-synced script leaves. A
    // present artifact, even an empty one, proves the script ran, so its hole is the judge's.
    return state === null ? 'sync' : 'response-contract';
}
