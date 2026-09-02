import { createHash } from 'node:crypto';
import type { CommentToken } from './detect.mts';
import type { CommentInventory, TouchedParagraph } from './types.mts';

const ANCHOR_LINES = 2;

export function emptyInventory(): CommentInventory {
  return {
    files: 0,
    paragraphs: { one: 0, two: 0, over: 0 },
    trailingAdded: 0,
    decisionsStaged: false,
    touched: [],
  };
}

/** Count the paragraph's added/modified lines that carry text once comment syntax is stripped. */
export function changedTextLineCount(
  token: CommentToken,
  addedLines: ReadonlySet<number>,
  meaningful: (line: string) => string,
): number {
  return token.text.split('\n').filter((line, index) => {
    return addedLines.has(token.startLine + index) && Boolean(meaningful(line));
  }).length;
}

/** The code a paragraph sits on: the previous non-blank line and the next two. Identical contexts
 * in one file (two functions both ending `return null; }`) are told apart by an ordinal. */
export function anchorContext(lines: readonly string[], token: CommentToken): string {
  const following: string[] = [];
  for (
    let index = token.endLine;
    index < lines.length && following.length < ANCHOR_LINES;
    index++
  ) {
    const line = (lines[index] ?? '').trim();
    if (line) following.push(line);
  }
  let before = '';
  for (let index = token.startLine - 2; index >= 0 && !before; index--) {
    before = (lines[index] ?? '').trim();
  }
  return JSON.stringify({ before, following });
}

export function anchorFor(file: string, context: string, ordinal: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ file, context, ordinal }))
    .digest('hex')
    .slice(0, 12);
}

export function recordParagraph(inventory: CommentInventory, touched: TouchedParagraph): void {
  const bucket = touched.textLines >= 3 ? 'over' : touched.textLines === 2 ? 'two' : 'one';
  inventory.paragraphs[bucket] += 1;
  inventory.touched.push(touched);
}
