/** Prints a strict-ship Remedy once per hook run. The review hook hands the parallel completeness
 *  judge and the reviewer fleet one DEVKIT_REMEDY_DIR, so a second printer of a wording points up. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JudgeOutage } from './classify.mts';
import { remedyCause, strictRemedy } from './wording.mts';

/** The reset an earlier printer named for this wording, or -1 when none printed it. */
function printedReset(marker: string): number {
  try {
    return Number(readFileSync(marker, 'utf8'));
  } catch {
    return -1;
  }
}

/** `key` is the wording minus its reset; a later reset than the one printed earns a full copy. */
export function printRemedyOnce(key: string, text: string, suffix: string, resetsAt = 0): void {
  const dir = process.env.DEVKIT_REMEDY_DIR;
  const marker = dir
    ? path.join(dir, createHash('sha256').update(key).digest('hex').slice(0, 16))
    : '';
  if (marker && printedReset(marker) >= resetsAt) {
    console.error(`   Remedy: the same Remedy as printed above (${suffix}).`);
    return;
  }
  console.error(`   Remedy: ${text} (${suffix}).`);
  // Marked only AFTER printing: a sibling racing this line prints a duplicate, never nothing.
  if (!marker) return;
  try {
    writeFileSync(marker, String(resetsAt));
  } catch {
    // An unwritable dir only costs the dedupe; the Remedy itself is already out.
  }
}

export function printStrictRemedy(
  outage: JudgeOutage | undefined,
  bin: string,
  suffix: string,
): void {
  const cause = remedyCause(outage);
  const resetsAt = outage?.resetsAt;
  printRemedyOnce(strictRemedy(cause, bin), strictRemedy(cause, bin, resetsAt), suffix, resetsAt);
}
