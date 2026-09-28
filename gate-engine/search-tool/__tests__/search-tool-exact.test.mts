import { describe, expect, it } from 'vitest';
import { isExactStringCommand, isExactStringSearch } from '../search-tool-exemption.mts';
import { advisablePatterns, classify, extractPattern } from '../search-tool-lib.mts';

// sc-3404: exact strings copied from log/gate output are grep jobs — literal to classify(),
// and exempt from the counter's streak via isExactStringSearch(). Split out for the size ratchet.

const SRC = ['src'];
const EXCLUDE = ['node_modules', '.git', '/tmp'];

describe('classify — exact log strings in the 3-word tier (sc-3404)', () => {
  it('the story patterns are literal', () => {
    // tokenizeArgv drops the `\` of a double-quoted `\(`, so classify sees the bare `(`.
    const escaped = extractPattern(String.raw`grep -rlE "judge unavailable \(" dist`);
    expect(escaped).toBe('judge unavailable (');
    expect(classify(escaped).verdict).toBe('literal');
    expect(classify('NONE are additions').verdict).toBe('literal');
    expect(classify('export function judgeCliFor').verdict).toBe('literal');
  });

  it('single-quoted `\\(` keeps its backslash and is still literal', () => {
    const p = extractPattern(String.raw`grep -rn 'judge unavailable \(' src/`);
    expect(classify(p).verdict).toBe('literal');
  });

  it('code punctuation of every kind flips a 3-word pattern to literal', () => {
    for (const p of [
      'call foo(bar) now',
      'items [0] missing',
      'a | b',
      'x + y',
      'wait {ms} here',
    ]) {
      expect(classify(p).verdict, p).toBe('literal');
    }
  });

  it('English punctuation (? : =) alone does NOT flip a 3-word query', () => {
    expect(classify('fix auth bug?').verdict).toBe('conceptual_medium');
    expect(classify('note: check auth').verdict).toBe('conceptual_medium');
    expect(classify('retry = backoff').verdict).toBe('conceptual_medium');
  });

  it('a log sentinel matches case-sensitively and through trailing punctuation', () => {
    expect(classify('NONE, skipping all').verdict).toBe('literal');
    expect(classify('WARN retry exhausted').verdict).toBe('literal');
    // Lowercase is plain English, not a sentinel.
    expect(classify('none are additions').verdict).toBe('conceptual_medium');
  });

  it('a constant-shaped token (with `_`) flips a 3-word query; plain acronyms do not', () => {
    expect(classify('MAX_RETRY exceeded here').verdict).toBe('literal');
    for (const p of [
      'API rate limiting',
      'JWT token refresh',
      'README install steps',
      'HTTP2 server config',
    ]) {
      expect(classify(p).verdict, p).toBe('conceptual_medium');
    }
  });
});

describe('isExactStringSearch — what the counter exempts (sc-3404)', () => {
  it('exact log strings are exempt', () => {
    for (const p of [
      'judge unavailable (',
      'NONE are additions',
      "Cannot read property 'foo' of undefined",
      'judge unavailable for model (',
      'NONE found',
      'MAX_RETRY exceeded',
      'Error: timeout',
      'ERROR TIMEOUT',
      'WARN ERROR',
      'MAX_RETRY EXCEEDED',
    ]) {
      expect(isExactStringSearch(p), p).toBe(true);
    }
  });

  it('identifier enumeration is NOT exempt — bare or wrapped in a code snippet', () => {
    for (const p of [
      'validateUser',
      'MAX_RETRY_COUNT',
      'NONE',
      'function getUser',
      'export function judgeCliFor',
    ]) {
      expect(isExactStringSearch(p), p).toBe(false);
    }
  });

  it('conceptual queries are never exempt, including ones classify() mislabels literal', () => {
    for (const p of [
      'auth flow handler',
      'fix auth bug?',
      'API rate limiting',
      // Pre-existing 4+-word fallback: literal via `?`, but not an exact string.
      'fix the auth bug?',
      // Leading-cap + apostrophe reads as "error shape" to classify(); a question is still a concept hunt.
      "Where's the auth handler",
      "How's the session refreshed",
    ]) {
      expect(isExactStringSearch(p), p).toBe(false);
    }
  });

  it('code snippets with punctuation or constants are NOT exempt (ship review finding)', () => {
    for (const p of [
      'function getUser()',
      'export function getUser()',
      'const MAX_RETRY',
      'getUser(id, opts)',
      'foo(a, b)',
      'return NONE;',
      'function: getUser() failed',
      'pub fn getUser()',
      'error in function getUser()',
      'trait User {',
      'module Foo {',
      'impl Display for User {',
      // A leading bracket must not hide a question word.
      '(where is auth)',
      'EXPORT FUNCTION FOO()',
      'Trait User {',
    ]) {
      expect(isExactStringSearch(p), p).toBe(false);
    }
  });

  it('null / empty (find, fd --files) is not exempt', () => {
    expect(isExactStringSearch(null)).toBe(false);
    expect(isExactStringSearch('')).toBe(false);
  });
});

