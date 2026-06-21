/**
 * Structure-grammar interpreter — the shared `{token}` pattern table that makes the folder-structure
 * walk language-agnostic. A tree's `grammar` (in guard.config.json `structure.trees[]`) references
 * tokens like `{kebab}` / `{pascal}` / `{test}`; this module resolves them using the tree's
 * `sourceExtensions`, so the SAME grammar governs a `.ts` repo and a `.mjs` repo.
 *
 * NO-DRIFT (the load-bearing guarantee): `tokenRegex()` is the ONE canonical pattern per token. The
 * generic WALKER (walk.mjs → baseline) compiles it into a predicate; the eslint RULE (compile.mjs →
 * regexParameters) emits the SAME string for the plugin to compile. Rule and baseline therefore can't
 * disagree about what a `{kebab}` is. (structure-grammar.test.mjs pins predicate == emitted regex.)
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

const LEADING_DOT = /^\./;
const norm = (exts) => exts.map((e) => e.replace(LEADING_DOT, ''));

/** The full token vocabulary (used by compile.mjs to emit regexParameters). */
export const STRUCTURE_TOKENS = Object.freeze([
  'kebab',
  'kebab_test',
  'pascal',
  'camel',
  'test',
  'css',
  'json',
  'kebab_dir',
  'pascal_dir',
]);

/**
 * The ONE canonical regex STRING for a token, parameterized by the tree's extensions. Consumed by BOTH
 * the walker predicate (here) and the emitted eslint regexParameters (compile.mjs) — single source, no
 * drift. `kebab`/`pascal`/`camel` are single-segment stems (no embedded dots) so a `.test.` file falls
 * to `{test}`/`{kebab_test}`, never to a plain source token.
 *
 * @param {string} token bare token name (no braces), e.g. `kebab`
 * @param {string[]} exts the tree's source extensions
 * @returns {string} an anchored regex source string
 */
export function tokenRegex(token, exts) {
  const E = norm(exts).join('|');
  switch (token) {
    case 'kebab':
      return `^[a-z][a-z0-9-]*\\.(${E})$`;
    case 'kebab_test':
      return `^[a-z][a-z0-9-]*\\.(test|spec)\\.(${E})$`;
    case 'pascal':
      return `^[A-Z][A-Za-z0-9]*\\.(${E})$`;
    case 'camel':
      return `^[a-z][a-zA-Z0-9]*\\.(${E})$`;
    case 'test':
      return `^.+\\.(test|spec)\\.(${E})$`;
    case 'css':
      return '^.+\\.css$';
    case 'json':
      return '^.+\\.json$';
    case 'kebab_dir':
      return '^[a-z][a-z0-9-]*$';
    case 'pascal_dir':
      return '^[A-Z][A-Za-z0-9]*$';
    default:
      throw new Error(`unknown structure grammar token "${token}"`);
  }
}

// Compiled-regex cache keyed by token+exts. The walker visits many directories per tree, so this
// avoids recompiling the same handful of patterns; the underlying source is tokenRegex (single truth).
const RE_CACHE = new Map();
function compiledRegex(token, exts) {
  const key = `${token}|${exts.join(',')}`;
  let re = RE_CACHE.get(key);
  if (!re) {
    // Extension-parameterized (built from the tree's sourceExtensions) → not a top-level literal;
    // compiled once per token+exts and cached above. Source string is tokenRegex (single truth).
    re = new RegExp(tokenRegex(token, exts));
    RE_CACHE.set(key, re);
  }
  return re;
}

/**
 * Resolve ONE `{token}` (or a literal name) to a predicate `(basename) => boolean`, given the tree's
 * extension set. A literal (no surrounding `{…}`) matches that exact basename.
 *
 * @param {string} token e.g. `{kebab}` or a literal `index.mjs`
 * @param {string[]} exts bare extensions for this tree (e.g. `['mjs','js']`)
 * @returns {(name:string)=>boolean}
 */
export function tokenPredicate(token, exts) {
  if (!(token.startsWith('{') && token.endsWith('}'))) {
    return (name) => name === token; // literal filename
  }
  const re = compiledRegex(token.slice(1, -1), exts);
  return (name) => re.test(name);
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
