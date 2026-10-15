/** Staged lines git's `--color-moved` matched to lines this commit removes. Git reports moves only
 * as colour, so two reserved 24-bit colours are the sentinels; nothing else is read from the SGR. */
import { stripVTControlCharacters } from 'node:util';
import { gitCached } from '../staged-git.mjs';
const NEW_MOVED = '\u001b[38;2;1;2;3m';
const OLD_MOVED = '\u001b[38;2;4;5;6m';
const CONFIG = [
    '-c',
    'color.diff.newMoved=#010203',
    '-c',
    'color.diff.oldMoved=#040506',
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.suppressBlankEmpty=false', // an empty context line would otherwise skip the line count
];
// Explicit prefixes, --no-relative and CONFIG override any consumer diff config that would
// change paths or colours; `blocks` applies git's 20-alphanumeric minimum, so a lone `}` never counts.
const FLAGS = [
    '--no-relative',
    '--no-ext-diff',
    '--no-textconv',
    '--color=always',
    '--color-moved=blocks',
    '--color-moved-ws=allow-indentation-change',
    '--ws-error-highlight=none',
    '--src-prefix=a/',
    '--dst-prefix=b/',
];
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)/;
const SPACE_PATH_TAB_RE = /\t$/; // git ends a ---/+++ path containing a space with a tab
const LIST_MAX = 40;
/** Parse a `--color=always --color-moved` diff carrying the sentinel colours above. */
export function parseMovedLines(diff) {
    const added = new Map();
    const sources = new Set();
    let oldPath = null;
    let newPath = null;
    let inHunk = false;
    let line = 0;
    for (const raw of diff.split('\n')) {
        const text = stripVTControlCharacters(raw);
        if (text.startsWith('diff --git ')) {
            inHunk = false;
            oldPath = newPath = null;
        }
        else if (!inHunk && text.startsWith('--- a/'))
            oldPath = text.slice(6).replace(SPACE_PATH_TAB_RE, ''); // a quoted path stays null
        else if (!inHunk && text.startsWith('+++ b/'))
            newPath = text.slice(6).replace(SPACE_PATH_TAB_RE, '');
        else if (HUNK_RE.test(text)) {
            inHunk = true;
            line = Number(text.match(HUNK_RE)?.[1]);
        }
        else if (inHunk && text.startsWith('+')) {
            // Anchored: staged content is raw bytes, so a sentinel inside the text must not count.
            if (raw.startsWith(NEW_MOVED) && newPath)
                added.set(newPath, [...(added.get(newPath) ?? []), line]);
            line += 1;
        }
        else if (inHunk && text.startsWith('-')) {
            // A rename's new path is the same file, so lines moved inside it are not a cross-file arrival.
            for (const path of raw.startsWith(OLD_MOVED) ? [oldPath, newPath] : [])
                if (path)
                    sources.add(path);
        }
        else if (inHunk && text.startsWith(' '))
            line += 1;
    }
    return { added, sources };
}
/** Moved lines across `files`; empty when git fails, so review falls back to today's evidence. */
export function stagedMovedLines(cwd, files) {
    try {
        return parseMovedLines(gitCached(cwd, FLAGS, files, CONFIG));
    }
    catch {
        return { added: new Map(), sources: new Set() };
    }
}
function toRanges(lines) {
    const ranges = [];
    let start = lines[0];
    for (let i = 1; i <= lines.length; i += 1) {
        if (lines[i] === lines[i - 1] + 1)
            continue;
        const end = lines[i - 1];
        ranges.push(start === end ? `${start}` : `${start}-${end}`);
        start = lines[i];
    }
    return ranges;
}
function capped(items) {
    const more = items.length - LIST_MAX;
    return items.slice(0, LIST_MAX).join(', ') + (more > 0 ? `, and ${more} more` : '');
}
/** The MOVED LINES evidence note for one reviewer's `files`, or '' when none of them moved. */
export function renderMovedLines(cwd, files, stagedFiles) {
    const { added, sources } = stagedMovedLines(cwd, [...new Set([...stagedFiles, ...files])]);
    // A file that also lost moved lines may only be reshuffled in place (a dropped try/finally
    // re-indents its body), which is where a move hides a new bug; only cross-file arrivals count.
    const ranges = files
        .filter((file) => !sources.has(file))
        .flatMap((file) => toRanges(added.get(file) ?? []).map((range) => `${file}:${range}`));
    if (ranges.length === 0)
        return '';
    return (`\nMOVED LINES (git --color-moved): these added lines match lines this commit removes from ` +
        `${capped([...sources])}: ${capped(ranges)}. A defect on them is pre-existing only if the identical ` +
        'line exists at the old path in the base and no other change in this commit (an edited, ' +
        'dropped or added line, a caller, an import, a guard) alters what reaches it — report that ' +
        'as ADVISORY. Judge everything else normally.');
}
