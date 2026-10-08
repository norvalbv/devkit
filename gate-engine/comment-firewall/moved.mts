/** Standalone comment lines removed anywhere in the staged set excuse an added run made wholly of
 * them: moved text is relocated, not written by this change. Each line excuses once. */
import { gitPrefix } from '../ratchets/git-index.mts';
import type { CommentToken } from './detect.mts';
import { parsePatchHunks } from './patch.mts';
import { git, patch, splitNul } from './staged.mts';

const TRAILING_CARRIAGE_RETURN = /\r$/;
const LINE_COMMENT_PREFIX = /^\s*\/\/[/!]?[ \t]?/;
const BLOCK_COMMENT_PREFIX = /^\s*\/\*+!?[ \t]?/;
const BLOCK_COMMENT_SUFFIX = /[ \t]*\*\/[ \t]*$/;
const BLOCK_COMMENT_CONTINUATION = /^\s*\*[ \t]?/;

/** Removed comment text lines not yet matched, with their remaining count. */
export type MovedPool = Map<string, number>;

/** The lexer for a path's extension, or null when it has none, so its blob is never read. */
type LexerFor = (file: string) => ((source: string) => CommentToken[]) | null;

interface StagedChange {
  status: string;
  from: string;
  to?: string;
}

interface CommentRun {
  lines: number[];
  parts: string[];
}

export function meaningfulLine(line: string): string {
  return line
    .replace(TRAILING_CARRIAGE_RETURN, '')
    .replace(LINE_COMMENT_PREFIX, '')
    .replace(BLOCK_COMMENT_PREFIX, '')
    .replace(BLOCK_COMMENT_SUFFIX, '')
    .replace(BLOCK_COMMENT_CONTINUATION, '')
    .trim();
}

/** Text of every standalone comment line, keyed by source line; '' for a delimiter-only line. */
function standaloneText(tokens: readonly CommentToken[]): Map<number, string> {
  const text = new Map<number, string>();
  for (const token of tokens) {
    if (!token.standalone) continue;
    token.text.split('\n').forEach((part, offset) => {
      text.set(token.startLine + offset, meaningfulLine(part));
    });
  }
  return text;
}

/** Maximal runs of changed standalone comment text; blanks and text-free delimiters never break one. */
export function commentRuns(
  source: string,
  tokens: readonly CommentToken[],
  changed: (line: number) => boolean,
): CommentRun[] {
  const text = standaloneText(tokens);
  const lines = source.split('\n');
  const runs: CommentRun[] = [];
  let run: CommentRun = { lines: [], parts: [] };
  const close = (): void => {
    if (run.parts.length > 0) runs.push(run);
    run = { lines: [], parts: [] };
  };
  for (let line = 1; line <= lines.length; line++) {
    const part = text.get(line);
    if (part === undefined) {
      if ((lines[line - 1] ?? '').trim() !== '') close();
    } else if (part === '') {
      if (changed(line)) run.lines.push(line);
    } else if (changed(line)) {
      run.lines.push(line);
      run.parts.push(part);
    } else {
      close();
    }
  }
  close();
  return runs;
}

function removedLines(cwd: string, file: string, from?: string): Set<number> {
  const hunks = parsePatchHunks(patch(cwd, file, undefined, from));
  return new Set(hunks.flatMap((hunk) => hunk.runs.flatMap((run) => run.removed)));
}

/** Removed standalone comment text of one staged path; an unreadable blob contributes nothing. */
function removedText(
  cwd: string,
  prefix: string,
  entry: StagedChange,
  lexerFor: LexerFor,
): string[] {
  const lex = lexerFor(entry.from);
  if (!lex) return [];
  try {
    const tokens = lex(git(cwd, ['show', `HEAD:${prefix}${entry.from}`]));
    const removed =
      entry.status === 'D'
        ? null
        : removedLines(cwd, entry.to ?? entry.from, entry.to && entry.from);
    return [...standaloneText(tokens)]
      .filter(([line, part]) => part && (!removed || removed.has(line)))
      .map(([, part]) => part);
  } catch {
    return [];
  }
}

/** Every standalone comment line the staged change removes from HEAD, across modified, renamed-away
 * and deleted files. */
export function movedPool(cwd: string, lexerFor: LexerFor): MovedPool {
  const fields = splitNul(
    git(cwd, [
      'diff',
      '--cached',
      '--name-status',
      '-z',
      '--relative',
      '--find-renames',
      '--diff-filter=MRD',
      '--no-ext-diff',
    ]),
  );
  const prefix = gitPrefix(cwd);
  const pool: MovedPool = new Map();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    const from = fields[i++] ?? '';
    const to = status.startsWith('R') ? fields[i++] : undefined;
    for (const part of removedText(cwd, prefix, { status, from, to }, lexerFor)) {
      pool.set(part, (pool.get(part) ?? 0) + 1);
    }
  }
  return pool;
}

/** Lines of added runs whose every text line is still in the pool, which they then consume. */
export function movedLines(
  source: string,
  tokens: readonly CommentToken[],
  added: ReadonlySet<number>,
  pool: MovedPool,
): Set<number> {
  const moved = new Set<number>();
  for (const { lines, parts } of commentRuns(source, tokens, (line) => added.has(line))) {
    const need = new Map<string, number>();
    for (const part of parts) need.set(part, (need.get(part) ?? 0) + 1);
    if ([...need].some(([part, count]) => (pool.get(part) ?? 0) < count)) continue;
    for (const [part, count] of need) pool.set(part, (pool.get(part) ?? 0) - count);
    for (const line of lines) moved.add(line);
  }
  return moved;
}
