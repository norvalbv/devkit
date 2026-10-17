import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** The advisory sidecar a CLEARING run leaves beside the artifact it removed. */
export const CLEAR_MARKER_NAME = '.last-clear.json';
const markerPath = (coverageDir) => join(coverageDir, CLEAR_MARKER_NAME);
/** Best-effort: an unwritable marker must never fail somebody's test run. Advisory data only. */
export function writeClearMarker(coverageDir, marker) {
    try {
        writeFileSync(markerPath(coverageDir), `${JSON.stringify(marker, null, 2)}\n`);
    }
    catch {
        /* diagnosis is a courtesy, not a guarantee */
    }
}
export function removeClearMarker(coverageDir) {
    try {
        rmSync(markerPath(coverageDir), { force: true });
    }
    catch {
        /* see writeClearMarker */
    }
}
/** A marker entry we could have written; anything else came from a hand edit and is dropped. */
const isUnhandledError = (e) => e?.constructor === Object &&
    String(e.message) === e.message &&
    (e.file === null || String(e.file) === e.file);
/** The marker, or null when absent/corrupt. Never throws — the gate's verdict cannot depend on it. */
export function readClearMarker(coverageDir) {
    const file = markerPath(coverageDir);
    if (!existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        // clearedAt is the marker's identity — a payload without one is some other file that happens to
        // share the name, and inventing a timestamp for it would date the gate's message wrongly.
        if (!parsed?.clearedAt)
            return null;
        return {
            clearedAt: parsed.clearedAt,
            previousMtime: parsed.previousMtime ?? null,
            head: parsed.head ?? null,
            failedFiles: Array.isArray(parsed.failedFiles) ? parsed.failedFiles : [],
            ...(Array.isArray(parsed.unhandledErrors) && {
                unhandledErrors: parsed.unhandledErrors.filter(isUnhandledError),
            }),
            ...(Array.isArray(parsed.collectionErrors) && {
                collectionErrors: parsed.collectionErrors.filter((e) => isUnhandledError(e) && e.file !== null),
            }),
        };
    }
    catch {
        return null;
    }
}
