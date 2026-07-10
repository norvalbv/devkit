/**
 * Husky pre-commit marker constants. The devkit gate set lives between two markers:
 *
 *   # >>> devkit-guards >>>                 (root install — cwd IS the git root)
 *   ...assembled gate lines (see husky-block.mjs)...
 *   # <<< devkit-guards <<<
 *
 * In a MONOREPO the hook lives at the git root but governs a package subdir, so the block is
 * package-SCOPED — its markers carry the package's relative path so several packages coexist
 * in one hook without clobbering each other:
 *
 *   # >>> devkit-guards: services/webapp >>>
 *   ( cd "services/webapp" || exit 1
 *     ...gate lines...
 *   ) || exit 1
 *   # <<< devkit-guards: services/webapp <<<
 *
 * The block is COMPOSED from a selection in husky-block.mjs; everything outside the markers is
 * the consumer's own hook and is never touched by init or removal.
 */
const MARK_START_BASE = '# >>> devkit-guards';
const MARK_END_BASE = '# <<< devkit-guards';
/** Opening marker for a package (pkgRel ''  → the unsuffixed root marker, back-compat). */
export function markStart(pkgRel = '') {
    return pkgRel ? `${MARK_START_BASE}: ${pkgRel} >>>` : `${MARK_START_BASE} >>>`;
}
/** Closing marker for a package (pkgRel '' → the unsuffixed root marker, back-compat). */
export function markEnd(pkgRel = '') {
    return pkgRel ? `${MARK_END_BASE}: ${pkgRel} <<<` : `${MARK_END_BASE} <<<`;
}
