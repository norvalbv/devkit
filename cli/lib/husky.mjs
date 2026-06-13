/**
 * Husky pre-commit wiring. The devkit gate set lives between two markers:
 *
 *   # >>> devkit-guards >>>
 *   ...generated gate lines...
 *   # <<< devkit-guards <<<
 *
 * If the consumer has no hook, we write the whole template. If they have one (frink /
 * a marketing site already run their own hook), we insert/refresh ONLY the marker block
 * and never clobber the surrounding consumer-authored lines.
 */

import { readFileSync } from 'node:fs';

export const MARK_START = '# >>> devkit-guards >>>';
export const MARK_END = '# <<< devkit-guards <<<';

/** Extract the marker block (inclusive of markers) from the devkit template. */
export function extractBlock(templateContent) {
  const start = templateContent.indexOf(MARK_START);
  const end = templateContent.indexOf(MARK_END);
  if (start === -1 || end === -1) {
    throw new Error('devkit pre-commit template is missing its # devkit-guards markers');
  }
  return templateContent.slice(start, end + MARK_END.length);
}

/** Does the on-disk hook already contain a devkit-guards marker block? */
export function hasBlock(hookContent) {
  return hookContent.includes(MARK_START) && hookContent.includes(MARK_END);
}

/**
 * Compute the new content for an EXISTING hook: if it already has a marker block, replace
 * just that block; otherwise append the block (with a separating blank line). Consumer
 * lines outside the markers are preserved verbatim.
 *
 * @returns {{ content: string, action: 'inserted'|'refreshed'|'unchanged' }}
 */
export function mergeBlock(hookContent, block) {
  if (hasBlock(hookContent)) {
    const start = hookContent.indexOf(MARK_START);
    const end = hookContent.indexOf(MARK_END) + MARK_END.length;
    const existing = hookContent.slice(start, end);
    if (existing === block) return { content: hookContent, action: 'unchanged' };
    const merged = hookContent.slice(0, start) + block + hookContent.slice(end);
    return { content: merged, action: 'refreshed' };
  }
  const sep = hookContent.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${hookContent}${sep}${block}\n`, action: 'inserted' };
}

/** Read a hook file (returns '' if unreadable — caller decides absent-vs-present beforehand). */
export function readHook(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
