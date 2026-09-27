/** Post-change line counts for the conventions reviewer's prompt (sc-2181): the reviewer has no
 * Bash, so the count is supplied rather than derived. */

import { countLines } from '../../ratchets/size-line-authority.mts';
import { headFile, indexFile } from './staged-git.mts';

export { countLines };

// One reviewed file's post-change size, or null when the index has no stage-0 blob for it (deleted,
// renamed away, or unmerged) — an absent count is never rendered as zero.
interface StagedLineCount {
  file: string;
  lines: number;
  /** The same path's length at HEAD; null when HEAD has no text there (new, or renamed in). */
  headLines: number | null;
}

function headLineCount(cwd: string, file: string): number | null {
  try {
    const content = headFile(cwd, file);
    return content === null || content.includes('\0') ? null : countLines(content);
  } catch {
    return null; // unreadable HEAD — the row still carries its authoritative post-change count
  }
}

export function stagedLineCounts(cwd: string, files: string[]): StagedLineCount[] {
  const counts: StagedLineCount[] = [];
  for (const file of files) {
    let content: string | null;
    try {
      content = indexFile(cwd, file);
    } catch {
      continue; // unreadable path — omit rather than guess; the block states it may be partial
    }
    // A NUL byte means the blob is not text; utf8-decoding it would render a newline-byte tally as
    // an authoritative line count.
    if (content !== null && !content.includes('\0'))
      counts.push({ file, lines: countLines(content), headLines: headLineCount(cwd, file) });
  }
  return counts;
}

/** The prompt block: counts only. Naming another gate as the owner of the size verdict would
 * suppress a real breach wherever that gate does not run. */
export function renderStagedLineCounts(cwd: string, files: string[]): string {
  const counts = stagedLineCounts(cwd, files);
  // Never silence: the brief points at this block, so an empty set must say so rather than vanish.
  if (counts.length === 0)
    return 'POST-CHANGE LINE COUNTS: no staged file in this change has measurable text.';
  const rows = counts
    .map(
      (c) =>
        `  ${c.file}: ${c.lines} (${c.headLines === null ? 'not at HEAD' : `HEAD: ${c.headLines}`})`,
    )
    .join('\n');
  return (
    'POST-CHANGE LINE COUNTS (authoritative, measured from the staged content):\n' +
    `${rows}\n` +
    "These are the sizes this commit would land. Use them for any rule about a file's length, and " +
    'never compute one from churn: a `--stat` or `@@` number is insertions plus deletions, not a ' +
    'length. A file absent from this list has no staged text to measure — say so rather than ' +
    "estimating its size. A quantity you can read directly in the evidence, such as a line's width " +
    "or a symbol's position, you may still count and quote. A file no longer than its HEAD length " +
    'carries pre-existing length, not length this change added — it is not a length violation.'
  );
}
