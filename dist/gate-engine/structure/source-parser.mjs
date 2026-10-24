// The TypeScript source parser the structure engine hands import-reading rules (independent-modules):
// the plugin's own projectStructureParser is a stub that yields an empty AST.
import { createRequire } from 'node:module';
// Resolved from devkit's OWN install, never the consumer's, so a consumer needs no parser of its own.
const requireFromDevkit = createRequire(import.meta.url);
const requireParser = () => requireFromDevkit('@typescript-eslint/parser');
/** Load lazily and never throw: a consumer whose hoisted `typescript` is 7 (no JS compiler API)
 * makes the parser throw on load, which becomes a named reason instead of a blanket gate failure. */
export function loadSourceParser(load = requireParser) {
    try {
        return {
            parser: load(),
            parserOptions: { sourceType: 'module', ecmaFeatures: { jsx: true } },
        };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const needs = 'needs TypeScript 6 or earlier; TypeScript 7 has no JavaScript compiler API';
        return { reason: `TypeScript source parser unavailable (${needs}): ${message}` };
    }
}
