import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join('.cache', 'baseline');

export async function getCached(run, fetchSummary) {
  const file = path.join(DIR, `${run.runId}-${run.attempt}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const summary = await fetchSummary(run);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(summary));
  return summary;
}
