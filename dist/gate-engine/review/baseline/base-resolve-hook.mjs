// Frozen review runtime: local imports must be listed in PACKAGED_REVIEW_RUNTIME_MODULE_STEMS.
// Base eslint pass preload: bare imports from final-tree files resolve from the base tree.
import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const FROM_ENV = 'DEVKIT_REVIEW_RESOLVE_FROM';
const TO_ENV = 'DEVKIT_REVIEW_RESOLVE_TO';
const NON_BARE_RE = /^(?:\.|\/|#|[a-z][a-z\d+.-]*:)/i;
const QUERY_OR_HASH_RE = /[?#]/;
const NOT_FOUND_CODES = new Set([
    'ERR_MODULE_NOT_FOUND',
    'ERR_PACKAGE_PATH_NOT_EXPORTED',
    'MODULE_NOT_FOUND',
]);
/** `parentURL` moved from the `from` tree to `to`; undefined outside it or inside node_modules. */
export function rebaseParentURL(parentURL, from, to) {
    const href = parentURL?.split(QUERY_OR_HASH_RE)[0];
    const prefix = `${pathToFileURL(from).href}/`;
    if (!href?.startsWith(prefix))
        return undefined;
    const rest = href.slice(prefix.length);
    if (rest.split('/').includes('node_modules'))
        return undefined;
    return `${pathToFileURL(to).href}/${rest}`;
}
/** Resolve a bare import as if made from the base tree; the final result when that fails. */
export function resolveFromBase(from, to) {
    return (specifier, context, nextResolve) => {
        const { parentURL } = context;
        const bare = !NON_BARE_RE.test(specifier) && !isBuiltin(specifier);
        const rebased = bare ? rebaseParentURL(parentURL, from, to) : undefined;
        if (!rebased)
            return nextResolve(specifier, context);
        try {
            // CJS resolution ignores a rewritten parentURL, so require() resolves from the base path.
            const result = context.conditions.includes('require')
                ? { url: pathToFileURL(createRequire(rebased).resolve(specifier)).href, shortCircuit: true }
                : nextResolve(specifier, { ...context, parentURL: rebased });
            // A workspace link resolves to base SOURCE, which would swap in the merge-base's rules.
            if (result.url.includes('/node_modules/'))
                return result;
        }
        catch (error) {
            const code = error instanceof Error && 'code' in error ? String(error.code) : '';
            if (!NOT_FOUND_CODES.has(code))
                throw error;
        }
        return nextResolve(specifier, { ...context, parentURL });
    };
}
/** Child-process env that preloads this module with bare imports redirected from `from` to `to`. */
export function baseResolveEnv(from, to) {
    const preload = `--import ${import.meta.url}`;
    const nodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ${preload}` : preload;
    return { ...process.env, [FROM_ENV]: from, [TO_ENV]: to, NODE_OPTIONS: nodeOptions };
}
const from = process.env[FROM_ENV];
const to = process.env[TO_ENV];
if (from && to)
    registerHooks({ resolve: resolveFromBase(from, to) });
