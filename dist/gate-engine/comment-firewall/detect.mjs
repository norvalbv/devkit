/**
 * Staged changed-comment detector.
 *
 * The index is the source of truth: worktree-only edits cannot create or clear a finding. Git's
 * added-line attribution selects candidates, then a real TypeScript lexer reconstructs the entire
 * comment token. Delimiters inside strings, regexes, templates, and JSX text are therefore inert.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveGuardConfig, sourceMatchers } from '../config.mjs';
import { mergeInProgress } from '../ratchets/git-index.mjs';
import { catBlobs } from '../ratchets/tree-blobs.mjs';
import { anchorContext, anchorFor, changedTextLineCount, emptyInventory, hunkIntersects, hunkTouches, recordParagraph, textLineCount, } from './findings/inventory.mjs';
import { commentTouchLines } from './staged/patch.mjs';
import { loadCommentPolicy } from './findings/policy.mjs';
import { addedCommentText, meaningfulLine, movedLines, movedPool } from './staged/moved.mjs';
import { refFindings } from './findings/refs.mjs';
import { scanCommentTokens } from './staged/scan.mjs';
import { stagedDiff } from './staged/staged-diff.mjs';
export { parsePatchHunks } from './staged/patch.mjs';
export const COMMENT_ADAPTER_VERSION = 'typescript-scanner-v2';
export const COMMENT_FINDING_POLICY = 'changed-comment-paragraph-v6';
const SUPPORTED_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
export const CONTEXT_LINES = 4;
const LEADING_DOT_SLASH = /^\.\//;
const TRAILING_SLASH = /\/$/;
const TRAILING_BLANKS = /[ \t\r]+$/;
const LEADING_BLANKS = /^[ \t]+/;
const sha12 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const ZERO_OID = /^0+$/;
const isPureRename = (entry) => entry?.status === 'R100';
/** Merge resolutions are attributed only when they differ from both parents. Both parents' paths,
 * renames, blob ids and hunks come from one diff each, so they describe one index snapshot. */
