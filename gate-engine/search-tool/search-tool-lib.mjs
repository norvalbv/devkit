/**
 * Shared helpers for search-tool-guard (PreToolUse) and search-tool-counter
 * (PostToolUse), kept in one place so the two hooks can't drift on what counts
 * as a search. Counter uses normalize + isPrimarySearchCommand; guard uses all
 * four (normalize, extractPattern, classify, hasCommandSearch).
 *
 * Pure string classifiers — provider-agnostic (Cursor vs Claude run the same
 * Bash strings) and data-free, so this file ships as-is (no consumer coupling).
 *
 * Regexes are hoisted to module scope (devkit lint: useTopLevelRegex) — they are
 * the classifier's static grammar, reused on every hook invocation.
 */

// --- normalize ---
const RE_LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|(?:\\.|[^\s;&|])+)\s*(?:&&|;)\s*/g;
const RE_RTK_WRAPPER = /\brtk\s+(grep|rg|ripgrep|find|fd|ack|ag)\b/g;

// --- stripQuotes ---
const RE_DQUOTED = /"(?:\\.|[^"\\])*"/g;
const RE_SQUOTED = /'[^']*'/g;

// --- hasCommandSearch / isPrimarySearchCommand ---
const RE_COMMAND_SEARCH = /(^|[;&|]\s*|\$\(\s*|\bxargs\s+)(grep|rg|ripgrep|ack|ag|fd)\b/;
const RE_PRIMARY_SEARCH = /(^|[;&]\s*|\$\(\s*)(grep|rg|ripgrep|ack|ag|fd|find)\b/;

// --- extractPattern ---
const RE_GREP_SCOPE = /\b(grep|rg|ripgrep|ack|ag)\b([\s\S]*)/;
const RE_FIRST_DQUOTE = /"([^"\\]*(?:\\.[^"\\]*)*)"/;
const RE_FIRST_SQUOTE = /'([^']*)'/;
const RE_CMD_SEPARATOR = /[|;&]/;
const RE_WHITESPACE = /\s+/;

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

/**
 * Strip noise that is never part of the search query:
 *  - leading `cd <path> (&&|;)` segments (the working dir is not the query),
 *  - the `rtk` token-proxy wrapper (`rtk grep "x"` → `grep "x"`).
 */
export function normalize(c) {
  return c.replace(RE_LEADING_CD, '').replace(RE_RTK_WRAPPER, '$1');
}

/** Blank out quoted-string contents so a `grep` mentioned inside a commit
 * message / echo arg isn't mistaken for a grep invocation. */
export function stripQuotes(c) {
  return c.replace(RE_DQUOTED, '""').replace(RE_SQUOTED, "''");
}

/**
 * Guard: is a grep-family binary actually INVOKED as a command (start of a
 * pipeline segment, after a separator/`$(`, or via `xargs`) — not merely
 * mentioned inside a quoted arg like `git commit -m "...| grep..."`.
 */
export function hasCommandSearch(cmd) {
  return RE_COMMAND_SEARCH.test(stripQuotes(cmd));
}

/**
 * Counter: is the FIRST pipeline segment itself a search command? Distinguishes
 * a primary search (`grep x | head`) from a downstream output filter
 * (`tsc | grep x`, which is not code search).
 */
export function isPrimarySearchCommand(cmd) {
  const first = stripQuotes(cmd).split('|')[0];
  return RE_PRIMARY_SEARCH.test(first);
}

/**
 * Extract the user-facing pattern from a grep-family invocation. Scopes onto
 * the grep/rg segment (even after a pipe), then the first quoted string, else
 * the first non-flag token. Returns null when nothing pattern-like is found.
 */
export function extractPattern(c) {
  // Scope from the first grep-family bin to end-of-command. We do NOT truncate
  // at | ; & here because a quoted pattern may legitimately contain them
  // (e.g. `grep -E "auth|session"`). Scoping from the FIRST bin means the first
  // quoted string we find is that bin's own pattern, even across a pipe.
  const grepMatch = c.match(RE_GREP_SCOPE);
  const after = grepMatch ? grepMatch[2] : c;

  const dq = after.match(RE_FIRST_DQUOTE);
  if (dq) return dq[1];
  const sq = after.match(RE_FIRST_SQUOTE);
  if (sq) return sq[1];
  // Unquoted fallback: first non-flag token, stopping at a command separator so
  // we don't grab a downstream command's argument.
  const tokens = after.split(RE_CMD_SEPARATOR)[0].trim().split(RE_WHITESPACE);
  for (const t of tokens) {
    if (!t) continue;
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}

/**
 * Classify a pattern as literal (grep is correct) or conceptual (steer toward
 * the semantic-search tool). Verdicts: literal | conceptual_medium | conceptual_high.
 */
export function classify(pattern) {
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

  // 4+ words, no metachars → high.
  if (wordCount >= 4 && !RE_META_OR_PUNCT.test(trimmed)) {
    return { verdict: 'conceptual_high', reason: '4+ words, no metachars', wordCount };
  }

  // 3 words → medium (unless error-message shape).
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