describe('advisablePatterns — every in-scope invocation, not just the first (sc-3404)', () => {
  it('returns each in-scope pattern of a compound command in order', () => {
    expect(
      advisablePatterns(
        'grep "NONE are additions" src && grep "auth flow handler" src',
        EXCLUDE,
        SRC,
      ),
    ).toEqual(['NONE are additions', 'auth flow handler']);
  });

  it('returns EVERY -e pattern of one invocation (ship review finding)', () => {
    expect(
      advisablePatterns('grep -e "NONE are additions" -e "auth flow handler" src', EXCLUDE, SRC),
    ).toEqual(['NONE are additions', 'auth flow handler']);
  });

  it('drops excluded and out-of-scanRoots invocations', () => {
    expect(
      advisablePatterns(
        'grep "a b c" node_modules/x && grep "d e f" docs && grep "g h i" src',
        EXCLUDE,
        SRC,
      ),
    ).toEqual(['g h i']);
  });
});

describe('pattern-flag spellings and compound commands (ship review findings)', () => {
  it('reads attached, long= and clustered -e forms as the pattern', () => {
    for (const cmd of [
      'grep -e"NONE are additions" src',
      'grep --regexp="NONE are additions" src',
      'grep -rne "NONE are additions" src',
    ]) {
      expect(advisablePatterns(cmd, EXCLUDE, SRC), cmd).toEqual(['NONE are additions']);
    }
    // fd's -e is an extension filter, attached or not.
    expect(extractPattern('fd -ets "auth flow handler" src')).toBe('auth flow handler');
  });

  it('a command is exact only when every search in it is an exact-string grep', () => {
    expect(isExactStringCommand('grep -rn "NONE are additions" src', EXCLUDE, SRC)).toBe(true);
    for (const cmd of [
      String.raw`grep -rlE "judge unavailable \(" src`,
      'rg -n -i "NONE are additions" src',
      'grep -C 3 --line-number "NONE are additions" src',
      'grep -rne "NONE are additions" src',
      'rg --smart-case "NONE are additions" src',
      'grep -rn "NONE are additions" src | head -5',
      'grep -rn "NONE are additions" src 2>&1 | head -5',
      'grep -rn "NONE are additions" src &> /dev/null',
      // Redirections are neither separators nor targets.
      'grep -rn "NONE are additions" 2>&1',
      'grep -rn "NONE are additions" src 2>/dev/null',
      'grep -rn "NONE are additions" src > /tmp/out.txt',
      'grep -rn "NONE a > b are (x)" src',
      // Single-quoted substitution is inert text.
      "grep -rn 'NONE are $(x) additions' src",
      // "find" inside the grep pattern is text, not a command.
      'grep -rn "failed to find NONE (x)" src',
    ]) {
      expect(isExactStringCommand(cmd, EXCLUDE, SRC), cmd).toBe(true);
    }
    // An attached -e value containing an `f` is a pattern, not a -f pattern file.
    expect(isExactStringCommand('grep -e"failed: NONE found" src', EXCLUDE, SRC)).toBe(true);
    // Every segment must be a grep-family command or an output filter: wrappers and spellings are unbounded.
    for (const tail of [
      'xargs find .',
      'sudo find src',
      'env find src',
      'command find src',
      '/usr/bin/find src',
      'echo $(find src -name "*.ts")',
      'echo "$(find src)"',
      'echo `find src`',
      'fd x docs',
      'echo find',
      String.raw`f\ind src`,
      "$'find' src",
      "echo 'run find'",
    ]) {
      const cmd = `grep -rn "NONE are additions" src && ${tail}`;
      expect(isExactStringCommand(cmd, EXCLUDE, SRC), cmd).toBe(false);
    }
    // fd searches file names, not content: never exempt.
    expect(isExactStringCommand('fd "NONE are additions" src', EXCLUDE, SRC)).toBe(false);
    for (const cmd of [
      'grep -rn "NONE are additions" src && find src -name "*.ts"',
      'grep -rn "NONE are additions" src && rg --files src',
      'grep -rn "NONE are additions" src && grep -rn "auth flow handler" src',
      'find src -name "*.ts"',
      'grep -e "NONE found" -f /tmp/patterns src',
      'grep -rn "NONE are additions" $(git ls-files)',
      // An apostrophe inside double quotes does not open a single-quoted span.
      `grep "WARN can't $(find src) isn't done" src`,
      'grep -rn "NONE are additions" src <(find src)',
      'grep -rn "NONE are additions" src > >(tee /tmp/x)',
      'grep --smart-case "NONE are additions" src',
      'grep -e "NONE found" --file=/tmp/patterns src',
      'grep -e "NONE found" -rf /tmp/patterns src',
      // An unrecognised flag may take a value or switch modes: the argv is not trusted.
      'rg --files "NONE found" src',
      'grep -r --exclude "NONE are additions" "auth flow" src',
      'rg -t ts "NONE are additions" src',
      'rg -r "x" "NONE are additions" src',
    ]) {
      expect(isExactStringCommand(cmd, EXCLUDE, SRC), cmd).toBe(false);
    }
  });
});
