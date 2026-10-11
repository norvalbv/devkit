import { appendFileSync, existsSync, readFileSync } from 'node:fs';

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
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.config === key.config && r.gateHash === key.gateHash && r.corpusHash === key.corpusHash);
}
