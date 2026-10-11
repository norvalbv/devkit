import { appendFileSync } from 'node:fs';

/**
 * A run key: { config, gateHash, corpusHash }. `config` is a string such as "haiku/K3/cascade".
 * A row: { id, verdict, inputChars } where verdict is 'DECISION' | 'ROUTINE' | null.
 */

/** Appends one finished row to the progress file the moment it lands. */
export function appendRow(file, key, row) {
  appendFileSync(file, `${JSON.stringify({ ...key, ...row })}\n`);
}

/**
 * Rows of `file` that a run with `key` can reuse.
 *
 * @returns {{ id: string, verdict: string | null, inputChars: number }[]}
 */
export function loadCheckpoint(file, key) {
  // TODO: resume is not implemented — every run starts from zero.
  return [];
}
