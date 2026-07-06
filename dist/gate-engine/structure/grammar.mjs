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
    // Convention-specific variants (added for the react-app + electron data presets). The *_ts/*_tsx
    // ones are FIXED-extension (a `.tsx` IS a component, a `.ts` IS logic — the distinction is the
    // convention, not the repo language); the rest are extension-parameterized.
    'pascal_ts', // PascalCase .ts (a types/logic sibling of a component)
    'pascal_tsx', // PascalCase .tsx (a component file)
    'camel_ts', // camelCase .ts (a helper; a .tsx must be a PascalCase component)
    'use_hook_camel', // useFoo.ts(x) hook
    'use_hook_kebab', // use-foo.ts(x) hook (canonical)
    'use_hook_pascal', // useFoo/ hook FOLDER name
    'kebab_ts', // kebab .ts
    'kebab_tsx', // kebab .tsx
    'kebab_test_dotted', // kebab test with dotted infixes: foo.server.test.ts
    'vercel_route', // api route: kebab OR [param].ts
    'any_md', // *.md
    'any_file', // catch-all (snapshots/fixtures)
]);
/**
 * The ONE canonical regex STRING for a token, parameterized by the tree's extensions. Consumed by BOTH
 * the walker predicate (here) and the emitted eslint regexParameters (compile.mjs) — single source, no
 * drift. `kebab`/`pascal`/`camel` are single-segment stems (no embedded dots) so a `.test.` file falls
 * to `{test}`/`{kebab_test}`, never to a plain source token.
 *
 * `token` is a bare token name (no braces), e.g. `kebab`; `exts` are the tree's source extensions.
 * Returns an anchored regex source string.
 */
// Reason: a flat token→regex LOOKUP TABLE — one case per {token} in the vocabulary, each a one-line
// return. The branch count IS the vocabulary size, not tangled logic; a Map would just move the same
// table elsewhere and lose the ${E} interpolation clarity.
// fallow-ignore-next-line complexity
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
        // Convention-specific. Fixed-extension (.ts/.tsx intrinsic to the convention):
        case 'pascal_ts':
            return '^[A-Z][A-Za-z0-9]*\\.ts$';
        case 'pascal_tsx':
            return '^[A-Z][A-Za-z0-9]*\\.tsx$';
        case 'camel_ts':
            return '^[a-z][a-zA-Z0-9]*\\.ts$';
        case 'kebab_ts':
            return '^[a-z][a-z0-9-]*\\.ts$';
        case 'kebab_tsx':
            return '^[a-z][a-z0-9-]*\\.tsx$';
        case 'any_md':
            return '^.+\\.md$';
        case 'any_file':
            return '^.+$';
        case 'use_hook_pascal': // FOLDER name (no extension)
            return '^use[A-Z][a-zA-Z0-9]*$';
        // Extension-parameterized:
        case 'use_hook_camel':
            return `^use[A-Z][a-zA-Z0-9]*\\.(${E})$`;
        case 'use_hook_kebab':
            return `^use-[a-z][a-z0-9-]*\\.(${E})$`;
        case 'kebab_test_dotted':
            return `^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.(${E})$`;
        case 'vercel_route':
            return `^([a-z][a-z0-9-]*|\\[[a-zA-Z][a-zA-Z0-9]*\\])\\.(${E})$`;
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
 * `token` is e.g. `{kebab}` or a literal `index.mjs`; `exts` are the bare extensions for this tree
 * (e.g. `['mjs','js']`).
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
 */
export function resolvePatterns(names = [], exts) {
    const preds = names.map((n) => tokenPredicate(n, exts));
    return (name) => preds.some((p) => p(name));
}
/**
 * Does a directory NAME satisfy a `folderName` pattern (a `{…_dir}` token or a literal)?
 */
export function matchesFolderName(dirName, pattern, exts) {
    if (!pattern)
        return true; // no constraint
    return tokenPredicate(pattern, exts)(dirName);
}
