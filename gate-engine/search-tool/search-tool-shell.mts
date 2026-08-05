/**
 * Generic Bash-command-string parsing primitives shared by search-tool-lib.mts
 * (and, through it, search-tool-guard/search-tool-counter). Split out from
 * search-tool-lib.mts once that file grew past the size ratchet — this half
 * knows nothing about "search tool" classification semantics; it only knows
 * how to strip cwd noise, blank quoted content, detect a search-family bin
 * invocation, and tokenize a command string respecting shell quoting.
 *
 * Pure string functions — provider-agnostic (Cursor vs Claude run the same
 * Bash strings) and data-free, so this file ships as-is (no consumer
 * coupling).
 *
 * Regexes are hoisted to module scope (devkit lint: useTopLevelRegex) — they
 * are the parser's static grammar, reused on every hook invocation.
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

// --- splitUnquotedSegments ---
// Includes `\n`: a multi-line Bash tool_input (heredoc-style, or several
// commands joined by literal newlines rather than `&&`/`;`) is just as much
// a command boundary as any other separator — without it, a grep with no
// operand on one line could still read the NEXT line's command name as its
// pattern (the same defect class as the `&&`-echo case, just via `\n`).
const RE_SEGMENT_SEPARATOR = /[;&|\n]/;

// --- tokenizeArgv ---
const RE_WS_CHAR = /\s/;

/**
 * Strip noise that is never part of the search query:
 *  - leading `cd <path> (&&|;)` segments (the working dir is not the query),
 *  - the `rtk` token-proxy wrapper (`rtk grep "x"` → `grep "x"`).
 */
export function normalize(c: string): string {
  return c.replace(RE_LEADING_CD, '').replace(RE_RTK_WRAPPER, '$1');
}

/** Blank out quoted-string contents so a `grep` mentioned inside a commit
 * message / echo arg isn't mistaken for a grep invocation. */
export function stripQuotes(c: string): string {
  return c.replace(RE_DQUOTED, '""').replace(RE_SQUOTED, "''");
}

/**
 * Guard: is a grep-family binary actually INVOKED as a command (start of a
 * pipeline segment, after a separator/`$(`, or via `xargs`) — not merely
 * mentioned inside a quoted arg like `git commit -m "...| grep..."`.
 */
export function hasCommandSearch(cmd: string): boolean {
  return RE_COMMAND_SEARCH.test(stripQuotes(cmd));
}

/**
 * Counter: is the FIRST pipeline segment itself a search command? Distinguishes
 * a primary search (`grep x | head`) from a downstream output filter
 * (`tsc | grep x`, which is not code search).
 */
export function isPrimarySearchCommand(cmd: string): boolean {
  const first = stripQuotes(cmd).split('|')[0];
  return RE_PRIMARY_SEARCH.test(first);
}

/**
 * Split a command into segments at unquoted `;`, `&`, `|`, newline — quote
 * state is tracked char-by-char (mirroring stripQuotes' escape handling) so
 * a separator INSIDE a quoted pattern (e.g. `grep -E "auth|session"`) is
 * never mistaken for a command boundary. `&&`/`||` naturally produce a
 * harmless empty segment between the two chars — no grep-family bin matches
 * an empty string, so it's skipped downstream without special-casing.
 */
export function splitUnquotedSegments(c: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < c.length) {
        i += 1;
        cur += c[i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (RE_SEGMENT_SEPARATOR.test(ch)) {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

/**
 * Tokenize on unquoted whitespace, merging a quoted span into whatever token
 * it's adjacent to — so `--include="*.mts"` is ONE token (`--include=*.mts`,
 * a flag, correctly skipped) rather than exposing `*.mts` as if it were a
 * free-standing quoted pattern. Quote characters are stripped from the
 * token text; internal whitespace inside a quoted span is preserved.
 */
export function tokenizeArgv(s: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < s.length) {
        i += 1;
        cur += s[i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (RE_WS_CHAR.test(ch)) {
      if (inToken) {
        tokens.push(cur);
        cur = '';
        inToken = false;
      }
      continue;
    }
    cur += ch;
    inToken = true;
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

// Is `s[index]` inside a quoted region? Scans from the start, tracking quote
// state (mirroring stripQuotes'/tokenizeArgv's escape handling) up to (not
// including) `index`.
function isInsideQuotes(s: string, index: number): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < index; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < index) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
  }
  return quote !== null;
}

/**
 * Find the first UNQUOTED match of `re` in `segment` — i.e. skip any
 * candidate match whose start position falls inside a quoted region, so a
 * bin name merely MENTIONED inside a quote (e.g. `echo "use grep here"
 * $(grep ...)`) can never hijack the match ahead of a REAL invocation later
 * in the same segment. Operates directly on the ORIGINAL segment text
 * throughout — never reuses an index from stripQuotes' output, which isn't
 * length-preserving (guard-review finding, sc-1359 follow-up round 8: the
 * previous "gate via stripQuotes, extract via raw match" approach let an
 * earlier quoted mention's position win the match instead of the real one).
 *
 * On a rejected candidate, `lastIndex` is reset to just past that match's
 * START (not its end) before retrying: `re`'s trailing capture group is
 * greedy (`[\s\S]*`, matches to end-of-string), so a rejected match's FULL
 * span — and thus the auto-advanced `lastIndex` after a normal failed
 * .exec() retry — already covers the rest of the string, including any
 * real invocation after it. Re-scanning from just past the rejected
 * match's start is what lets that real invocation still be found.
 */
export function matchUnquoted(segment: string, re: RegExp): RegExpExecArray | null {
  const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null = globalRe.exec(segment);
  while (m !== null) {
    if (!isInsideQuotes(segment, m.index)) return m;
    globalRe.lastIndex = m.index + 1;
    m = globalRe.exec(segment);
  }
  return null;
}
