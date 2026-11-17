// The test-file infix (`.test.` / `.spec.`) — constant, so it lives at module scope; the
// extension set is what varies, and that's a plain suffix check (no dynamic RegExp needed).
export const TEST_INFIX = /\.(test|spec)\./;
/** Any JavaScript or TypeScript file, whatever `sourceExtensions` a repository declares. */
export const JS_TS_SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/i;
/**
 * Build the impl-file matchers for a `sourceExtensions` list (e.g. `['ts','tsx']` or `['mjs','js']`),
 * so the ratchets are language-agnostic instead of hardcoding `.ts`/`.tsx`. Each returns a predicate:
 * `isSource(name)` true for an impl file; `isTest(name)` for its test variant (`.test.`/`.spec.`);
 * `isBarrel(name)` for an `index` barrel. Fan-out and disable debt use non-test implementation
 * files; the raw-line ratchet also uses `isTest` to apply its separate test ceiling.
 *
 * @param extensions bare extensions, no dot (e.g. `['ts','tsx']`)
 */
export function sourceMatchers(extensions) {
    const exts = extensions.map((e) => `.${e.startsWith('.') ? e.slice(1) : e}`);
    const isSource = (name) => exts.some((x) => name.endsWith(x));
    return {
        isSource,
        isTest: (name) => TEST_INFIX.test(name) && isSource(name),
        isBarrel: (name) => exts.some((x) => name === `index${x}`),
    };
}
