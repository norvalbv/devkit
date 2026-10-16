import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Reviewer } from '../reviewers.mts';
import { type ChecklistItem, type ChecklistState, readChecklistState } from '../runtime.mts';

/** Escalation prompt: the escalation model independently re-verifies a first-pass FAIL
 * (check-alignment shape). `reopened` names the first-pass failed rows reset for it to re-judge. */
export function escalatePrompt(
  wrappedPrompt: string,
  firstPass: string,
  reopened: string[] = [],
): string {
  return (
    `${wrappedPrompt}\n\n` +
    'A first-pass reviewer judged FAIL. Its full notes:\n' +
    '─────\n' +
    `${firstPass}\n` +
    '─────\n' +
    'Independently verify its evidence with your own investigation — confirm or overturn. ' +
    (reopened.length
      ? `Its failed checklist rows (${reopened.join(', ')}) were reset to pending: re-record each ` +
        'issue you confirm with the check command and --fail, and mark a row --pass when you ' +
        'overturn every issue on it. A row you leave pending keeps the first pass issues. '
      : '') +
    'Your verdict is final; a FAIL blocks the commit.'
  );
}

const rowsOf = (state: ChecklistState): ChecklistItem[] => state.items ?? state.files ?? [];
const rowId = (row: ChecklistItem): string => row.name ?? row.path ?? '';

function writeState(cwd: string, reviewer: Reviewer, state: ChecklistState): void {
  if (reviewer.stateFile)
    writeFileSync(path.resolve(cwd, reviewer.stateFile), JSON.stringify(state, null, 2));
}

/** Reset the first pass's failed checklist rows to pending, returning a snapshot of them. */
export function reopenFailedItems(cwd: string, reviewer: Reviewer): ChecklistItem[] {
  const state = readChecklistState(cwd, reviewer);
  const failed = state ? rowsOf(state).filter((row) => row.status === 'fail') : [];
  if (!state || failed.length === 0) return [];
  const snapshot = structuredClone(failed);
  for (const row of failed) Object.assign(row, { status: 'pending', issues: [] });
  writeState(cwd, reviewer, state);
  return snapshot;
}

/** In place: each `prior` row whose live copy is still pending replaces it. True when any did. */
export function restoreRows(rows: ChecklistItem[], prior: ChecklistItem[]): boolean {
  let restored = false;
  for (const row of prior) {
    const i = rows.findIndex((live) => rowId(live) === rowId(row) && live.status === 'pending');
    if (i === -1) continue;
    rows[i] = row;
    restored = true;
  }
  return restored;
}

/** Put back every reopened row the escalation left pending, so it keeps the first pass's issues. */
export function restoreUnjudgedItems(
  cwd: string,
  reviewer: Reviewer,
  snapshot: ChecklistItem[],
): void {
  const state = snapshot.length ? readChecklistState(cwd, reviewer) : null;
  if (state && restoreRows(rowsOf(state), snapshot)) writeState(cwd, reviewer, state);
}

/** Run the escalation over the reopened rows, restoring the unjudged ones on every exit path. */
export async function escalateOverReopened(
  cwd: string,
  reviewer: Reviewer,
  run: (reopened: string[]) => Promise<string | null>,
): Promise<string | null> {
  const snapshot = reopenFailedItems(cwd, reviewer);
  try {
    return await run(snapshot.map(rowId));
  } finally {
    restoreUnjudgedItems(cwd, reviewer, snapshot);
  }
}

/** Both passes' output for the transcript archive, each headed with the model that wrote it. */
export function labelPasses(
  firstModel: string,
  first: string,
  escalationModel: string,
  second: string,
): string {
  return `─── first pass · ${firstModel} ───\n${first}\n\n─── escalation · ${escalationModel} ───\n${second}`;
}
