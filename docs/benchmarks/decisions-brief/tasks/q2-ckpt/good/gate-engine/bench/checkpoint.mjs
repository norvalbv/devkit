import { existsSync, readFileSync } from 'node:fs';

export function loadCheckpoint(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { rows.push(JSON.parse(l)); } catch { break; }
  }
  return rows;
}
