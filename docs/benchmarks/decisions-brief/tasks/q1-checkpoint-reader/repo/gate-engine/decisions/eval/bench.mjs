import { appendRow, loadCheckpoint } from './checkpoint.mjs';

/** Judges every case, reusing rows a previous interrupted run already finished. */
export async function bench(cases, key, judge, file = 'progress-detect.jsonl') {
  const done = new Map(loadCheckpoint(file, key).map((row) => [row.id, row]));
  const rows = [];
  for (const c of cases) {
    let row = done.get(c.id);
    if (!row) {
      // judge() resolves to null when the provider is down (an outage, not a verdict).
      row = { id: c.id, verdict: await judge(c), inputChars: c.text.length };
      appendRow(file, key, row);
    }
    rows.push(row);
  }
  return rows;
}
