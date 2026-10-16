/**
 * Staged changed-comment detector.
 *
 * The index is the source of truth: worktree-only edits cannot create or clear a finding. Git's
 * added-line attribution selects candidates, then a real TypeScript lexer reconstructs the entire
 * comment token. Delimiters inside strings, regexes, templates, and JSX text are therefore inert.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ts } from 'ts-morph';
import { resolveGuardConfig, sourceMatchers } from '../config.mts';
import { mergeInProgress } from '../ratchets/git-index.mts';
import { catBlobs } from '../ratchets/tree-blobs.mts';
import {
  anchorContext,
  anchorFor,
  changedTextLineCount,
  emptyInventory,
  hunkIntersects,
  hunkTouches,
  recordParagraph,
  textLineCount,
} from './inventory.mts';
import { commentTouchLines, type PatchHunk } from './patch.mts';
import { loadCommentPolicy } from './policy.mts';
import { refFindings } from './refs.mts';
import { type StagedEntry, stagedDiff } from './staged-diff.mts';
import type { CommentFinding, CommentInventory, DetectionResult } from './types.mts';

export { parsePatchHunks } from './patch.mts';

export const COMMENT_ADAPTER_VERSION = 'typescript-scanner-v2';
export const COMMENT_FINDING_POLICY = 'changed-comment-paragraph-v6';
const SUPPORTED_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
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

export interface CommentToken {
  kind: 'line' | 'block';
  startLine: number;
  endLine: number;
  text: string;
  standalone: boolean;
}

const sha12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

const ZERO_OID = /^0+$/;

interface ChangedPaths {
  files: string[];
  head: Map<string, StagedEntry>;
  merge: Map<string, StagedEntry> | null;
}

const isPureRename = (entry: StagedEntry | undefined) => entry?.status === 'R100';

/** Merge resolutions are attributed only when they differ from both parents. Both parents' paths,
 * renames, blob ids and hunks come from one diff each, so they describe one index snapshot. */
function changedPaths(cwd: string): ChangedPaths {
  const head = stagedDiff(cwd);
  if (!mergeInProgress(cwd)) {
    return {
      files: [...head.keys()].filter((file) => !isPureRename(head.get(file))),
      head,
      merge: null,
    };
  }
  const merge = stagedDiff(cwd, 'MERGE_HEAD');
  const files = [...head.keys()].filter(
    (file) => merge.has(file) && !(isPureRename(head.get(file)) && isPureRename(merge.get(file))),
  );
  return { files, head, merge };
}

/** UTF-8 text of each blob id in one `cat-file --batch`; the all-zero id of an added path is skipped. */
function blobTexts(cwd: string, oids: string[]): Map<string, string | null> {
  const wanted = [...new Set(oids.filter((oid) => !ZERO_OID.test(oid)))];
  const read = catBlobs(cwd, wanted);
  if (!read) throw new Error('git cat-file could not read the staged blobs');
  return new Map(wanted.map((oid, index) => [oid, read[index]?.toString('utf8') ?? null]));
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if ((starts[mid] ?? 0) <= position) low = mid;
    else high = mid;
  }
  return low + 1;
}

