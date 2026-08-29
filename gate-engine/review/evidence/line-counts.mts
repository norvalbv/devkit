/** Post-change line counts for the conventions reviewer's prompt (sc-2181): the reviewer has no
 * Bash, so the count is supplied rather than derived. */

import { indexFile } from './staged-git.mts';

// LF, CRLF and lone CR all separate lines; a CR-only blob is still text git will happily stage.
const LINE_SEPARATOR_RE = /\r\n|\r|\n/;
const TRAILING_SEPARATOR_RE = /[\r\n]$/;

/** Lines as a CLAUDE.md rule saying "500 lines" means them: empty content is 0, a trailing newline
 * terminates the last line rather than starting a new one, and an unterminated last line still
 * counts. Equals `wc -l` for newline-terminated content and is one higher without it, because
 * `wc -l` counts newline characters rather than lines. */
export function countLines(content: string): number {
  if (content === '') return 0;
  const separators = content.split(LINE_SEPARATOR_RE).length - 1;
  return TRAILING_SEPARATOR_RE.test(content) ? separators : separators + 1;
}

// One reviewed file's post-change size, or null when the index has no stage-0 blob for it (deleted,
// renamed away, or unmerged) — an absent count is never rendered as zero.
interface StagedLineCount {
  file: string;
  lines: number;
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
      counts.push({ file, lines: countLines(content) });
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
  const rows = counts.map((c) => `  ${c.file}: ${c.lines}`).join('\n');
  return (
    'POST-CHANGE LINE COUNTS (authoritative, measured from the staged content):\n' +
    `${rows}\n` +
    "These are the sizes this commit would land. Use them for any rule about a file's length, and " +
    'never compute one from churn: a `--stat` or `@@` number is insertions plus deletions, not a ' +
    'length. A file absent from this list has no staged text to measure — say so rather than ' +
    "estimating its size. A quantity you can read directly in the evidence, such as a line's width " +
    "or a symbol's position, you may still count and quote."
  );
}
