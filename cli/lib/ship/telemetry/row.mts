/** The JSONL writer shared by ship's post-PR telemetry rows (ship_ci, ship_stack). */
import { appendFileSync } from 'node:fs';
import { parentSessionId } from '../../../../gate-engine/judge/run-context.mts';

export type ShipRow = Record<string, string | number | boolean | null | string[]>;

/** Appends one row stamped with the root agent session; a telemetry miss never fails the ship. */
export function appendShipRow(file: string, row: ShipRow, env = process.env): void {
  const parent = parentSessionId(env);
  const stamped = parent ? { ...row, parent_session_id: parent } : row;
  try {
    appendFileSync(file, `${JSON.stringify(stamped)}\n`);
  } catch {
    // A telemetry miss costs a queryable row, never the ship.
  }
}
