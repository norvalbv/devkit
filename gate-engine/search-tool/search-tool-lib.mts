/**
 * Search-tool-specific classification logic for search-tool-guard
 * (PreToolUse) and search-tool-counter (PostToolUse), kept in one place so
 * the two hooks can't drift on what counts as a search. Counter uses
 * isPrimarySearchCommand (re-exported, from search-tool-shell.mts) + the
 * out-of-index helpers (isExcludedTarget / isOutOfScanRoots); guard uses
 * hasCommandSearch (re-exported), firstAdvisablePattern (which folds
 * exclusion + pattern-extraction into one per-invocation-correlated call —
 * see its doc comment for why a separate isExcludedTarget-then-extractPattern
 * pair is NOT equivalent), and classify. Generic Bash-string parsing
 * (normalize, stripQuotes, hasCommandSearch, isPrimarySearchCommand,
 * splitUnquotedSegments, tokenizeArgv, matchUnquoted) lives in
 * search-tool-shell.mts — this file only re-exports normalize/
 * hasCommandSearch/isPrimarySearchCommand for convenience since both hooks
 * need them alongside this file's own exports.
 *
 * Pure string classifiers — provider-agnostic (Cursor vs Claude run the same
 * Bash strings) and data-free, so this file ships as-is (no consumer
 * coupling): the out-of-index helpers take roots as PARAMETERS rather than
 * reading any config themselves — the hooks resolve those from the
 * consumer's guard.config.json and pass them in.
 *
 * Regexes are hoisted to module scope (devkit lint: useTopLevelRegex) — they are
 * the classifier's static grammar, reused on every hook invocation.
 */

import { matchUnquoted, splitUnquotedSegments, tokenizeArgv } from './search-tool-shell.mts';

export { hasCommandSearch, isPrimarySearchCommand, normalize } from './search-tool-shell.mts';

