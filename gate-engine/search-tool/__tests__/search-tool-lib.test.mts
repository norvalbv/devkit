import { describe, expect, it } from 'vitest';
import { classify, extractPattern } from '../search-tool-lib.mts';

// Unit tests for search-tool-lib.mts's PATTERN classification (extractPattern
// + classify). Generic Bash-string parsing (normalize, stripQuotes,
// hasCommandSearch, isPrimarySearchCommand) has its own coverage in
// search-tool-shell.test.mts, and out-of-index TARGET detection
// (isExcludedTarget / isOutOfScanRoots / firstAdvisablePattern) has its own
// in search-tool-targets.test.mts — both split out once this file grew past
// the size ratchet. These are pure string classifiers — provider-agnostic
// (Cursor vs Claude run the same Bash strings) so there are no
// provider-specific cases.

// A generic working dir WITH SPACES — spaces in the cwd were the original
// false-positive trigger (a path split into "3 words"). Kept provider/OS-neutral.
const CWD = '/Users/dev/My Projects/cool app';

describe('extractPattern', () => {
  it('returns the double-quoted pattern', () => {
    expect(extractPattern('grep -rn "auth flow" src/')).toBe('auth flow');
  });

  it('returns the single-quoted pattern', () => {
    expect(extractPattern("grep -rn 'auth flow' src/")).toBe('auth flow');
  });

  it('falls back to first non-flag token when unquoted', () => {
    expect(extractPattern('grep -rn validateUser src/')).toBe('validateUser');
  });

  it('scopes onto the grep after a pipe (find ... | xargs grep "x")', () => {
    expect(extractPattern('find src -name "*.ts" | xargs grep "auth flow"')).toBe('auth flow');
  });

  it('returns the full quoted pattern even when it contains a pipe (grep -E "a|b")', () => {
    // Quotes legitimately contain | ; & — scope must not truncate at them.
    expect(extractPattern('grep -E "auth|session" src/')).toBe('auth|session');
  });

  it('returns the first grep pattern across a pipe, not the second', () => {
    expect(extractPattern('grep "first" src/ | grep "second"')).toBe('first');
  });

  it('returns null when there is no pattern', () => {
    expect(extractPattern('grep')).toBeNull();
  });

  it('does NOT bleed a downstream echo argument into an unquoted grep pattern (sc-1359 #2)', () => {
    expect(
      extractPattern('grep -rln getFlowDriveInfoForSubChat src/ && echo "=== recheck ==="'),
    ).toBe('getFlowDriveInfoForSubChat');
  });

  it('does NOT bleed a downstream command across `;` either', () => {
    expect(extractPattern('grep -rn x src/ ; grep -rn "the retry backoff path" src/')).toBe('x');
  });

  it('falls through to the next segment when an earlier grep-family bin has no operand', () => {
    expect(extractPattern('rg --files | xargs grep "the auth flow here"')).toBe(
      'the auth flow here',
    );
  });

  it('a bin name appearing as a SUBSTRING of an earlier path token is not a phantom invocation (guard-review finding, round 5)', () => {
    // "ag" inside "src/ag-tools" is not the `ag` binary — it's part of an unrelated directory
    // name in an earlier `find` segment. A phantom match there must not swallow the REAL grep
    // invocation in the next pipeline segment.
    expect(
      extractPattern('find src/ag-tools -type f | xargs grep -l "the authentication flow works"'),
    ).toBe('the authentication flow works');
  });

  it('a bin invoked via unspaced $(...) command substitution is still recognized (guard-review finding, round 6)', () => {
    // The whitespace-or-start requirement that fixed the "ag-tools" phantom match (round 5) must
    // not also break `$(grep ...)` — hasCommandSearch (a separate regex) already recognizes this
    // shape, so extractPattern silently going null here would desync the guard's gate from its
    // own extraction.
    expect(extractPattern('result=$(grep -r "how does auth work" src/)')).toBe(
      'how does auth work',
    );
  });

  it('does not read a flag VALUE as the pattern (sc-1359, pre-existing FN)', () => {
    expect(extractPattern('grep --include="*.mts" -rn "auth flow here" src/')).toBe(
      'auth flow here',
    );
  });

  it("does not read a SPACE-separated value flag's value as the pattern (guard-review finding)", () => {
    // -A/-B/-C/-m take their value as a SEPARATE argv token (not `=`-joined) — that value token
    // must never be misread as the pattern, and the real pattern must not then be misread as a
    // target.
    expect(extractPattern('grep -A 3 cli node_modules/foo.js')).toBe('cli');
    expect(extractPattern('grep -m 5 "the auth flow" src/')).toBe('the auth flow');
  });

  it("does not read a LONG-FORM space-separated value flag's value as the pattern (guard-review finding, round 5)", () => {
    // --context/--after-context/--before-context/--max-count are the long-form spellings of
    // -C/-A/-B/-m — same space-separated-value shape, must be skipped the same way.
    expect(extractPattern('grep --context 3 "how does auth work" src/')).toBe('how does auth work');
    expect(extractPattern('grep --max-count 5 "the auth flow" src/')).toBe('the auth flow');
  });

  it("-e's value IS the pattern, not a discardable flag value (guard-review finding, round 2)", () => {
    // Unlike -A/-B/-C/-m, `-e`'s argument is the search pattern itself (grep's own
    // "specify pattern via flag" form) — it must be treated as the pattern, not skipped.
    expect(extractPattern('grep -e "unified employee onboarding flow" src/payments.ts')).toBe(
      'unified employee onboarding flow',
    );
  });

  it('a -e conceptual query is still flagged end-to-end, not misread as a filesystem path', () => {
    // Regression-critical: mistakenly discarding -e's value made extractPattern fall through to
    // the trailing path token, which classify() then reads as a literal filesystem path — a
    // conceptual query silently vanishing behind the WRONG-but-still-a-verdict "literal" branch.
    const pattern = extractPattern('grep -e "unified employee onboarding flow" src/payments.ts');
    expect(classify(pattern).verdict).toBe('conceptual_high');
  });

  it("fd's -e/--extension (file-extension filter) is NOT grep's -e pattern flag (guard-review finding, round 10)", () => {
    // fd spells its extension filter the same as grep spells "specify pattern via flag" — the
    // two bins disagree on what -e MEANS, so which treatment applies must depend on the bin.
    expect(extractPattern('fd -e ts "the authentication flow logic" src/')).toBe(
      'the authentication flow logic',
    );
  });
});