export function scanCommentTokens(source: string, extension: string): CommentToken[] {
  const scriptKind =
    extension === 'jsx'
      ? ts.ScriptKind.JSX
      : extension === 'tsx'
        ? ts.ScriptKind.TSX
        : extension === 'js' || extension === 'mjs' || extension === 'cjs'
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    `staged.${extension}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const starts = lineStarts(source);
  const ranges = new Map<string, ts.CommentRange>();
  const collect = (items: ts.CommentRange[] | undefined): void => {
    for (const item of items ?? []) ranges.set(`${item.pos}:${item.end}`, item);
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sourceFile)) visit(child);
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
        standalone:
          clearAfter && (before.length === 0 || (kind === 'block' && startLine < endLine)),
      };
    });
}

const extensionOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/** Each comment line of an old-side blob, lexed by its own (pre-rename) path's extension. */
function commentFragments(source: string | null | undefined, file: string) {
  const fragments = new Map<number, string[]>();
  const extension = extensionOf(file);
  if (source == null || !SUPPORTED_EXTENSIONS.has(extension)) return fragments;
  for (const token of scanCommentTokens(source, extension)) {
    token.text.split('\n').forEach((part, offset) => {
      const line = token.startLine + offset;
      fragments.set(line, [...(fragments.get(line) ?? []), part]);
    });
  }
  return fragments;
}

interface Attribution {
  effective: PatchHunk[];
  touchLines: Set<number>;
  headFragments: Map<number, string[]>;
}

/** The first-parent hunks, narrowed during a merge to lines that also differ from MERGE_HEAD. */
function attribution(
  head: StagedEntry,
  merge: StagedEntry | undefined,
  texts: Map<string, string | null>,
): Attribution {
  const headFragments = commentFragments(texts.get(head.srcOid), head.from);
  const touchLines = commentTouchLines(head.hunks, new Set(headFragments.keys()));
  if (!merge) return { effective: head.hunks, touchLines, headFragments };
  const secondLines = new Set(merge.hunks.flatMap((hunk) => [...hunk.addedLines]));
  const secondTouch = commentTouchLines(
    merge.hunks,
    new Set(commentFragments(texts.get(merge.srcOid), merge.from).keys()),
  );
  return {
    effective: head.hunks.map((hunk) => ({
      ...hunk,
      addedLines: new Set([...hunk.addedLines].filter((line) => secondLines.has(line))),
    })),
    touchLines: new Set([...touchLines].filter((line) => secondTouch.has(line))),
    headFragments,
  };
}

function normalizedRoot(cwd: string, root: string): string {
  const rel = path.isAbsolute(root) ? path.relative(cwd, root) : root;
  const posix = rel
    .split(path.sep)
    .join('/')
    .replace(LEADING_DOT_SLASH, '')
    .replace(TRAILING_SLASH, '');
  return posix === '.' ? '' : posix;
}

function insideRoots(file: string, roots: string[]): boolean {
  return roots.some((root) => !root || file === root || file.startsWith(`${root}/`));
}

function contextFor(source: string, token: CommentToken): string {
  const lines = source.split('\n');
  const from = Math.max(0, token.startLine - 1 - CONTEXT_LINES);
  const to = Math.min(lines.length, token.endLine + CONTEXT_LINES);
  return lines.slice(from, to).join('\n').slice(0, 8_000);
}

function meaningfulLine(line: string): string {
  return line
    .replace(TRAILING_CARRIAGE_RETURN, '')
    .replace(LINE_COMMENT_PREFIX, '')
    .replace(BLOCK_COMMENT_PREFIX, '')
    .replace(BLOCK_COMMENT_SUFFIX, '')
    .replace(BLOCK_COMMENT_CONTINUATION, '')
    .trim();
}

/** Gap lines between grouped tokens are kept in `text`, so `startLine + index` stays a source line. */
function joinRun(run: CommentToken[]): string {
  let text = '';
  let previousEnd = 0;
  for (const token of run) {
    text +=
      previousEnd === 0 ? token.text : `${'\n'.repeat(token.startLine - previousEnd)}${token.text}`;
    previousEnd = token.endLine;
  }
  return text;
}

function onlyBlankBetween(from: number, to: number, isBlank: (line: number) => boolean): boolean {
  for (let line = from + 1; line < to; line += 1) if (!isBlank(line)) return false;
  return true;
}

export function paragraphCommentTokens(
  tokens: CommentToken[],
  isBlank: (line: number) => boolean = () => false,
): CommentToken[] {
  const paragraphs: CommentToken[] = [];
  let run: CommentToken[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      const first = run[0];
      const last = run.at(-1);
      if (first && last) {
        const paragraph: CommentToken = {
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
      if (
        previous &&
        (token.kind !== previous.kind ||
          !onlyBlankBetween(previous.endLine, token.startLine, isBlank))
      ) {
        flushRun();
      }
      run.push(token);
      continue;
    }
    flushRun();
    if (token.standalone) paragraphs.push(token);
  }
  flushRun();
  return paragraphs;
}

/** Identity text: indentation and line endings must not re-key a finding. */
function normalizeComment(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(TRAILING_BLANKS, '').replace(LEADING_BLANKS, ''))
    .join('\n');
}

interface ChangedParagraph {
  token: CommentToken;
  twin: TwinDiscriminator;
  anchor: string;
  textLines: number;
}

/** Null when the text is unique in the file; twins keep a position-sensitive key so a pasted
 * copy never shares its twin's identity. */
type TwinDiscriminator = { ordinal: number } | null;

function changedParagraphs(
  file: string,
  source: string,
  tokens: CommentToken[],
  hunks: PatchHunk[],
  touchLines: ReadonlySet<number>,
  inventory: CommentInventory,
): ChangedParagraph[] {
  const lines = source.split('\n');
  const isBlank = (line: number): boolean => (lines[line - 1] ?? '').trim() === '';
  const paragraphs = paragraphCommentTokens(tokens, isBlank);
  const addedLines = new Set(hunks.flatMap((hunk) => [...hunk.addedLines]));
  for (const token of tokens) {
    if (!token.standalone && hunks.some((hunk) => hunkIntersects(hunk, token))) {
      inventory.trailingAdded += 1;
    }
  }
  const totals = new Map<string, number>();
  for (const token of paragraphs) {
    const key = normalizeComment(token.text);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const contexts = new Map<string, number>();
  const changed: ChangedParagraph[] = [];
  for (const token of paragraphs) {
    const key = normalizeComment(token.text);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const context = anchorContext(lines, token);
    const contextOrdinal = contexts.get(context) ?? 0;
    contexts.set(context, contextOrdinal + 1);
    if (!hunks.some((hunk) => hunkTouches(hunk, token, touchLines))) continue;
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

function findingFor(
  file: string,
  extension: string,
  source: string,
  paragraph: ChangedParagraph,
  hunks: PatchHunk[],
): CommentFinding {
  const { token, twin, anchor, textLines } = paragraph;
  const relevantDiff = hunks
    .filter((hunk) => hunkIntersects(hunk, token))
    .map((hunk) => hunk.text)
    .join('\n')
    .slice(0, 12_000);
  const context = contextFor(source, token);
  const id = sha12(
    JSON.stringify({
      policy: COMMENT_FINDING_POLICY,
      adapter: COMMENT_ADAPTER_VERSION,
      path: file,
      comment: normalizeComment(token.text),
      twin: twin && { ordinal: twin.ordinal, context },
    }),
  );
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

export function detectChangedComments(cwd = process.cwd()): DetectionResult {
  const cfg = resolveGuardConfig(cwd);
  const roots = cfg.scanRoots.map((root) => normalizedRoot(cwd, root));
  const isConfiguredSource = sourceMatchers(cfg.sourceExtensions).isSource;
  const policy = loadCommentPolicy(cwd);
  const findings: CommentFinding[] = [];
  const cited: DetectionResult['refFindings'] = [];
  const unsupported: DetectionResult['unsupported'] = [];
  const inventory = emptyInventory();
  const decisionsDir = normalizedRoot(cwd, cfg.decisionsDir);
  const { files, head, merge } = changedPaths(cwd);
  inventory.decisionsStaged =
    decisionsDir !== '' && [...head.keys()].some((file) => insideRoots(file, [decisionsDir]));
  const scanned: string[] = [];
  for (const file of files.sort()) {
    if (!insideRoots(file, roots) || !isConfiguredSource(file)) continue;
    const extension = extensionOf(file);
    if (SUPPORTED_EXTENSIONS.has(extension)) scanned.push(file);
    else unsupported.push({ extension, path: file });
  }
  const texts = blobTexts(
    cwd,
    scanned.flatMap((file) => {
      const entry = head.get(file);
      return [entry?.srcOid, entry?.dstOid, merge?.get(file)?.srcOid].filter(
        (oid): oid is string => oid !== undefined,
      );
    }),
  );
  for (const file of scanned) {
    const entry = head.get(file);
    const source = entry && texts.get(entry.dstOid);
    if (!entry || source == null) throw new Error(`git could not read the staged blob of ${file}`);
    inventory.files += 1;
    const extension = extensionOf(file);
    const { effective, touchLines, headFragments } = attribution(entry, merge?.get(file), texts);
    const tokens = scanCommentTokens(source, extension);
    cited.push(...refFindings({ file, tokens, hunks: effective, headFragments }, policy.refs));
    const paragraphs = changedParagraphs(file, source, tokens, effective, touchLines, inventory);
    for (const paragraph of paragraphs) {
      findings.push(findingFor(file, extension, source, paragraph, effective));
    }
  }
  return { findings, refFindings: cited, unsupported, inventory };
}
