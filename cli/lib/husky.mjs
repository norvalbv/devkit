/**
 * Husky pre-commit marker constants. The devkit gate set lives between two markers:
 *
 *   # >>> devkit-guards >>>
 *   ...assembled gate lines (see husky-block.mjs)...
 *   # <<< devkit-guards <<<
 *
 * The block is COMPOSED from a component selection in husky-block.mjs; everything outside
 * the markers is the consumer's own hook and is never touched by init or removal.
 */

export const MARK_START = '# >>> devkit-guards >>>';
export const MARK_END = '# <<< devkit-guards <<<';