describe('classify — literal cases (grep is correct)', () => {
  it('empty / null patterns are literal (public contract)', () => {
    expect(classify('')).toEqual({ verdict: 'literal', reason: 'empty' });
    expect(classify(null).verdict).toBe('literal');
    expect(classify(undefined).verdict).toBe('literal');
  });

  it('absolute / home / relative / slashed paths are literal', () => {
    for (const p of [CWD, '/etc/hosts', '~/x.ts', './a/b', '../a/b', 'src/main/index.ts']) {
      expect(classify(p).verdict, p).toBe('literal');
    }
  });

  it('regex / glob with no whitespace is literal', () => {
    for (const p of ['a|b|c', '\\bfoo\\b', '.*Error$', 'foo.*bar']) {
      expect(classify(p).verdict, p).toBe('literal');
    }
  });

  it('single identifier (camel / snake / kebab / dotted) is literal', () => {
    for (const p of ['validateUser', 'check_mcp', 'use-foo-hook', 'foo.bar', 'MAX_RETRY_COUNT']) {
      expect(classify(p).verdict, p).toBe('literal');
    }
  });

  it('error-message shape is literal', () => {
    expect(classify("Cannot read property 'foo'").verdict).toBe('literal');
    expect(classify('TypeError: x is not a function').verdict).toBe('literal');
  });

  it('2 words with an identifier-shaped token is literal', () => {
    expect(classify('useFooHook bar').verdict).toBe('literal');
    expect(classify('foo.bar baz').verdict).toBe('literal');
  });

  it('a verbatim code snippet (keyword + identifier, no connective) is literal (sc-1359 #1)', () => {
    expect(classify('export async function getFlowDriveInfoForSubChat').verdict).toBe('literal');
  });

  it('a natural 3-word query ending in ?/:/= stays conceptual (guard-review finding, round 4)', () => {
    // An earlier fix added a metachar check to the 3-word branch as defense-in-depth for the
    // echo-bleed-through defect (sc-1359 #5) — but that check fires on ordinary English
    // punctuation too, silently flipping queries like this to literal. Reverted: extractPattern's
    // segment scan already prevents '=== recheck ===' from ever reaching classify() as a "pattern"
    // in the first place (see the extractPattern "does NOT bleed a downstream echo argument" test),
    // so the defense-in-depth was never load-bearing and isn't worth this regression.
    expect(classify('fix auth bug?').verdict).toBe('conceptual_medium');
    expect(classify('note: check auth').verdict).toBe('conceptual_medium');
  });
});