// --- extractPattern ---
// `fd` shares grep's `PATTERN [PATH...]` argv convention (token 0 after the
// bin name is the pattern, not a path) — unlike `find`, whose paths come
// BEFORE any flag/test (see RE_FIND_SCOPE / findInvocationTargets below).
//
// The bin name must be preceded by start-of-segment, whitespace, or `$(`
// (NOT a bare `\b` word boundary, which also fires on `/`/`-`/`.`/`_` — so a
// plain `\b` regex reads "ag" inside the path `src/ag-tools` or "fd" inside
// `fd-cache/` as if the ag/fd BINARY were invoked there). `$(` is listed
// explicitly (not just whitespace) to keep this in sync with
// hasCommandSearch's RE_COMMAND_SEARCH, which already treats `$(` as a
// command start — without it, `result=$(grep ... )` would pass
// hasCommandSearch's gate but then extractPattern would return null,
// silently dropping all steering advice (guard-review finding, sc-1359
// follow-up round 6). Segments are already split on `;`/`&`/`|`/newline by
// splitUnquotedSegments, so whitespace/start/`$(` covers every real "start
// of a shell word" this needs within one segment (round 5: `find
// src/ag-tools -type f | xargs grep -l "..."` — the phantom "ag" match
// swallowed find's leftover `-type` value as a fake pattern and never
// reached the real `grep` invocation in the next pipeline segment).
const RE_GREP_SCOPE = /(?:^|\s|\$\()(grep|rg|ripgrep|ack|ag|fd)(?=\s|$)([\s\S]*)/;
const RE_FIND_SCOPE = /(?:^|\s|\$\()find(?=\s|$)([\s\S]*)/;
const RE_WHITESPACE = /\s+/;

// A bare `.`/`./`/`..`/`../` target is a cwd/parent-dir reference, not a
// real scoped path — searching it covers everything the configured roots
// would too, so its PRESENCE must keep an invocation in scope (see
// allTargetsMissEveryRoot, the only check this matters for — guard-review
// finding, sc-1359 follow-up round 9, refined in round 2 of the PR-review
// follow-up: this must be a per-element check inside a match predicate, not
// a pre-filter that strips cwd-refs out of a target array, which breaks a
// MIXED target list like `grep ... node_modules .`). A real relative
// sub-path like `./src` is unaffected — this only matches the BARE
// reference, nothing trailing it.
const RE_CWD_REF = /^\.\.?\/?$/;

// --- classify ---
const RE_HAS_WHITESPACE = /\s/;
const RE_PATH_PREFIX = /^[~/]/;
const RE_REL_PATH = /^\.\.?\//;
const RE_SLASH = /\//;
const RE_REGEX_META = /[\\^$|(){}[\]?+*]/;
const RE_SINGLE_IDENTIFIER = /^[\w.-]+$/;
const RE_LEADING_CAP = /^[A-Z]/;
const RE_QUOTECHAR = /['"`]/;
const RE_QUESTION_WORD = /^(where|how|what|which|who|why|when)\b/i;
const RE_DESCRIPTIVE = /^(function|code|logic|handler|component|hook)\s+(that|which|for|to)\b/i;
const RE_META_OR_PUNCT = /[\\^$|(){}[\]?+*=:]/;
const RE_QUOTE_OR_COLON = /['"`:]/;
const RE_PLAIN_WORD = /^[a-z]+$/;

// A verbatim code snippet (e.g. `export async function getFooBar`, copy-pasted
// to grep for) reads as multi-word natural language by word count alone but
// is a literal search: see looksLikeCodeSnippet for the exact contract
// (every word but the last must be one of these declaration modifiers).
const CODE_KEYWORDS = new Set([
  'export',
  'import',
  'async',
  'function',
  'const',
  'let',
  'var',
  'class',
  'interface',
  'type',
  'def',
  'return',
  'public',
  'private',
  'protected',
  'static',
  'struct',
  'fn',
  'impl',
  'enum',
  'namespace',
]);

// A pattern-classification verdict tier and its rationale (see classify()).
export type SearchVerdict = 'literal' | 'conceptual_medium' | 'conceptual_high';
export interface Classification {
  verdict: SearchVerdict;
  reason: string;
  wordCount?: number;
}

// Flags that consume a SEPARATE argv token as a DISCARDABLE value (not
// `=`-joined — tokenizeArgv already merges that form into one flag token;
// and NOT `-e`/`--regexp`, whose value IS a pattern, not discardable — see
// below). Covers both short (`-A`) and long (`--context`) spellings of the
// same flag, since a value can trail either one the same space-separated
// way (guard-review finding, sc-1359 follow-up round 2: the short-flag-only
// version left `--context 3 "pattern" src/` misreading '3' as the pattern).
// Not an exhaustive grep/fd flag parser — this stays an advisory heuristic,
// not a shell — just the common context/count/pattern-source flags that
// would otherwise leak their value into the pattern or the target list.
const RE_VALUE_FLAG =
  /^(-[ABCmfdD]|--(after-context|before-context|context|max-count|file|directories|devices))$/;
const RE_PATTERN_FLAG = /^(-e|--regexp)$/;

// Classify a grep-family invocation's argv tokens (everything after the bin
// name) into: values passed via `-e`/`--regexp` (each IS a pattern, never a
// target — grep's own contract once `-e` appears at all: with no `-e`,
// grep's FIRST bare positional is the pattern and the rest are targets, but
// with `-e` present every bare positional is a target instead, since the
// pattern is already fully specified) — and plain positional (non-flag,
// non-flag-value) tokens. Two lists, not one flat one, is what lets
// extractPattern and target detection agree on which token is "the
// pattern" without a second `-e` value being misread as a target (guard-
// review finding, sc-1359 follow-up round 7: `grep -e "the auth flow" -e
// "node_modules"` has NO target at all — both values are patterns — but a
// flat token list can't tell the second `-e` value apart from a real path).
//
// `bin` matters here: `fd`'s `-e`/`--extension` is a file-EXTENSION filter
// (its value is discardable, like -A/-B/-C), unlike grep-family's
// `-e`/`--regexp` (whose value IS the pattern) — the two bins spell
// unrelated flags the same way, so `fd -e ts "conceptual query" src/` must
// NOT read "ts" as the pattern (guard-review finding, sc-1359 follow-up
// round 10).
function classifyOperands(
  tokens: string[],
  bin: string,
): { patternValues: string[]; positionals: string[] } {
  const isFd = bin === 'fd';
  const isPatternFlag = (t: string) => !isFd && RE_PATTERN_FLAG.test(t);
  const isValueFlag = (t: string) => RE_VALUE_FLAG.test(t) || (isFd && RE_PATTERN_FLAG.test(t));
  const patternValues: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) {
      positionals.push(t);
      continue;
    }
    if (isPatternFlag(t)) {
      if (i + 1 < tokens.length) patternValues.push(tokens[++i]);
      continue;
    }
    if (isValueFlag(t)) i += 1; // discard this flag's value token
  }
  return { patternValues, positionals };
}

// For each segment that actually INVOKES a grep-family bin (not merely
// mentions one inside a quote — matchUnquoted skips any match that falls
// inside a quoted region, scoped to the segment): the pattern is the first
// `-e`/`--regexp` value if any were given, else the first bare positional —
// and the targets are every REMAINING bare positional (all of them, if `-e`
// supplied the pattern; everything after the first, otherwise). Segment-
// scanning (see splitUnquotedSegments) means a LATER command's argument
// across `&&`/`;`/`|`/newline is never folded into an EARLIER grep's
// tokens — the bug that let `grep foo src/ && echo "=== recheck ==="` read
// the echo's argument as the search pattern. Shared by extractPattern
// (wants the pattern) and the out-of-index helpers (want the targets), so
// the two can't drift on what counts as "this grep's own argv".
function grepInvocations(cmd: string): { pattern: string | null; targets: string[] }[] {
  const invocations: { pattern: string | null; targets: string[] }[] = [];
  for (const segment of splitUnquotedSegments(cmd)) {
    const match = matchUnquoted(segment, RE_GREP_SCOPE);
    if (!match) continue;
    const { patternValues, positionals } = classifyOperands(tokenizeArgv(match[2]), match[1]);
    // NOT filtering bare cwd-refs (`.`/`..`) out of targets here — see
    // allTargetsMissEveryRoot's doc comment for why a pre-filter is wrong
    // for a MIXED target list.
    invocations.push({
      pattern: patternValues.length ? patternValues[0] : (positionals[0] ?? null),
      targets: patternValues.length ? positionals : positionals.slice(1),
    });
  }
  return invocations;
}

/**
 * Extract the user-facing pattern from a grep-family invocation (see
 * grepInvocations for the `-e`/positional contract). A segment whose
 * invocation has no pattern at all (e.g. `rg --files`) does not match —
 * scanning continues into the next segment, so a real pattern later in the
 * pipeline (`rg --files | xargs grep "the auth flow"`) is still found.
 */
export function extractPattern(c: string): string | null {
  for (const inv of grepInvocations(c)) {
    if (inv.pattern !== null) return inv.pattern;
  }
  return null;
}

/**
 * Like extractPattern, but — for a compound command with more than one
 * grep-family invocation — skips any invocation whose OWN targets are
 * entirely inside `excludeRoots` OR entirely outside `scanRoots`, so its
 * pattern is never advised on merely because a LATER, unrelated invocation
 * elsewhere in the same command has an answerable target. This must stay a
 * PER-INVOCATION check, not a separate whole-command aggregate (isExcludedTarget
 * / isOutOfScanRoots) followed by a separate "first pattern" extraction — the
 * two can disagree on WHICH invocation they're each looking at (guard-review
 * finding, sc-1359 follow-up round 8: `grep "auth flow logic" node_modules &&
 * grep "y" src` used to advise on "auth flow logic" — the excluded
 * invocation's pattern — because isExcludedTarget and extractPattern picked
 * their answers from two different invocations). scanRoots scoping was added
 * later (PR review finding) once this per-invocation correlation existed to
 * carry it correctly — the whole-command isOutOfScanRoots was deliberately
 * NOT wired into the guard earlier because eval/eval.mts's synthetic `src/`
 * targets would have gone silently unscored whenever a consumer's scanRoots
 * don't include `src` (e.g. devkit's own `["cli","gate-engine"]`); eval.mts
 * now derives its target from the resolved scanRoots instead of hardcoding
 * `src/`, so that's no longer a blocker.
 */
export function firstAdvisablePattern(
  cmd: string,
  excludeRoots: string[],
  scanRoots: string[],
): string | null {
  for (const inv of grepInvocations(cmd)) {
    if (inv.pattern === null) continue;
    if (allTargetsMatchSomeRoot(inv.targets, excludeRoots)) continue;
    if (allTargetsMissEveryRoot(inv.targets, scanRoots)) continue;
    return inv.pattern;
  }
  return null;
}

// `find`'s argv is `[path...] [expression]` — its paths are the LEADING
// non-flag tokens, not "everything after token 0" (find has no pattern
// argument the way grep/fd do). Stopping at the first flag/test also keeps
// a flag's value (`-iname "*.ts"`) from being misread as a second target —
// isPrimarySearchCommand already counts `find` as a search (RE_PRIMARY_SEARCH),
// so target detection must recognize it too or the counter's out-of-index
// no-op never fires for it (guard-review finding, sc-1359 follow-up).
function findInvocationTargets(cmd: string): string[] {
  const targets: string[] = [];
  for (const segment of splitUnquotedSegments(cmd)) {
    const match = matchUnquoted(segment, RE_FIND_SCOPE);
    if (!match) continue;
    for (const t of tokenizeArgv(match[1])) {
      if (t.startsWith('-')) break;
      targets.push(t);
    }
  }
  return targets;
}

// Every non-pattern target across all grep/fd invocations (see
// grepInvocations), plus every leading path token across all find
// invocations — candidate targets. Deliberately NOT filtered by "contains a
// slash": a bare target with no subpath (`grep -rn "x" node_modules`, `find
// node_modules`) is a normal, common shape and must still be seen. Also NOT
// filtered by cwd-ref (see allTargetsMissEveryRoot's doc comment) — a bare
// `.`/`..` alongside another target must stay visible to that check.
function targetTokens(cmd: string): string[] {
  return [...grepInvocations(cmd).flatMap((inv) => inv.targets), ...findInvocationTargets(cmd)];
}

// Windows paths can appear literally in a bash command string on Windows
// (Claude Code runs bash there too — see normalize's "Windows-style quoted
// cwd" case) using `\` separators; normalize both sides to `/` so root
// matching doesn't silently no-op on that platform.
function toPosixSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function matchesRoot(token: string, root: string): boolean {
  let t = toPosixSlashes(token);
  if (t.startsWith('./')) t = t.slice(2);
  const rFull = toPosixSlashes(root);
  const r = rFull.endsWith('/') ? rFull.slice(0, -1) : rFull;
  // NOTE: no bare `t.startsWith(root)` prefix check here — that would also
  // match an unrelated SIBLING directory that merely shares root's string
  // prefix (e.g. root "src" matching token "src-legacy/x.ts", or root
  // "node_modules" matching "node_modules_shim/x.js"). Every check below is
  // boundary-safe: exact match, root-then-`/`, or root wrapped in `/`s.
  return t === r || t.startsWith(`${r}/`) || t.includes(`/${r}/`);
}

// Do ALL of `targets` match SOME root in `roots`? Empty targets => false (no
// operand means "searches cwd", never excluded/out-of-scope). Shared by
// isExcludedTarget (whole-command) and firstAdvisablePattern (per-invocation)
// so the two can't drift on what "excluded" means.
function allTargetsMatchSomeRoot(targets: string[], roots: string[]): boolean {
  return targets.length > 0 && targets.every((t) => roots.some((r) => matchesRoot(t, r)));
}

// Do ALL of `targets` fail to match EVERY root in `roots`? Empty roots =>
// false (conservative fallback — an unconfigured scanRoots never excludes
// anything, never "match-nothing"). Shared by isOutOfScanRoots (whole-
// command) and firstAdvisablePattern (per-invocation).
//
// A bare cwd-ref target (`.`/`./`/`..`/`../`) NEVER counts as "missing" —
// it means "search all of cwd", which by definition includes whatever the
// configured roots are, so its mere PRESENCE is enough to keep an
// invocation in scope even alongside another, genuinely out-of-scope
// target. This must be a per-element exception INSIDE the .every(), not a
// pre-filter that removes cwd-refs from the target array before this runs
// (PR review finding, sc-1359 follow-up round 2: an earlier version
// filtered cwd-refs out of grepInvocations'/targetTokens' target arrays
// directly — for a single bare `.` that correctly left an empty array
// (never excluded, via the `targets.length > 0` guard), but for a MIXED
// list like `grep ... node_modules .`, removing `.` left only
// `['node_modules']`, which then matched every remaining root and was
// wrongly classified as fully excluded — silently losing the exact signal
// the `.` was supposed to provide).
function allTargetsMissEveryRoot(targets: string[], roots: string[]): boolean {
  return (
    roots.length > 0 &&
    targets.length > 0 &&
    targets.every((t) => !RE_CWD_REF.test(t) && !roots.some((r) => matchesRoot(t, r)))
  );
}

/**
 * Is every target in `cmd` inside one of the ecosystem-universal excluded
 * roots (node_modules, .git, the OS temp dir — never a hardcoded stack
 * layout, see docs/decisions/synced-assets-layout-agnostic.md)? A bare
 * pattern with no target searches cwd and is never excluded; a multi-target
 * grep with at least one non-excluded target is not excluded either (any
 * in-scope target keeps the command worth advising on).
 */
export function isExcludedTarget(cmd: string, excludeRoots: string[]): boolean {
  return allTargetsMatchSomeRoot(targetTokens(cmd), excludeRoots);
}

/**
 * Is every target in `cmd` OUTSIDE all of the consumer's `scanRoots`?
 * Mirrors isExcludedTarget's "no operand / any-in-scope-wins" semantics,
 * scoped to the consumer's configured roots (resolveGuardConfig) instead of
 * the universal exclude list.
 */
export function isOutOfScanRoots(cmd: string, scanRoots: string[]): boolean {
  return allTargetsMissEveryRoot(targetTokens(cmd), scanRoots);
}

/**
 * A verbatim code snippet — one or more declaration-modifier keywords
 * (`export`, `async`, `function`, `const`, …) immediately followed by a
 * single identifier-shaped token (not a plain lowercase English word) AS
 * THE LAST WORD — reads as multi-word prose by shape alone but is a literal
 * search: `export async function getFooBar` is a source line, not a
 * description. Both halves of the contract matter, each closing a
 * guard-review-caught misclassification (sc-1359 follow-up):
 *  - the identifier must be LAST, not just present anywhere. Without this,
 *    a bug report that merely NAMES a symbol before describing it in
 *    English — "function getUser fails silently" / "class Foo needs
 *    refactoring" / "type UserResponse looks wrong" — has a keyword +
 *    identifier pair too, but ends in an English predicate
 *    (`silently`/`refactoring`/`wrong`), so it correctly stays conceptual.
 *  - EVERY word before the identifier must itself be a declaration
 *    modifier — not just "a keyword somewhere". Without this, a REQUEST
 *    about a symbol — "explain function getUserData" / "debug class
 *    UserService" / "review type ApiResponse" — has a keyword + identifier
 *    pair too, but leads with an action verb ("explain"/"debug"/"review")
 *    that isn't a modifier, so it correctly stays conceptual.
 * Queries with no keyword at all, e.g. "explain how sessionToken refresh
 * works" or "handles OAuth callback errors", never reach the modifier check.
 */
function looksLikeCodeSnippet(words: string[]): boolean {
  if (words.length < 2) return false;
  const last = words[words.length - 1];
  const lastIsIdentifier = RE_SINGLE_IDENTIFIER.test(last) && !RE_PLAIN_WORD.test(last);
  if (!lastIsIdentifier) return false;
  return words.slice(0, -1).every((w) => CODE_KEYWORDS.has(w));
}

/**
 * Classify a pattern as literal (grep is correct) or conceptual (steer toward
 * the semantic-search tool). Verdicts: literal | conceptual_medium | conceptual_high.
 */
// Reason: the branches ARE the literal-vs-conceptual classification algorithm: each guard is a distinct verdict tier (filesystem path, regex/glob, single identifier, error-message shape, question word, descriptive phrasing, code-snippet shape, 4-word/3-word/2-word thresholds) checked in priority order; extracting them hides the heuristic ladder
// fallow-ignore-next-line complexity
export function classify(pattern: string | null | undefined): Classification {
  const trimmed = (pattern ?? '').trim();
  if (!trimmed) return { verdict: 'literal', reason: 'empty' };

  // Filesystem path → literal. Catches an extracted cwd or a path arg.
  if (
    RE_PATH_PREFIX.test(trimmed) ||
    RE_REL_PATH.test(trimmed) ||
    (RE_SLASH.test(trimmed) && !RE_HAS_WHITESPACE.test(trimmed))
  ) {
    return { verdict: 'literal', reason: 'filesystem path' };
  }

  // Pure regex / glob → literal (metachars, no whitespace).
  if (RE_REGEX_META.test(trimmed) && !RE_HAS_WHITESPACE.test(trimmed)) {
    return { verdict: 'literal', reason: 'regex metacharacters, no whitespace' };
  }

  // Single identifier (snake_case, camelCase, kebab, dotted) → literal.
  if (RE_SINGLE_IDENTIFIER.test(trimmed) && !RE_HAS_WHITESPACE.test(trimmed)) {
    return { verdict: 'literal', reason: 'single identifier' };
  }

  const words = trimmed.split(RE_WHITESPACE).filter(Boolean);
  const wordCount = words.length;

  // Error-message shape (literal): capitalized + nested quote/apostrophe.
  if (RE_LEADING_CAP.test(trimmed) && RE_QUOTECHAR.test(trimmed)) {
    return { verdict: 'literal', reason: 'error message shape', wordCount };
  }

  // English question word → high confidence conceptual.
  if (RE_QUESTION_WORD.test(trimmed)) {
    return { verdict: 'conceptual_high', reason: 'English question word', wordCount };
  }

  // "function that ..." / "code that ..." → high.
  if (RE_DESCRIPTIVE.test(trimmed)) {
    return { verdict: 'conceptual_high', reason: 'descriptive phrasing', wordCount };
  }

  // Verbatim code snippet (keyword + identifier token + no connective) → literal.
  if (wordCount >= 3 && looksLikeCodeSnippet(words)) {
    return { verdict: 'literal', reason: 'code snippet shape', wordCount };
  }

  // 4+ words, no metachars → high.
  if (wordCount >= 4 && !RE_META_OR_PUNCT.test(trimmed)) {
    return { verdict: 'conceptual_high', reason: '4+ words, no metachars', wordCount };
  }

  // 3 words → medium (unless error-message shape). No metachar check here,
  // deliberately — ordinary English punctuation (a trailing `?`, a `:` after
  // an intro phrase) would trip `RE_META_OR_PUNCT` too and silently flip a
  // genuine conceptual query like "fix auth bug?" to literal (guard-review
  // finding, sc-1359 follow-up). The 4+-word branch's equivalent check
  // predates this file's rewrite and has the same limitation, but that's out
  // of scope here — extractPattern's segment scan already prevents the
  // original echo-bleed-through defect (sc-1359 #2) from ever handing
  // classify() a punctuation-laden string like `'=== recheck ==='` as if it
  // were a real pattern, so no metachar check is needed here as a backstop.
  if (wordCount === 3) {
    if (RE_LEADING_CAP.test(trimmed) && RE_QUOTE_OR_COLON.test(trimmed)) {
      return { verdict: 'literal', reason: 'error message shape', wordCount };
    }
    return { verdict: 'conceptual_medium', reason: '3 words', wordCount };
  }

  // 2 words: conceptual only if BOTH are plain lowercase English.
  if (wordCount === 2 && words.every((w) => RE_PLAIN_WORD.test(w) && w.length >= 3)) {
    return { verdict: 'conceptual_medium', reason: '2 plain English words', wordCount };
  }

  return { verdict: 'literal', reason: '<3 words or contains identifier-shaped token', wordCount };
}
