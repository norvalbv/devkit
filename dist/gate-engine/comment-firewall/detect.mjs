/**
 * Staged changed-comment detector.
 *
 * The index is the source of truth: worktree-only edits cannot create or clear a finding. Git's
 * added-line attribution selects candidates, then a real TypeScript lexer reconstructs the entire
 * comment token. Delimiters inside strings, regexes, templates, and JSX text are therefore inert.
 */
import { execFileSync } from 'node:child_process';
import { commitIndexEnv } from '../ratchets/commit-index.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ts } from 'ts-morph';
import { resolveGuardConfig, sourceMatchers } from '../config.mjs';
import { gitPrefix } from '../ratchets/git-index.mjs';
import { anchorContext, anchorFor, changedTextLineCount, emptyInventory, hunkIntersects, hunkTouches, recordParagraph, textLineCount, } from './inventory.mjs';
import { commentTouchLines, parsePatchHunks } from './patch.mjs';
import { loadCommentPolicy } from './policy.mjs';
import { refFindings } from './refs.mjs';
export { parsePatchHunks } from './patch.mjs';
export const COMMENT_ADAPTER_VERSION = 'typescript-scanner-v2';
export const COMMENT_FINDING_POLICY = 'changed-comment-paragraph-v6';
const SUPPORTED_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const CONTEXT_LINES = 4;
const LEADING_DOT_SLASH = /^\.\//;
const TRAILING_SLASH = /\/$/;
const TRAILING_CARRIAGE_RETURN = /\r$/;
const TRAILING_BLANKS = /[ \t\r]+$/;
const LEADING_BLANKS = /^[ \t]+/;
const TRAILING_STRUCTURAL_PUNCTUATION = /^(?:[)\]};,.:]+|<\/(?:[A-Za-z][\w:.-]*|)>)+$/;
const LINE_COMMENT_PREFIX = /^\s*\/\/[/!]?[ \t]?/;
const BLOCK_COMMENT_PREFIX = /^\s*\/\*+!?[ \t]?/;
const BLOCK_COMMENT_SUFFIX = /[ \t]*\*\/[ \t]*$/;
const BLOCK_COMMENT_CONTINUATION = /^\s*\*[ \t]?/;
const sha12 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        env: commitIndexEnv(cwd),
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
function splitNul(value) {
    return value.split('\0').filter(Boolean);
}
function stagedPaths(cwd, ref) {
    const args = [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--relative',
        '--diff-filter=ACMR',
        '--no-ext-diff',
    ];
    if (ref)
        args.push(ref);
    return new Set(splitNul(git(cwd, args)));
}
/** Staged renames keyed by new path, so a moved file is diffed against its pre-move blob. */
function stagedRenames(cwd, ref) {
    const args = [
        'diff',
        '--cached',
        '--name-status',
        '-z',
        '--relative',
        '--find-renames',
        '--diff-filter=R',
        '--no-ext-diff',
    ];
    if (ref)
        args.push(ref);
    const fields = splitNul(git(cwd, args));
    const renamed = new Map();
    for (let i = 0; i < fields.length;) {
        const status = fields[i++] ?? '';
        const from = fields[i++];
        const newPath = fields[i++];
        if (from && newPath)
            renamed.set(newPath, { from, pure: status === 'R100' });
    }
    return renamed;
}
/** Merge resolutions are attributed only when they differ from both parents. Paths are read before
 * renames, so an edit staged in between widens the set instead of hiding behind a stale R100. */
