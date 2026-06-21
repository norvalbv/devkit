/**
 * Structure-grammar interpreter — the shared `{token}` pattern table that makes the folder-structure
 * walk language-agnostic. A tree's `grammar` (in guard.config.json `structure.trees[]`) references
 * tokens like `{kebab}` / `{pascal}` / `{test}`; this module resolves them to predicates using the
 * tree's `sourceExtensions`, so the SAME grammar governs a `.ts` repo and a `.mjs` repo.
 *
 * Predicates are built from string ops + a few top-level stem regexes (extension-INdependent), so
 * there is no per-call dynamic `new RegExp` (mirrors `sourceMatchers` in config.mjs).
 *
 * Token vocabulary:
 *   FILE tokens (match a basename):
 *     {kebab}       kebab-cased source file, e.g. `staged-filter.mjs`
 *     {kebab_test}  kebab-cased test file,   e.g. `staged-filter.test.mjs`
 *     {pascal}      PascalCased source file, e.g. `Button.tsx`
 *     {camel}       camelCased source file,  e.g. `cn.ts`
 *     {test}        any test file (.test./.spec.) in a source extension
 *     {css}         `*.css`
 *     {json}        `*.json`
 *   FOLDER tokens (match a directory name):
 *     {kebab_dir}   kebab-cased folder, e.g. `co-occurrence`
 *     {pascal_dir}  PascalCased folder, e.g. `Button`
 *   Anything not wrapped in `{…}` is matched as a LITERAL basename (e.g. `index.mjs`, `config.mjs`).
 */

// Extension-independent stem shapes (top-level → no useTopLevelRegex lint).
const KEBAB_STEM = /^[a-z][a-z0-9-]*$/;
const PASCAL_STEM = /^[A-Z][A-Za-z0-9]*$/;
const CAMEL_STEM = /^[a-z][a-zA-Z0-9]*$/;
const TEST_INFIX = /\.(test|spec)\./;
const LEADING_DOT = /^\./;

// Split a basename into { stem (before first dot), ext (after last dot), isTest }.
function parts(name) {
  const firstDot = name.indexOf('.');
  const stem = firstDot === -1 ? name : name.slice(0, firstDot);
  const lastDot = name.lastIndexOf('.');
  const ext = lastDot === -1 ? '' : name.slice(lastDot + 1);
  return { stem, ext, isTest: TEST_INFIX.test(name) };
}

const norm = (exts) => exts.map((e) => e.replace(LEADING_DOT, ''));

/**
 * Resolve ONE `{token}` (or a literal name) to a predicate `(basename) => boolean`, given the tree's
 * extension set. A literal (no surrounding `{…}`) matches that exact basename.
 *
 * @param {string} token e.g. `{kebab}` or a literal `index.mjs`
 * @param {string[]} exts bare extensions for this tree (e.g. `['mjs','js']`)
 * @returns {(name:string)=>boolean}
 */
// Reason: flat token dispatch — one case per {token} in the grammar vocabulary, each a trivial
// predicate; the branch COUNT is the vocabulary size, not tangled logic. CRAP is a static estimate;
// it's exercised end-to-end via walkTree (structure-walk.test.mjs), not unit-tested per token.
// fallow-ignore-next-line complexity
export function tokenPredicate(token, exts) {
  if (!(token.startsWith('{') && token.endsWith('}'))) {
    return (name) => name === token; // literal filename
  }
  const E = norm(exts);
  const srcExt = (name) => E.includes(parts(name).ext);
  switch (token.slice(1, -1)) {
    case 'kebab':
      return (name) => !parts(name).isTest && KEBAB_STEM.test(parts(name).stem) && srcExt(name);
    case 'kebab_test':
      return (name) => parts(name).isTest && KEBAB_STEM.test(parts(name).stem) && srcExt(name);
    case 'pascal':
      return (name) => !parts(name).isTest && PASCAL_STEM.test(parts(name).stem) && srcExt(name);
    case 'camel':
      return (name) => !parts(name).isTest && CAMEL_STEM.test(parts(name).stem) && srcExt(name);
    case 'test':
      return (name) => parts(name).isTest && srcExt(name);
    case 'css':
      return (name) => parts(name).ext === 'css';
    case 'json':
      return (name) => parts(name).ext === 'json';
    case 'kebab_dir':
      return (name) => KEBAB_STEM.test(name);
    case 'pascal_dir':
      return (name) => PASCAL_STEM.test(name);
    default:
      throw new Error(`unknown structure grammar token "${token}"`);
  }
}

/**
 * Compile a list of allowed-file patterns (literals + `{token}`s) into ONE predicate that is true when
 * a basename matches ANY of them.
 *
 * @param {string[]} names
 * @param {string[]} exts
 * @returns {(name:string)=>boolean}
 */
export function resolvePatterns(names = [], exts) {
  const preds = names.map((n) => tokenPredicate(n, exts));
  return (name) => preds.some((p) => p(name));
}

/**
 * Does a directory NAME satisfy a `folderName` pattern (a `{…_dir}` token or a literal)?
 * @param {string} dirName
 * @param {string|undefined} pattern
 * @param {string[]} exts
 */
export function matchesFolderName(dirName, pattern, exts) {
  if (!pattern) return true; // no constraint
  return tokenPredicate(pattern, exts)(dirName);
}
