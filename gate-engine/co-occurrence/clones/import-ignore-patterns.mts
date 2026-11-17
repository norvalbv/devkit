/**
 * Import/re-export declarations are excluded from clone detection AT THE TOKENIZER, via jscpd's
 * `--ignore-pattern` (each entry becomes an ignore token rule in the format grammar; matched
 * text never enters any fragment). Two modules using the same shared libs are FORCED into
 * identical, linter-sorted import preambles — the module system working, not copy-paste debt —
 * and a big enough preamble clears the min-tokens floor on its own, false-blocking sibling
 * files. Removing imports up front gives the clean semantic "clones are measured over
 * non-import code": nothing can ride a preamble over the token floor, and nothing real can hide
 * behind one. (A post-hoc fragment classifier was tried first; six reviewer-verified holes —
 * ratio leaks, dynamic import(...), quote-terminated statements, import attributes — showed
 * that design to be unfixable. See the gate-contract tests.)
 *
 * Each pattern is bounded so it can never span arbitrary code: single-line forms forbid `\n`,
 * the multi-line named form crosses lines only inside `{...}` and requires the `} from '...'`
 * closer. Dynamic `import(...)` is runtime code and deliberately matches none of them. jscpd's
 * CLI comma-splits this option, so patterns must stay comma-free. Unmatched exotic shapes
 * (import attributes, default+named multi-line) fall through to normal tokenization — the safe
 * direction: worst case a clone REPORTS and the allowlist is the remedy, never the reverse.
 */
export const IMPORT_IGNORE_PATTERNS = [
  // Named / namespace-in-braces, incl. multi-line specifier lists: import [type] { ... } from 'x';
  String.raw`import\s*(type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"];?`,
  // Default / namespace, single-line only: import foo from 'x'; import * as ns from 'x';
  String.raw`import\s+(type\s+)?[\w$*][^\n]*?from\s*['"][^'"]+['"];?`,
  // Side-effect: import 'x';
  String.raw`import\s*['"][^'"]+['"];?`,
  // Re-export barrels: export { a } from 'x'; / export * from 'x';
  String.raw`export\s*(\{[^}]*\}|\*)\s*from\s*['"][^'"]+['"];?`,
];
