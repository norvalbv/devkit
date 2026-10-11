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
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // torn line from an interrupted write
    }
  }
  return rows.filter((r) => r.config === key.config && r.gateHash === key.gateHash && r.corpusHash === key.corpusHash && r.verdict !== null);
}
