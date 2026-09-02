/**
 * Staged changed-comment detector.
 *
 * The index is the source of truth: worktree-only edits cannot create or clear a finding. Git's
 * added-line attribution selects candidates, then a real TypeScript lexer reconstructs the entire
 * comment token. Delimiters inside strings, regexes, templates, and JSX text are therefore inert.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ts } from 'ts-morph';
import { resolveGuardConfig, sourceMatchers } from '../config.mts';
import { gitPrefix } from '../ratchets/git-index.mts';
import {
  anchorContext,
  anchorFor,
  changedTextLineCount,
  emptyInventory,
  recordParagraph,
} from './inventory.mts';
import type { CommentFinding, CommentInventory, DetectionResult } from './types.mts';

export const COMMENT_ADAPTER_VERSION = 'typescript-scanner-v2';
export const COMMENT_FINDING_POLICY = 'changed-comment-paragraph-v6';
const SUPPORTED_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const CONTEXT_LINES = 4;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
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

interface PatchHunk {
  newStart: number;
  newCount: number;
  addedLines: Set<number>;
  text: string;
}

export interface CommentToken {
  kind: 'line' | 'block';
  startLine: number;
  endLine: number;
  text: string;
  standalone: boolean;
}

const sha12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function splitNul(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function stagedPaths(cwd: string, ref?: string): Set<string> {
  const args = [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--relative',
    '--diff-filter=ACMR',
    '--no-ext-diff',
  ];
  if (ref) args.push(ref);
  return new Set(splitNul(git(cwd, args)));
}

function pureRenames(cwd: string, ref?: string): Set<string> {
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
  if (ref) args.push(ref);
  const fields = splitNul(git(cwd, args));
  const renamed = new Set<string>();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    const _oldPath = fields[i++];
    const newPath = fields[i++];
    if (status === 'R100' && newPath) renamed.add(newPath);
  }
  return renamed;
}

/** Merge resolutions are attributed only when they differ from both parents. */
function changedPaths(cwd: string): string[] {
  const firstParent = stagedPaths(cwd);
  const firstPureRenames = pureRenames(cwd);
  try {
    const mergeParent = stagedPaths(cwd, 'MERGE_HEAD');
    const mergePureRenames = pureRenames(cwd, 'MERGE_HEAD');
    return [...firstParent].filter(
      (file) =>
        mergeParent.has(file) && !(firstPureRenames.has(file) && mergePureRenames.has(file)),
    );
  } catch {
    return [...firstParent].filter((file) => !firstPureRenames.has(file));
  }
}

function patch(cwd: string, file: string, ref?: string): string {
  const args = [
    'diff',
    '--cached',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '--unified=4',
    '--relative',
    '--diff-filter=ACMR',
  ];
  if (ref) args.push(ref);
  args.push('--', file);
  return git(cwd, args);
}

export function parsePatchHunks(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    const header = raw.match(HUNK_HEADER);
    if (header) {
      current = {
        newStart: Number(header[1]),
        newCount: header[2] === undefined ? 1 : Number(header[2]),
        addedLines: new Set(),
        text: raw,
      };
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    current.text += `\n${raw}`;
    /* File headers precede hunks; within a hunk `+++value` is source beginning with `++`. */
    if (raw.startsWith('+')) {
      current.addedLines.add(newLine);
      newLine += 1;
    } else if (!raw.startsWith('\\') && !raw.startsWith('-')) {
      newLine += 1;
    }
  }
  return hunks;
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

function stagedBlob(cwd: string, file: string): string {
  const repoPath = `${gitPrefix(cwd)}${file}`;
  return git(cwd, ['show', `:${repoPath}`]);
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

function hunkIntersects(hunk: PatchHunk, token: CommentToken): boolean {
  for (const line of hunk.addedLines) {
    if (line >= token.startLine && line <= token.endLine) return true;
  }
  return false;
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

function addedLineSet(hunks: PatchHunk[]): Set<number> {
  return new Set(hunks.flatMap((hunk) => [...hunk.addedLines]));
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
  extension: string,
  hunks: PatchHunk[],
  inventory: CommentInventory,
): ChangedParagraph[] {
  const lines = source.split('\n');
  const isBlank = (line: number): boolean => (lines[line - 1] ?? '').trim() === '';
  const tokens = scanCommentTokens(source, extension);
  const paragraphs = paragraphCommentTokens(tokens, isBlank);
  const addedLines = addedLineSet(hunks);
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
    if (!hunks.some((hunk) => hunkIntersects(hunk, token))) continue;
    const textLines = changedTextLineCount(token, addedLines, meaningfulLine);
    if (textLines === 0) continue;
    const anchor = anchorFor(file, context, contextOrdinal);
    recordParagraph(inventory, { anchor, textLines });
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
  const findings: CommentFinding[] = [];
  const unsupported: DetectionResult['unsupported'] = [];
  const inventory = emptyInventory();
  const decisionsDir = normalizedRoot(cwd, cfg.decisionsDir);
  inventory.decisionsStaged =
    decisionsDir !== '' && [...stagedPaths(cwd)].some((file) => insideRoots(file, [decisionsDir]));
  for (const file of changedPaths(cwd).sort()) {
    if (!insideRoots(file, roots) || !isConfiguredSource(file)) continue;
    const extension = path.extname(file).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      unsupported.push({ extension, path: file });
      continue;
    }
    inventory.files += 1;
    const first = parsePatchHunks(patch(cwd, file));
    let effective = first;
    try {
      const second = parsePatchHunks(patch(cwd, file, 'MERGE_HEAD'));
      const secondLines = new Set(second.flatMap((hunk) => [...hunk.addedLines]));
      effective = first.map((hunk) => ({
        ...hunk,
        addedLines: new Set([...hunk.addedLines].filter((line) => secondLines.has(line))),
      }));
    } catch {
      // Ordinary commit: the first-parent staged patch is the complete attribution set.
    }
    const source = stagedBlob(cwd, file);
    for (const paragraph of changedParagraphs(file, source, extension, effective, inventory)) {
      findings.push(findingFor(file, extension, source, paragraph, effective));
    }
  }
  return { findings, unsupported, inventory };
}
