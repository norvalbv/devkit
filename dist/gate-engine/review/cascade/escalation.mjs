import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { readChecklistState } from '../runtime.mjs';
/** Escalation prompt: the escalation model independently re-verifies a first-pass FAIL
 * (check-alignment shape). `reopened` names the first-pass failed rows reset for it to re-judge. */
export function escalatePrompt(wrappedPrompt, firstPass, reopened = []) {
    return (`${wrappedPrompt}\n\n` +
        'A first-pass reviewer judged FAIL. Its full notes:\n' +
        '─────\n' +
        `${firstPass}\n` +
        '─────\n' +
        'Independently verify its evidence with your own investigation — confirm or overturn. ' +
        (reopened.length
            ? `Its failed checklist rows (${reopened.join(', ')}) were reset to pending: re-record each ` +
                'issue you confirm with the check command and --fail, and mark a row --pass when you ' +
                'overturn every issue on it. A row you leave pending keeps the first pass issues. The ' +
                'checklist is already populated: do not run its generate or init command again. '
            : '') +
        'Your verdict is final; a FAIL blocks the commit.');
}
const rowsOf = (state) => state.items ?? state.files ?? [];
const rowId = (row) => row.name ?? row.path ?? '';
function writeState(cwd, reviewer, state) {
    if (reviewer.stateFile)
        writeFileSync(path.resolve(cwd, reviewer.stateFile), JSON.stringify(state, null, 2));
}
/** Reset the first pass's failed checklist rows to pending, returning a snapshot of them. */
export function reopenFailedItems(cwd, reviewer) {
    const state = readChecklistState(cwd, reviewer);
    const failed = state ? rowsOf(state).filter((row) => row.status === 'fail') : [];
    if (!state || failed.length === 0)
        return [];
    const snapshot = structuredClone(failed);
    for (const row of failed)
        Object.assign(row, { status: 'pending', issues: [] });
    writeState(cwd, reviewer, state);
    return snapshot;
}
/** In place: each `prior` row whose live copy is still pending replaces it. True when any did. */
export function restoreRows(rows, prior) {
    let restored = false;
    for (const row of prior) {
        const i = rows.findIndex((live) => rowId(live) === rowId(row) && live.status === 'pending');
        if (i === -1)
            continue;
        rows[i] = row;
        restored = true;
    }
    return restored;
}
/** Put back every reopened row the escalation left pending, so it keeps the first pass's issues. */
export function restoreUnjudgedItems(cwd, reviewer, snapshot) {
    const state = snapshot.length ? readChecklistState(cwd, reviewer) : null;
    if (state && restoreRows(rowsOf(state), snapshot))
        writeState(cwd, reviewer, state);
}
/** Run the escalation over the reopened rows, restoring the unjudged ones on every exit path. */
export async function escalateOverReopened(cwd, reviewer, run) {
    const snapshot = reopenFailedItems(cwd, reviewer);
    try {
        return await run(snapshot.map(rowId));
    }
    finally {
        restoreUnjudgedItems(cwd, reviewer, snapshot);
    }
}
/** Both passes for the archive, each under its model. The first pass is quoted so the only
 * parseable VERDICT line is the escalation's, the final one. */
export function labelPasses(firstModel, first, escalationModel, second) {
    const quoted = first.replace(/^/gm, '│ ');
    return `─── first pass · ${firstModel} ───\n${quoted}\n\n─── escalation · ${escalationModel} ───\n${second}`;
}
