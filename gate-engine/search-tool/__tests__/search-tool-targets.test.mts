import { describe, expect, it } from 'vitest';
import { firstAdvisablePattern, isExcludedTarget, isOutOfScanRoots } from '../search-tool-lib.mts';

// Unit tests for search-tool-lib.mts's out-of-index TARGET detection
// (isExcludedTarget / isOutOfScanRoots / firstAdvisablePattern) — split out
// from search-tool-lib.test.mts (which covers extractPattern / classify)
// once that file grew past the size ratchet. Pure string classifiers —
// provider-agnostic (Cursor vs Claude run the same Bash strings) so there
// are no provider-specific cases. The one OS-relevant case (Windows
// backslash paths) lives in its own describe block below.

describe('isExcludedTarget — target outside the ecosystem-universal exclude roots (sc-1359 #3)', () => {
  const EXCLUDE_ROOTS = ['node_modules', '.git', '/tmp'];

  it('true for a node_modules target', () => {
    expect(isExcludedTarget('grep -rn "TODO" node_modules/foo/lib.js', EXCLUDE_ROOTS)).toBe(true);
  });

  it('true for a /tmp target', () => {
    expect(isExcludedTarget('grep -oE "FAIL +[^ ]+" /tmp/out.log', EXCLUDE_ROOTS)).toBe(true);
  });

  it('FALSE when there is no explicit path operand (bare grep searches cwd)', () => {
    expect(isExcludedTarget('grep -rn "the auth flow"', EXCLUDE_ROOTS)).toBe(false);
  });

  it('FALSE for a multi-target grep with at least one non-excluded target', () => {
    expect(isExcludedTarget('grep -rn "the auth flow" src/ node_modules/', EXCLUDE_ROOTS)).toBe(
      false,
    );
  });

  it('FALSE for an ordinary source target', () => {
    expect(isExcludedTarget('grep -rn "the auth flow" src/', EXCLUDE_ROOTS)).toBe(false);
  });

  it('FALSE for a bare "." or ".." target — same as no operand (guard-review finding, round 9)', () => {
    expect(isExcludedTarget('grep -rn "the auth flow" .', EXCLUDE_ROOTS)).toBe(false);
    expect(isExcludedTarget('grep -rn "the auth flow" ..', EXCLUDE_ROOTS)).toBe(false);
  });

  it('FALSE for a MIXED excluded-root + bare "." target — the "." keeps it in scope (PR review finding, round 2)', () => {
    // grep also searches "." (all of cwd, including real source) alongside node_modules — the
    // presence of "." must not be silently dropped before the "every target excluded" check runs.
    expect(isExcludedTarget('grep -rn "the auth flow" node_modules .', EXCLUDE_ROOTS)).toBe(false);
  });
});

describe("isOutOfScanRoots — target outside the consumer's configured scanRoots", () => {
  const SCAN_ROOTS = ['cli', 'gate-engine'];

  it('FALSE when the target is inside a configured scanRoot', () => {
    expect(isOutOfScanRoots('grep -rn "the auth flow" gate-engine/', SCAN_ROOTS)).toBe(false);
  });

  it('true when the target is outside every configured scanRoot', () => {
    expect(isOutOfScanRoots('grep -rn "the auth flow" docs/', SCAN_ROOTS)).toBe(true);
  });

  it('FALSE when there is no explicit path operand', () => {
    expect(isOutOfScanRoots('grep -rn "the auth flow"', SCAN_ROOTS)).toBe(false);
  });

  it('FALSE when scanRoots is empty (never match-nothing)', () => {
    expect(isOutOfScanRoots('grep -rn "the auth flow" docs/', [])).toBe(false);
  });

  it('FALSE for a bare "." or ".." target — same as no operand (guard-review finding, round 9)', () => {
    // `grep -r "x" .` is an extremely common shape (search cwd). Without this, the counter's
    // out-of-scan-roots no-op fires on it whenever the consumer's scanRoots don't happen to
    // literally include "." — silently defeating streak counting for the most common invocation.
    expect(isOutOfScanRoots('grep -rn "the auth flow" .', SCAN_ROOTS)).toBe(false);
    expect(isOutOfScanRoots('grep -rn "the auth flow" ..', SCAN_ROOTS)).toBe(false);
  });

  it('FALSE for a MIXED out-of-scanRoots + bare "." target — the "." keeps it in scope (PR review finding, round 2)', () => {
    expect(isOutOfScanRoots('grep -rn "the auth flow" docs .', SCAN_ROOTS)).toBe(false);
  });
});

