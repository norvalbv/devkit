/** Quote grounding (sc-3580): an OFFENDING quote blocks only if it is in the cited file and part of
 * this change. Rationale: docs/decisions/reviewer-blocks-require-validated-evidence.md. */
import { execFileSync } from 'node:child_process';
import { parsePatchHunks } from '../../comment-firewall/patch.mjs';
import { countLines } from '../../ratchets/size-line-authority.mjs';
import { dedupeConventionFindings, normalizeCitedPath, parseConventionFindingCandidates, } from '../evidence/conventions.mjs';
import { headHash, stagedTreeHash } from '../evidence/staged-git.mjs';
/** How far a quote may sit from its cited line — judges cite a statement's start or a near line. */
export const QUOTE_WINDOW = 3;
const MIN_QUOTE_CHARS = 3;
const LINE_SPLIT_RE = /\r\n|\r|\n/;
const WRAPPERS = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
];
const collapse = (text) => text.replace(/\s+/g, ' ').trim();
/**
 * The comparable core of a quoted line, or null when too little is left to identify one. Every step
 * only ever SHORTENS the quote, so a normalized quote of a real line is still a substring of it.
 */
export function normalizeQuote(quote) {
    let text = quote.trim();
    const fence = text.match(/^(`+)([\s\S]*)\1$/);
    if (fence)
        text = fence[2].trim();
    for (const [open, close] of WRAPPERS)
        if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
            text = text.slice(open.length, -close.length).trim();
            break;
        }
    text = text.replace(/^(?:…|\.\.\.)\s*/, '');
    text = text.replace(/\s*(?:…|\.\.\.)$/, '');
    text = collapse(text);
    const significant = text.replace(/\s/g, '');
    if (significant.length < MIN_QUOTE_CHARS || !/[\p{L}\p{N}]/u.test(significant))
        return null;
    return text;
}
function quoteForms(quote) {
    const plain = normalizeQuote(quote);
    if (plain === null)
        return null;
    const marked = plain.match(/^([+-])(.*)$/);
    const marker = marked?.[1] === '+' ? '+' : marked?.[1] === '-' ? '-' : null;
    return { plain, marker, body: marked ? normalizeQuote(marked[2]) : null };
}
function safe(read, fallback) {
    try {
        return read();
    }
    catch {
        return fallback;
    }
}
/** A judge may wrap one statement across lines; its parser joins them with a space. */
const MAX_SPAN = 4;
function fileChange(source, file) {
    const staged = safe(() => source.readStaged(file), null);
    const head = safe(() => source.readHead(file), null);
    const diff = safe(() => source.readDiff(file), '');
    const added = new Set();
    const removedRuns = [];
    for (const hunk of parsePatchHunks(diff)) {
        for (const line of hunk.addedLines)
            added.add(line);
        let run = [];
        for (const line of hunk.text.split('\n').slice(1)) {
            if (line.startsWith('-'))
                run.push(collapse(line.slice(1)));
            else if (!line.startsWith('+') && run.length > 0) {
                removedRuns.push(run);
                run = [];
            }
        }
        if (run.length > 0)
            removedRuns.push(run);
    }
    return {
        lines: staged === null ? null : staged.split(LINE_SPLIT_RE).map(collapse),
        added,
        removedRuns,
        // A new file is wholly this change's; otherwise only growth makes existing lines this change's.
        grew: staged !== null && (head === null || countLines(staged) > countLines(head)),
    };
}
/** Whether `quote` lies in the SMALLEST run of 1..MAX_SPAN joined lines starting at `start` (0-based),
 * and `accept` approves that run's 1-based range — a run never borrows an extra changed line. */
function spanMatches(lines, start, quote, accept) {
    let joined = '';
    for (let end = start; end < Math.min(lines.length, start + MAX_SPAN); end += 1) {
        joined = end === start ? lines[end] : `${joined} ${lines[end]}`;
        if (!joined.includes(quote))
            continue;
        // The quote must reach into the first line, else a later start is the smaller run.
        const rest = lines.slice(start + 1, end + 1).join(' ');
        return !(end > start && rest.includes(quote)) && accept(start + 1, end + 1);
    }
    return false;
}
function inRemoved(quote, change) {
    return change.removedRuns.some((run) => run.some((_, start) => spanMatches(run, start, quote, () => true)));
}
function inStagedWindow(cited, quote, change) {
    const lines = change.lines;
    if (lines === null)
        return false;
    const changed = (first, last) => {
        if (change.grew)
            return true;
        for (let line = first; line <= last; line += 1)
            if (change.added.has(line))
                return true;
        return false;
    };
    // Line 0 means the top of the file; a line past the end is not clamped back into it.
    const low = Math.max(1, Math.max(cited, 1) - QUOTE_WINDOW);
    const high = Math.min(lines.length, Math.max(cited, 1) + QUOTE_WINDOW);
    for (let line = low; line <= high; line += 1)
        if (spanMatches(lines, line - 1, quote, changed))
            return true;
    return false;
}
function isGrounded(finding, forms, change) {
    const staged = (quote) => quote !== null && inStagedWindow(finding.offendingLine, quote, change);
    const removed = (quote) => quote !== null && inRemoved(quote, change);
    return (staged(forms.plain) ||
        (forms.marker === '+' && staged(forms.body)) ||
        (forms.marker === '-' && removed(forms.body)) ||
        (forms.marker !== '+' && removed(forms.plain)));
}
/** The findings whose OFFENDING quote is real and part of this change; order preserved. */
export function groundConventionFindings(findings, source) {
    if (source.isCurrent && !source.isCurrent())
        return [];
    const reviewed = new Set(source.reviewedFiles);
    const changes = new Map();
    const grounded = [];
    for (const finding of findings) {
        const path = normalizeCitedPath(finding.offendingPath);
        const forms = quoteForms(finding.offendingQuote);
        if (forms === null || !reviewed.has(path))
            continue;
        let change = changes.get(path);
        if (!change) {
            change = fileChange(source, path);
            changes.set(path, change);
        }
        // Canonical path out, so every spelling of one citation shares one lens (and one waiver).
        if (isGrounded(finding, forms, change))
            grounded.push({ ...finding, offendingPath: path });
    }
    return grounded;
}
/** Blocking-authority findings for a transcript: ground every candidate, THEN dedupe by lens. */
export function groundedConventionFindings(raw, source) {
    return dedupeConventionFindings(groundConventionFindings(parseConventionFindingCandidates(raw), source));
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}
/** Rename sources (new path → base path) between two trees, so a moved file keeps its old self. */
function renamesBetween(cwd, base, tree) {
    const renames = new Map();
    const fields = safe(() => git(cwd, ['diff', '-M', '--name-status', '-z', '--no-color', base, tree]), '').split('\0');
    for (let index = 0; index < fields.length; index += 1) {
        const status = fields[index];
        if (/^[RC]\d*$/.test(status)) {
            if (status.startsWith('R') && fields[index + 1] && fields[index + 2])
                renames.set(fields[index + 2], fields[index + 1]);
            index += 2;
        }
        else if (status)
            index += 1;
    }
    return renames;
}
function memo(read) {
    const cache = new Map();
    return (file) => {
        let hit = cache.get(file);
        if (!hit) {
            hit = { value: read(file) };
            cache.set(file, hit);
        }
        return hit.value;
    };
}
const UNREADABLE = {
    reviewedFiles: [],
    readStaged: () => null,
    readHead: () => null,
    readDiff: () => '',
};
/**
 * The production source, pinned when the cascade starts: the staged tree and HEAD the judge was shown.
 * A later restage cannot ground a quote. Unmerged or unreadable state grounds nothing (→ inconclusive).
 */
export function stagedGroundingSource(cwd, files, pinnedTree) {
    const tree = stagedTreeHash(cwd);
    const head = headHash(cwd);
    // `pinnedTree` is the index the judge's evidence was cut from; a restage since then grounds nothing.
    if (tree === null || head === null || (pinnedTree !== undefined && pinnedTree !== tree))
        return UNREADABLE;
    const base = head.startsWith('unborn:') ? EMPTY_TREE : head;
    let renames = null;
    const renameSource = (file) => (renames ??= renamesBetween(cwd, base, tree)).get(file);
    const blob = (rev, file) => safe(() => git(cwd, ['cat-file', 'blob', `${rev}:${file}`]), null);
    const literal = (file) => `:(top,literal)${file}`;
    return {
        reviewedFiles: files,
        isCurrent: () => stagedTreeHash(cwd) === tree,
        readStaged: memo((file) => blob(tree, file)),
        readHead: memo((file) => blob(base, renameSource(file) ?? file)),
        // --no-color/--no-ext-diff: the consumer's git config must not change the bytes parsed here.
        readDiff: memo((file) => {
            const paths = [renameSource(file), file].filter((p) => Boolean(p)).map(literal);
            return safe(() => git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, tree, '--', ...paths]), '');
        }),
    };
}
