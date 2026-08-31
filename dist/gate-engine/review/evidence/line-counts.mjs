/** Post-change line counts for the conventions reviewer's prompt (sc-2181): the reviewer has no
 * Bash, so the count is supplied rather than derived. */
import { countLines } from '../../ratchets/size-line-authority.mjs';
import { indexFile } from './staged-git.mjs';
export { countLines };
export function stagedLineCounts(cwd, files) {
    const counts = [];
    for (const file of files) {
        let content;
        try {
            content = indexFile(cwd, file);
        }
        catch {
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
export function renderStagedLineCounts(cwd, files) {
    const counts = stagedLineCounts(cwd, files);
    // Never silence: the brief points at this block, so an empty set must say so rather than vanish.
    if (counts.length === 0)
        return 'POST-CHANGE LINE COUNTS: no staged file in this change has measurable text.';
    const rows = counts.map((c) => `  ${c.file}: ${c.lines}`).join('\n');
    return ('POST-CHANGE LINE COUNTS (authoritative, measured from the staged content):\n' +
        `${rows}\n` +
        "These are the sizes this commit would land. Use them for any rule about a file's length, and " +
        'never compute one from churn: a `--stat` or `@@` number is insertions plus deletions, not a ' +
        'length. A file absent from this list has no staged text to measure — say so rather than ' +
        "estimating its size. A quantity you can read directly in the evidence, such as a line's width " +
        "or a symbol's position, you may still count and quote.");
}
