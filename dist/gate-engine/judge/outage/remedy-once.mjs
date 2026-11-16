/** Prints a strict-ship Remedy once per hook run. The review hook hands the parallel completeness
 *  judge and the reviewer fleet one DEVKIT_REMEDY_DIR, so a second printer of a wording points up. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { remedyCause, strictRemedy } from './wording.mjs';
/** The reset an earlier printer named for this wording, or -1 when none printed it. */
function printedReset(marker) {
    try {
        return Number(readFileSync(marker, 'utf8'));
    }
    catch {
        return -1;
    }
}
/** This hook run's marker for one wording, or '' when no hook shared a dir. */
function markerPath(key) {
    const dir = process.env.DEVKIT_REMEDY_DIR;
    return dir ? path.join(dir, createHash('sha256').update(key).digest('hex').slice(0, 16)) : '';
}
/** `key` is the wording minus its reset; a later reset than the one printed earns a full copy. */
export function printRemedyOnce(key, text, suffix, resetsAt = 0) {
    const marker = markerPath(key);
    if (marker && printedReset(marker) >= resetsAt) {
        console.error(`   Remedy: the same Remedy as printed above (${suffix}).`);
        return;
    }
    console.error(`   Remedy: ${text} (${suffix}).`);
    // Marked only once the text is out: POSIX pipe writes are async and process.exit drops a queued one.
    if (!marker || process.stderr.writableLength > 0)
        return;
    try {
        writeFileSync(marker, String(resetsAt));
    }
    catch {
        // An unwritable dir only costs the dedupe; the Remedy itself is already out.
    }
}
export function printStrictRemedy(outage, bin, suffix) {
    const cause = remedyCause(outage);
    const resetsAt = outage?.resetsAt;
    printRemedyOnce(strictRemedy(cause, bin), strictRemedy(cause, bin, resetsAt), suffix, resetsAt);
}