function changedPaths(cwd) {
    const firstParent = [...stagedPaths(cwd)];
    const head = stagedRenames(cwd);
    try {
        const mergeParent = stagedPaths(cwd, 'MERGE_HEAD');
        const merge = stagedRenames(cwd, 'MERGE_HEAD');
        const files = firstParent.filter((file) => mergeParent.has(file) && !(head.get(file)?.pure && merge.get(file)?.pure));
        return { files, head, merge };
    }
    catch {
        return { files: firstParent.filter((file) => !head.get(file)?.pure), head, merge: null };
    }
}
function patch(cwd, file, ref, from) {
    const args = [
        '--literal-pathspecs',
        'diff',
        '--cached',
        '--no-color',
        '--no-ext-diff',
        '--find-renames',
        '--unified=4',
        '--relative',
        '--diff-filter=ACMR',
    ];
    if (ref)
        args.push(ref);
    args.push('--', ...(from ? [from, file] : [file]));
    return git(cwd, args);
}
function lineStarts(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++)
        if (source.charCodeAt(i) === 10)
            starts.push(i + 1);
    return starts;
}
function lineAt(starts, position) {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
        const mid = (low + high) >>> 1;
        if ((starts[mid] ?? 0) <= position)
            low = mid;
        else
            high = mid;
    }
    return low + 1;
}
export function scanCommentTokens(source, extension) {
    const scriptKind = extension === 'jsx'
        ? ts.ScriptKind.JSX
        : extension === 'tsx'
            ? ts.ScriptKind.TSX
            : extension === 'js' || extension === 'mjs' || extension === 'cjs'
                ? ts.ScriptKind.JS
                : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(`staged.${extension}`, source, ts.ScriptTarget.Latest, true, scriptKind);
    const starts = lineStarts(source);
    const ranges = new Map();
    const collect = (items) => {
        for (const item of items ?? [])
            ranges.set(`${item.pos}:${item.end}`, item);
    };
    const visit = (node) => {
        collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
        collect(ts.getTrailingCommentRanges(source, node.end));
        for (const child of node.getChildren(sourceFile))
            visit(child);
    };
    visit(sourceFile);
    return [...ranges.values()]
        .sort((left, right) => left.pos - right.pos)
        .map((range) => {
        const start = range.pos;
        const end = range.end;
        const kind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? 'line' : 'block';
        const startLine = lineAt(starts, start);
        const endLine = lineAt(starts, Math.max(start, end - 1));
        const before = source.slice(starts[startLine - 1], start).trim();
        const after = source.slice(end, starts[endLine] ?? source.length).trim();
        const clearAfter = after.length === 0 || TRAILING_STRUCTURAL_PUNCTUATION.test(after);
        return {
            kind,
            startLine,
            endLine,
            text: source.slice(start, end),
            standalone: clearAfter && (before.length === 0 || (kind === 'block' && startLine < endLine)),
        };
    });
}
function stagedBlob(cwd, file) {
    const repoPath = `${gitPrefix(cwd)}${file}`;
    return git(cwd, ['show', `:${repoPath}`]);
}
const extensionOf = (file) => path.extname(file).slice(1).toLowerCase();
/** Each comment line of `ref`'s version of the file, lexed by that path's own extension. */
function commentFragmentsAt(cwd, file, ref) {
    const fragments = new Map();
    const extension = extensionOf(file);
    if (!SUPPORTED_EXTENSIONS.has(extension))
        return fragments;
    let source;
    try {
        source = git(cwd, ['show', `${ref}:${gitPrefix(cwd)}${file}`]);
    }
    catch {
        return fragments;
    }
    for (const token of scanCommentTokens(source, extension)) {
        token.text.split('\n').forEach((part, offset) => {
            const line = token.startLine + offset;
            fragments.set(line, [...(fragments.get(line) ?? []), part]);
        });
    }
    return fragments;
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
function contextFor(source, token) {
    const lines = source.split('\n');
    const from = Math.max(0, token.startLine - 1 - CONTEXT_LINES);
    const to = Math.min(lines.length, token.endLine + CONTEXT_LINES);
    return lines.slice(from, to).join('\n').slice(0, 8_000);
}
function meaningfulLine(line) {
    return line
        .replace(TRAILING_CARRIAGE_RETURN, '')
        .replace(LINE_COMMENT_PREFIX, '')
        .replace(BLOCK_COMMENT_PREFIX, '')
        .replace(BLOCK_COMMENT_SUFFIX, '')
        .replace(BLOCK_COMMENT_CONTINUATION, '')
        .trim();
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
        if (textLines >= 3) {
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
export function detectChangedComments(cwd = process.cwd()) {
    const cfg = resolveGuardConfig(cwd);
    const roots = cfg.scanRoots.map((root) => normalizedRoot(cwd, root));
    const isConfiguredSource = sourceMatchers(cfg.sourceExtensions).isSource;
    const policy = loadCommentPolicy(cwd);
    const findings = [];
    const cited = [];
    const unsupported = [];
    const inventory = emptyInventory();
    const decisionsDir = normalizedRoot(cwd, cfg.decisionsDir);
    inventory.decisionsStaged =
        decisionsDir !== '' && [...stagedPaths(cwd)].some((file) => insideRoots(file, [decisionsDir]));
    const { files, head: headRenames, merge: mergeRenamed } = changedPaths(cwd);
    for (const file of files.sort()) {
        if (!insideRoots(file, roots) || !isConfiguredSource(file))
            continue;
        const extension = extensionOf(file);
        if (!SUPPORTED_EXTENSIONS.has(extension)) {
            unsupported.push({ extension, path: file });
            continue;
        }
        inventory.files += 1;
        const headFrom = headRenames.get(file)?.from;
        const first = parsePatchHunks(patch(cwd, file, undefined, headFrom));
        let effective = first;
        const headFragments = commentFragmentsAt(cwd, headFrom ?? file, 'HEAD');
        let touchLines = commentTouchLines(first, new Set(headFragments.keys()));
        try {
            const mergeFrom = mergeRenamed?.get(file)?.from;
            const second = parsePatchHunks(patch(cwd, file, 'MERGE_HEAD', mergeFrom));
            const secondLines = new Set(second.flatMap((hunk) => [...hunk.addedLines]));
            const secondTouch = commentTouchLines(second, new Set(commentFragmentsAt(cwd, mergeFrom ?? file, 'MERGE_HEAD').keys()));
            effective = first.map((hunk) => ({
                ...hunk,
                addedLines: new Set([...hunk.addedLines].filter((line) => secondLines.has(line))),
            }));
            touchLines = new Set([...touchLines].filter((line) => secondTouch.has(line)));
        }
        catch {
            // Ordinary commit: the first-parent staged patch is the complete attribution set.
        }
        const source = stagedBlob(cwd, file);
        const tokens = scanCommentTokens(source, extension);
        cited.push(...refFindings({ file, tokens, hunks: effective, headFragments }, policy.refs));
        const paragraphs = changedParagraphs(file, source, tokens, effective, touchLines, inventory);
        for (const paragraph of paragraphs) {
            findings.push(findingFor(file, extension, source, paragraph, effective));
        }
    }
    return { findings, refFindings: cited, unsupported, inventory };
}