describe('root matching — boundary safety (prefix, not substring)', () => {
  it('a sibling dir that merely shares a string PREFIX with an exclude root is NOT excluded', () => {
    // node_modules_shim/ is a real, distinct directory — must not be swallowed by "node_modules".
    expect(
      isExcludedTarget('grep -rn "x" node_modules_shim/foo.js', ['node_modules', '.git', '/tmp']),
    ).toBe(false);
  });

  it('a sibling dir that merely shares a string PREFIX with a scanRoot is NOT treated as in-scope', () => {
    // src-legacy/ is a real, distinct directory from the configured "src" scanRoot.
    expect(isOutOfScanRoots('grep -rn "x" src-legacy/foo.ts', ['src'])).toBe(true);
  });

  it('an exact-match token (no subpath) still matches its root', () => {
    expect(isExcludedTarget('grep -rn "x" node_modules', ['node_modules'])).toBe(true);
    expect(isOutOfScanRoots('grep -rn "x" src', ['src'])).toBe(false);
  });

  it("a space-separated value flag's value is never misread as a target (guard-review finding)", () => {
    // -A's value ("3") and the real pattern ("cli") must not leak into the target list — only
    // the actual trailing path (node_modules/foo.js) is a target, so this must be excluded.
    // Regression-critical: "cli" happens to be a real scanRoot in this repo's own guard.config.json,
    // so a wrongly-collected "cli" target would silently defeat the any-in-scope-wins exclusion.
    expect(isExcludedTarget('grep -A 3 cli node_modules/foo.js', ['node_modules'])).toBe(true);
  });

  it('a SECOND -e pattern value is never misread as a target (guard-review finding, round 7)', () => {
    // `grep -e P1 -e P2` (multi-pattern OR search) has no file/dir operand at all — every value
    // after -e is a PATTERN, not a target, however many -e flags are used. Without an explicit
    // target, this must never be excluded (matches "no operand searches cwd" semantics).
    expect(isExcludedTarget('grep -e "the auth flow" -e "node_modules"', ['node_modules'])).toBe(
      false,
    );
  });

  it("an unrelated command's argument earlier in a compound command is NOT read as a grep target", () => {
    // A non-leading `cd` to an in-scope dir must not "pollute" a later, unrelated grep's own
    // out-of-scope target via any-in-scope-wins — targets are scoped per grep invocation, not
    // pulled from the whole command string.
    expect(isExcludedTarget('cd apps/web && grep -rn "x" node_modules/foo', ['node_modules'])).toBe(
      true,
    );
  });
});