function changedPaths(cwd) {
    const head = stagedDiff(cwd);
    if (!mergeInProgress(cwd)) {
        return {
            files: [...head.keys()].filter((file) => !isPureRename(head.get(file))),
            head,
            merge: null,
        };
    }
    const merge = stagedDiff(cwd, 'MERGE_HEAD');
    const files = [...head.keys()].filter((file) => merge.has(file) && !(isPureRename(head.get(file)) && isPureRename(merge.get(file))));
    return { files, head, merge };
}
/** UTF-8 text of each blob id in one `cat-file --batch`; the all-zero id of an added path is skipped. */
function blobTexts(cwd, oids) {
    const wanted = [...new Set(oids.filter((oid) => !ZERO_OID.test(oid)))];
    const read = catBlobs(cwd, wanted);
    if (!read)
        throw new Error('git cat-file could not read the staged blobs');
    return new Map(wanted.map((oid, index) => [oid, read[index]?.toString('utf8') ?? null]));
}
const extensionOf = (file) => path.extname(file).slice(1).toLowerCase();
function lexerFor(file) {
    const extension = extensionOf(file);
    if (!SUPPORTED_EXTENSIONS.has(extension))
        return null;
    return (source) => scanCommentTokens(source, extension);
}
/** Each comment line of an old-side blob, lexed by its own (pre-rename) path's extension. */
function commentFragments(source, file) {
    const fragments = new Map();
    const extension = extensionOf(file);
    if (source == null || !SUPPORTED_EXTENSIONS.has(extension))
        return fragments;
    for (const token of scanCommentTokens(source, extension)) {
        token.text.split('\n').forEach((part, offset) => {
            const line = token.startLine + offset;
            fragments.set(line, [...(fragments.get(line) ?? []), part]);
        });
    }
    return fragments;
}
/** The first-parent hunks, narrowed during a merge to lines that also differ from MERGE_HEAD. */
function attribution(head, merge, texts) {
    const headFragments = commentFragments(texts.get(head.srcOid), head.from);
    const touchLines = commentTouchLines(head.hunks, new Set(headFragments.keys()));
    if (!merge)
        return { effective: head.hunks, touchLines, headFragments };
    const secondLines = new Set(merge.hunks.flatMap((hunk) => [...hunk.addedLines]));
    const secondTouch = commentTouchLines(merge.hunks, new Set(commentFragments(texts.get(merge.srcOid), merge.from).keys()));
    return {
        effective: head.hunks.map((hunk) => ({
            ...hunk,
            addedLines: new Set([...hunk.addedLines].filter((line) => secondLines.has(line))),
        })),
        touchLines: new Set([...touchLines].filter((line) => secondTouch.has(line))),
        headFragments,
    };
}
function normalizedRoot(cwd, root) {
    const rel = path.isAbsolute(root) ? path.relative(cwd, root) : root;
    const posix = rel
        .split(path.sep)
        .join('/')
        .replace(LEADING_DOT_SLASH, '')
        .replace(TRAILING_SLASH, '');
    return posix === '.' ? '' : posix;
}
function insideRoots(file, roots) {
    return roots.some((root) => !root || file === root || file.startsWith(`${root}/`));
}
export function contextFor(source, token) {
    const lines = source.split('\n');
    const from = Math.max(0, token.startLine - 1 - CONTEXT_LINES);
    const to = Math.min(lines.length, token.endLine + CONTEXT_LINES);
    return lines.slice(from, to).join('\n').slice(0, 8_000);
}
/** Gap lines between grouped tokens are kept in `text`, so `startLine + index` stays a source line. */
function joinRun(run) {
    let text = '';
    let previousEnd = 0;
    for (const token of run) {
        text +=
            previousEnd === 0 ? token.text : `${'\n'.repeat(token.startLine - previousEnd)}${token.text}`;
        previousEnd = token.endLine;
    }
    return text;
}
function onlyBlankBetween(from, to, isBlank) {
    for (let line = from + 1; line < to; line += 1)
        if (!isBlank(line))
            return false;
    return true;
}
export function paragraphCommentTokens(tokens, isBlank = () => false) {
    const paragraphs = [];
    let run = [];
    const flushRun = () => {
        if (run.length > 0) {
            const first = run[0];
            const last = run.at(-1);
            if (first && last) {
                const paragraph = {
                    kind: first.kind,
                    startLine: first.startLine,
                    endLine: last.endLine,
                    text: joinRun(run),
                    standalone: true,
                };
                paragraphs.push(paragraph);
            }
        }
        run = [];
    };
    for (const token of tokens) {
        const groupable = token.kind === 'line' || token.startLine === token.endLine;
        if (token.standalone && groupable) {
            const previous = run.at(-1);
            if (previous &&
                (token.kind !== previous.kind ||
                    !onlyBlankBetween(previous.endLine, token.startLine, isBlank))) {
                flushRun();
            }
            run.push(token);
            continue;
        }
        flushRun();
        if (token.standalone)
            paragraphs.push(token);
    }
    flushRun();
    return paragraphs;
}
/** Identity text: indentation and line endings must not re-key a finding. */
function normalizeComment(text) {
    return text
        .split('\n')
        .map((line) => line.replace(TRAILING_BLANKS, '').replace(LEADING_BLANKS, ''))
        .join('\n');
}
/** A touched paragraph blocks at this many added or edited text lines; unchanged lines are free. */
export const PARAGRAPH_CHANGED_LINE_LIMIT = 3;
function changedParagraphs(file, source, tokens, hunks, touchLines, inventory) {
    const lines = source.split('\n');
    const isBlank = (line) => (lines[line - 1] ?? '').trim() === '';
    const paragraphs = paragraphCommentTokens(tokens, isBlank);
    const addedLines = new Set(hunks.flatMap((hunk) => [...hunk.addedLines]));
    for (const token of tokens) {
        if (!token.standalone && hunks.some((hunk) => hunkIntersects(hunk, token))) {
            inventory.trailingAdded += 1;
        }
    }
    const totals = new Map();
    for (const token of paragraphs) {
        const key = normalizeComment(token.text);
        totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const seen = new Map();
    const contexts = new Map();
    const changed = [];
    for (const token of paragraphs) {
        const key = normalizeComment(token.text);
        const ordinal = seen.get(key) ?? 0;
        seen.set(key, ordinal + 1);
        const context = anchorContext(lines, token);
        const contextOrdinal = contexts.get(context) ?? 0;
        contexts.set(context, contextOrdinal + 1);
        if (!hunks.some((hunk) => hunkTouches(hunk, token, touchLines)))
            continue;
        const textLines = changedTextLineCount(token, addedLines, meaningfulLine);
        const anchor = anchorFor(file, context, contextOrdinal);
        recordParagraph(inventory, { anchor, textLines: textLineCount(token, meaningfulLine) });
        if (textLines >= PARAGRAPH_CHANGED_LINE_LIMIT) {
            const twin = (totals.get(key) ?? 0) > 1 ? { ordinal } : null;
            changed.push({ token, twin, anchor, textLines });
        }
    }
    return changed;
}
function findingFor(file, extension, source, paragraph, hunks) {
    const { token, twin, anchor, textLines } = paragraph;
    const relevantDiff = hunks
        .filter((hunk) => hunkIntersects(hunk, token))
        .map((hunk) => hunk.text)
        .join('\n')
        .slice(0, 12_000);
    const context = contextFor(source, token);
    const id = sha12(JSON.stringify({
        policy: COMMENT_FINDING_POLICY,
        adapter: COMMENT_ADAPTER_VERSION,
        path: file,
        comment: normalizeComment(token.text),
        twin: twin && { ordinal: twin.ordinal, context },
    }));
    return {
        id,
        path: file,
        extension,
        adapterVersion: COMMENT_ADAPTER_VERSION,
        kind: token.kind,
        startLine: token.startLine,
        endLine: token.endLine,
        comment: token.text,
        context,
        relevantDiff,
        anchor,
        textLines,
    };
}
export function detectChangedComments(cwd = process.cwd(), only) {
    const cfg = resolveGuardConfig(cwd);
    const roots = cfg.scanRoots.map((root) => normalizedRoot(cwd, root));
    const isConfiguredSource = sourceMatchers(cfg.sourceExtensions).isSource;
    const policy = loadCommentPolicy(cwd);
    const findings = [];
    const cited = [];
    const unsupported = [];
    const inventory = emptyInventory();
    const decisionsDir = normalizedRoot(cwd, cfg.decisionsDir);
    const { files, head, merge } = changedPaths(cwd);
    inventory.decisionsStaged =
        decisionsDir !== '' && [...head.keys()].some((file) => insideRoots(file, [decisionsDir]));
    const scanned = [];
    for (const file of files.sort()) {
        if (only && !only.has(file))
            continue;
        if (!insideRoots(file, roots) || !isConfiguredSource(file))
            continue;
        const extension = extensionOf(file);
        if (SUPPORTED_EXTENSIONS.has(extension))
            scanned.push(file);
        else
            unsupported.push({ extension, path: file });
    }
    const texts = blobTexts(cwd, scanned.flatMap((file) => {
        const entry = head.get(file);
        return [entry?.srcOid, entry?.dstOid, merge?.get(file)?.srcOid].filter((oid) => oid !== undefined);
    }));
    const staged = scanned.map((file) => {
        const entry = head.get(file);
        const source = entry && texts.get(entry.dstOid);
        if (!entry || source == null)
            throw new Error(`git could not read the staged blob of ${file}`);
        inventory.files += 1;
        const extension = extensionOf(file);
        const { effective, touchLines, headFragments } = attribution(entry, merge?.get(file), texts);
        const tokens = scanCommentTokens(source, extension);
        const added = new Set(effective.flatMap((hunk) => [...hunk.addedLines]));
        return { file, extension, source, tokens, effective, added, touchLines, headFragments };
    });
    const candidates = new Set(staged.flatMap(({ source, tokens, added }) => addedCommentText(source, tokens, added)));
    const pool = merge ? new Map() : movedPool(cwd, lexerFor, candidates);
    for (const { file, extension, source, tokens, effective, added, touchLines, headFragments, } of staged) {
        const moved = movedLines(source, tokens, added, pool);
        const hunks = effective.map((hunk) => ({
            ...hunk,
            addedLines: new Set([...hunk.addedLines].filter((line) => !moved.has(line))),
        }));
        cited.push(...refFindings({ file, tokens, hunks, headFragments }, policy.refs));
        const paragraphs = changedParagraphs(file, source, tokens, hunks, touchLines, inventory);
        for (const paragraph of paragraphs) {
            findings.push(findingFor(file, extension, source, paragraph, hunks));
        }
    }
    return { findings, refFindings: cited, unsupported, inventory };
}
