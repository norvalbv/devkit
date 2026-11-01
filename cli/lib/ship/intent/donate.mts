/** Path donation into a recorded ship invocation without taking ownership of it: the generation,
 * which success-path compare-and-delete matches on, never changes here. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { withLock } from '../../atomic-write.mts';
import { fail } from '../ship-intent-args.mts';
import { provenString, provenStrings, type StoredIntent } from '../ship-intent-codec.mts';

/** Append `paths` to the stored record in place, keeping its generation and every other field. */
export function appendPathsInPlace(file: string, onDisk: StoredIntent, paths: string[]): void {
  const merged = [...(provenStrings(onDisk.paths) ?? [])];
  const before = merged.length;
  for (const p of paths) if (!merged.includes(p)) merged.push(p);
  if (merged.length === before) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...onDisk, paths: merged }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** A refused resume adds its briefed paths to the record it read: 0 once that record (same
 * generation) holds them; 1 when it is gone, replaced by another attempt, or branch-source. */
export function donateIntent(
  file: string,
  expectGeneration: string | undefined,
  paths: string[],
): number {
  if (!expectGeneration || paths.length === 0)
    return fail('donate: missing --expect-generation/paths');
  let donated = false;
  try {
    withLock(`${file}.lock`, () => {
      let onDisk: StoredIntent | null = null;
      try {
        // SAFETY: only generation, sourceMode and paths are read; proven* rechecks each.
        onDisk = JSON.parse(readFileSync(file, 'utf8')) as StoredIntent | null;
      } catch {
        return; // absent/torn — nothing to add to
      }
      if (!onDisk || provenString(onDisk.generation) !== expectGeneration) return;
      if (onDisk.sourceMode === 'branch') return; // frozen path membership
      appendPathsInPlace(file, onDisk, paths);
      donated = true;
    });
  } catch (e: unknown) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return donated ? 0 : 1;
}