describe('firstAdvisablePattern — exclusion and pattern-extraction stay correlated (guard-review finding, round 8)', () => {
  const EXCLUDE_ROOTS = ['node_modules', '.git', '/tmp'];

  it("does NOT advise on an excluded invocation's pattern just because a LATER invocation has an in-scope target", () => {
    // isExcludedTarget aggregates across every invocation (any-in-scope-wins, correct for the
    // counter's "is there real search activity" question) — but the GUARD attributes a specific
    // pattern to advise on, and that pattern must come from the SAME invocation whose target was
    // checked. Without this, `grep "auth flow logic" node_modules && grep "y" src` would advise
    // on "auth flow logic" (the node_modules-excluded invocation's pattern) merely because the
    // unrelated second invocation's target ("src") isn't excluded.
    expect(
      firstAdvisablePattern(
        'grep -rn "auth flow logic" node_modules && grep -rn "y" src',
        EXCLUDE_ROOTS,
        [],
      ),
    ).toBe('y');
  });

  it('skips a single excluded invocation entirely, same as isExcludedTarget', () => {
    expect(
      firstAdvisablePattern('grep -rn "auth flow" node_modules/foo', EXCLUDE_ROOTS, []),
    ).toBeNull();
  });

  it('returns the pattern unchanged when nothing is excluded', () => {
    expect(firstAdvisablePattern('grep -rn "auth flow" src/', EXCLUDE_ROOTS, [])).toBe('auth flow');
  });

  it('skips an invocation whose target is outside the configured scanRoots, not just EXCLUDE_ROOTS (PR review finding)', () => {
    // firstAdvisablePattern previously only checked the universal EXCLUDE_ROOTS
    // (node_modules/.git/tmp) — the consumer's configured scanRoots must be checked too, per
    // invocation, for the SAME reason: a compound command's advice must come from an invocation
    // whose own target is actually answerable by the semantic-search tool.
    expect(firstAdvisablePattern('grep -rn "auth flow" docs/', EXCLUDE_ROOTS, ['src'])).toBeNull();
  });

  it('in a compound command, skips the out-of-scanRoots invocation and selects the in-scope one', () => {
    expect(
      firstAdvisablePattern(
        'grep -rn "auth flow logic" docs/ && grep -rn "the retry backoff path" src/',
        EXCLUDE_ROOTS,
        ['src'],
      ),
    ).toBe('the retry backoff path');
  });

  it('scanRoots empty (unconfigured) never excludes anything — conservative fallback', () => {
    expect(firstAdvisablePattern('grep -rn "auth flow" docs/', EXCLUDE_ROOTS, [])).toBe(
      'auth flow',
    );
  });

  it('a MIXED excluded-root + bare "." target stays advisable — the "." keeps it in scope (PR review finding, round 2)', () => {
    // grep also searches "." (all of cwd, including real source) alongside node_modules — a
    // pre-filter that strips "." before the exclusion check runs would misclassify this as fully
    // excluded and silence a genuinely conceptual query.
    expect(
      firstAdvisablePattern(
        'grep -rn "how does the auth flow work" node_modules .',
        EXCLUDE_ROOTS,
        [],
      ),
    ).toBe('how does the auth flow work');
  });

  it('a MIXED out-of-scanRoots + bare "." target stays advisable (PR review finding, round 2)', () => {
    expect(
      firstAdvisablePattern('grep -rn "how does the auth flow work" docs .', EXCLUDE_ROOTS, [
        'cli',
        'gate-engine',
      ]),
    ).toBe('how does the auth flow work');
  });
});

describe('Windows-style backslash paths (sc-1359 follow-up — OS coverage)', () => {
  it('a backslash-separated node_modules target is excluded, same as forward-slash', () => {
    expect(
      isExcludedTarget('grep -rn "x" C:\\project\\node_modules\\foo.js', [
        'node_modules',
        '.git',
        '/tmp',
      ]),
    ).toBe(true);
  });

  it('a backslash-separated scanRoot target is recognized as in-scope', () => {
    expect(
      isOutOfScanRoots('grep -rn "x" C:\\project\\gate-engine\\lib.mts', ['gate-engine']),
    ).toBe(false);
  });

  it('an absolute Windows temp-dir root (backslash, no trailing slash) excludes its own subpaths', () => {
    expect(
      isExcludedTarget('grep -rn "x" C:\\Users\\dev\\AppData\\Local\\Temp\\out.log', [
        'node_modules',
        'C:\\Users\\dev\\AppData\\Local\\Temp',
      ]),
    ).toBe(true);
  });
});

describe('find / fd target detection (guard-review finding — isPrimarySearchCommand also treats these as searches)', () => {
  const EXCLUDE_ROOTS = ['node_modules', '.git', '/tmp'];

  it('a `find` invocation into an excluded root is recognized (path comes before any flag)', () => {
    expect(isExcludedTarget('find node_modules -iname "*.spec.ts"', EXCLUDE_ROOTS)).toBe(true);
  });

  it('a flag VALUE in a `find` expression is never mistaken for a second target', () => {
    // -iname's value ("*.spec.ts") must not count as a non-excluded target that saves the command
    // via any-in-scope-wins — only the leading path run (before the first flag) is a target.
    expect(isExcludedTarget('find node_modules -iname "*.ts" -type f', EXCLUDE_ROOTS)).toBe(true);
  });

  it('a `find .` (cwd) is NOT excluded', () => {
    expect(isExcludedTarget('find . -iname "*.spec.ts"', EXCLUDE_ROOTS)).toBe(false);
  });

  it('an `fd` invocation (PATTERN [PATH...] convention, like grep) into an excluded root is recognized', () => {
    expect(isExcludedTarget('fd "\\.spec\\.ts$" node_modules', EXCLUDE_ROOTS)).toBe(true);
  });

  it('an `fd` invocation with an in-scope path is NOT excluded', () => {
    expect(isExcludedTarget('fd "\\.spec\\.ts$" src/', EXCLUDE_ROOTS)).toBe(false);
  });
});
