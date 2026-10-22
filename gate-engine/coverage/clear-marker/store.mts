import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionError } from '../dependencies.mts';
import type { UnhandledError } from '../unhandled-reporter.mts';

/** The advisory sidecar a CLEARING run leaves beside the artifact it removed. */
export const CLEAR_MARKER_NAME = '.last-clear.json';

/** What a run that cleared the artifact leaves behind so the next reader knows what happened. */
export interface ClearMarker {
  clearedAt: string;
  previousMtime: number | null;
  head: string | null;
  failedFiles: string[];
  unhandledErrors?: UnhandledError[];
  collectionErrors?: CollectionError[];
}

const markerPath = (coverageDir: string): string => join(coverageDir, CLEAR_MARKER_NAME);

/** Best-effort: an unwritable marker must never fail somebody's test run. Advisory data only. */
export function writeClearMarker(coverageDir: string, marker: ClearMarker): void {
  try {
    writeFileSync(markerPath(coverageDir), `${JSON.stringify(marker, null, 2)}\n`);
  } catch {
    /* diagnosis is a courtesy, not a guarantee */
  }
}

export function removeClearMarker(coverageDir: string): void {
  try {
    rmSync(markerPath(coverageDir), { force: true });
  } catch {
    /* see writeClearMarker */
  }
}

/** A marker entry we could have written; anything else came from a hand edit and is dropped. */
const isUnhandledError = (e: UnhandledError | null): e is UnhandledError =>
  e?.constructor === Object &&
  String(e.message) === e.message &&
  (e.file === null || String(e.file) === e.file);

/** The marker, or null when absent/corrupt. Never throws — the gate's verdict cannot depend on it. */
export function readClearMarker(coverageDir: string): ClearMarker | null {
  const file = markerPath(coverageDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: Partial<ClearMarker> = JSON.parse(readFileSync(file, 'utf8'));
    // clearedAt is the marker's identity — a payload without one is some other file that happens to
    // share the name, and inventing a timestamp for it would date the gate's message wrongly.
    if (!parsed?.clearedAt) return null;
    return {
      clearedAt: parsed.clearedAt,
      previousMtime: parsed.previousMtime ?? null,
      head: parsed.head ?? null,
      failedFiles: Array.isArray(parsed.failedFiles) ? parsed.failedFiles : [],
      ...(Array.isArray(parsed.unhandledErrors) && {
        unhandledErrors: parsed.unhandledErrors.filter(isUnhandledError),
      }),
      ...(Array.isArray(parsed.collectionErrors) && {
        collectionErrors: parsed.collectionErrors.filter(
          (e): e is CollectionError => isUnhandledError(e) && e.file !== null,
        ),
      }),
    };
  } catch {
    return null;
  }
}