describe('classify — conceptual cases (steer to searchCode)', () => {
  it('English question word → high', () => {
    expect(classify('where is permission handled').verdict).toBe('conceptual_high');
  });

  it('descriptive "function that ..." → high', () => {
    expect(classify('function that formats relative time').verdict).toBe('conceptual_high');
  });

  it('4+ plain words → high', () => {
    expect(classify('permission prompt rendering logic').verdict).toBe('conceptual_high');
  });

  it('3 plain words → medium', () => {
    expect(classify('auth flow handler').verdict).toBe('conceptual_medium');
  });

  it('2 plain English words → medium', () => {
    expect(classify('auth flow').verdict).toBe('conceptual_medium');
  });

  it('3 words in error-message shape (capital + colon/quote) stay literal', () => {
    expect(classify('Error: not found').verdict).toBe('literal');
    expect(classify("Missing key 'id'").verdict).toBe('literal');
  });

  it('the code-snippet escape hatch does NOT swallow real conceptual queries (sc-1359 regression guard)', () => {
    // Mirrors eval gr-04 — non-lowercase words (Client/Server) alone must not defeat conceptual.
    expect(classify('relationship between Client and Server').verdict).toBe('conceptual_high');
    // Leads with a non-anchored word ("explain"), so the question-word check misses it; must not
    // fall through to a false "literal" just because it contains a camelCase token.
    expect(classify('explain how sessionToken refresh works').verdict).toBe('conceptual_high');
    // A domain acronym (OAuth) in otherwise-plain English must not read as a code keyword.
    expect(classify('handles OAuth callback errors').verdict).toBe('conceptual_high');
  });

  it('a bug report naming a symbol (keyword + identifier NOT last) stays conceptual (guard-review finding)', () => {
    // "function getUser" alone would be a snippet — but a trailing English predicate describing
    // the symbol ("fails silently", "needs refactoring", "looks wrong") makes these bug reports,
    // not verbatim source lines. The identifier must be the LAST word for the snippet escape to fire.
    expect(classify('function getUser fails silently').verdict).toBe('conceptual_high');
    expect(classify('class Foo needs refactoring').verdict).toBe('conceptual_high');
    expect(classify('type UserResponse looks wrong').verdict).toBe('conceptual_high');
  });

  it('a REQUEST about a symbol (leading verb is not a code keyword) stays conceptual (guard-review finding)', () => {
    // The keyword+identifier pair alone isn't enough — every word before the identifier must
    // itself be a declaration modifier. "explain"/"debug"/"review" are action verbs, not that,
    // so these are requests ABOUT a symbol, not a copy-pasted declaration line.
    expect(classify('explain function getUserData').verdict).toBe('conceptual_medium');
    expect(classify('debug class UserService').verdict).toBe('conceptual_medium');
    expect(classify('review type ApiResponse').verdict).toBe('conceptual_medium');
  });
});

describe('extractPattern — multi-line compound commands (sc-1359 follow-up)', () => {
  it("does NOT bleed a NEXT LINE's command into an earlier operand-bearing grep", () => {
    expect(
      extractPattern('grep -rln getFlowDriveInfoForSubChat src/\necho "=== recheck ==="'),
    ).toBe('getFlowDriveInfoForSubChat');
  });

  it('falls through past a newline-separated operand-less grep to find the real pattern', () => {
    // Mirrors the existing `rg --files | xargs grep "..."` fall-through case, but for a
    // heredoc-style multi-line Bash tool_input instead of a `|` pipeline.
    expect(extractPattern('rg --files\ngrep "the auth flow here" src/')).toBe('the auth flow here');
  });

  it("does NOT read the next line's bare command name as the pattern", () => {
    // A grep with only flags (no operand) on its own line, followed by an unrelated command on
    // the next line: the unrelated command's NAME must never be returned as "the pattern".
    expect(extractPattern('grep --files-with-matches\ncat package.json')).toBeNull();
  });
});

describe('extractPattern / splitUnquotedSegments — crash safety on malformed shell quoting', () => {
  it('an unterminated double quote does not throw and returns a graceful result', () => {
    // The unclosed quote runs to end-of-string, so the whole remainder becomes one token —
    // not ideal, but deterministic and never a crash.
    expect(() => extractPattern('grep -rn "unterminated src/')).not.toThrow();
    expect(extractPattern('grep -rn "unterminated src/')).toBe('unterminated src/');
  });

  it('an unterminated single quote does not throw and returns a graceful result (same fallback as double)', () => {
    expect(() => extractPattern("grep -rn 'unterminated src/")).not.toThrow();
    expect(extractPattern("grep -rn 'unterminated src/")).toBe('unterminated src/');
  });

  it('an escaped quote WITHIN the pattern itself is preserved, not treated as a terminator', () => {
    expect(extractPattern('grep -rn "she said \\"hi\\"" src/')).toBe('she said "hi"');
  });

  it('adjacent quoted/unquoted runs with no whitespace merge into one token', () => {
    // Real bash semantics: `foo"bar"baz` is ONE word, `foobarbaz` — not just the quoted middle.
    expect(extractPattern('grep -rn foo"bar"baz src/')).toBe('foobarbaz');
  });

  it('a quoted MENTION of a bin name earlier in the segment does not hijack a REAL $(...) invocation later in it (guard-review finding, round 8)', () => {
    // "grep" inside the quoted "use grep here" must never be matched as an invocation — only the
    // real `$(grep ...)` later in the same (unsplit — no `;`/`&`/`|` between them) segment is.
    expect(extractPattern('echo "use grep here" $(grep -r "how does auth work" src/)')).toBe(
      'how does auth work',
    );
  });
});
