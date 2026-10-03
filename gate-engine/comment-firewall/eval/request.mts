import { contextFor } from '../detect.mts';
import type { CommentFinding } from '../types.mts';
import { BLOCK_CLOSE, isBlockComment, type Question } from './arms.mts';

export const JEV_MODEL = 'typesafe/jev-1.13';
export const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const COMMENT_MARKER = '<COMMENT>';

export type JudgedComment = Pick<CommentFinding, 'path' | 'startLine' | 'endLine' | 'comment'> & {
  source: string;
};

/** The gate's `finding.context` after writing `text` over the paragraph, as an agent edit would. */
function codeAround(item: JudgedComment, text: string): string {
  const lines = item.source.split('\n');
  const edited = [...lines.slice(0, item.startLine - 1), text, ...lines.slice(item.endLine)];
  const endLine = item.startLine + text.split('\n').length - 1;
  const token = {
    kind: 'line' as const,
    startLine: item.startLine,
    endLine,
    text,
    standalone: true,
  };
  return contextFor(edited.join('\n'), token);
}

const HAS_TEXT = /[^\s/*]/;

/** The paragraph cut to its first two text lines, still a well-formed comment of the same kind. */
export function firstTwoLines(comment: string): string {
  const lines = comment.split('\n');
  if (!isBlockComment(comment))
    return lines
      .filter((line) => HAS_TEXT.test(line))
      .slice(0, 2)
      .join('\n');
  const kept: string[] = [];
  let text = 0;
  for (const line of lines) {
    if (HAS_TEXT.test(line) && text++ === 2) break;
    kept.push(line);
  }
  if (!BLOCK_CLOSE.test(kept.at(-1) ?? '')) kept.push(`${comment.match(/^\s*/)?.[0] ?? ''} */`);
  return kept.join('\n');
}

function stateFor(item: JudgedComment, comment: string | null, compare: boolean) {
  const file = item.path;
  if (comment === null) return { file, code_around: codeAround(item, COMMENT_MARKER) };
  const code_around = codeAround(item, comment);
  if (!compare) return { file, comment, code_around };
  return { file, code_around, version_a: comment, version_b: firstTwoLines(comment) };
}

/** `comment: null` withholds the text for the code-only arm, leaving a marker in its place. */
export function buildRequest(
  item: JudgedComment,
  questions: Record<string, Question>,
  comment: string | null,
  compare = false,
) {
  const state = stateFor(item, comment, compare);
  return { model: JEV_MODEL, provider: { zdr: true }, state, questions };
}
