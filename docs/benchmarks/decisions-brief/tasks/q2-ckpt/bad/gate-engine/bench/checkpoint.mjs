import { existsSync, readFileSync } from 'node:fs';

export function loadCheckpoint(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
