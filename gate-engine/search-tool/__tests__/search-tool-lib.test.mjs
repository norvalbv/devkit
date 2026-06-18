import { describe, expect, it } from 'vitest';
import {
  classify,
  extractPattern,
  hasCommandSearch,
  isPrimarySearchCommand,
  normalize,
  stripQuotes,
} from '../search-tool-lib.mjs';

// Unit tests for the search-tool hook library (used by search-tool-guard +
// search-tool-counter). These are pure string classifiers — provider-agnostic
// (Cursor vs Claude run the same Bash strings) so there are no provider-specific
// cases. The one OS-relevant case (Windows-style quoted cwd) lives under normalize.

// A generic working dir WITH SPACES — spaces in the cwd were the original
// false-positive trigger (a path split into "3 words"). Kept provider/OS-neutral.
const CWD = '/Users/dev/My Projects/cool app';

describe('normalize — strip cwd + unwrap rtk', () => {
  it('strips a leading quoted `cd <path> &&` (cwd with spaces was the #1 false positive)', () => {
    expect(normalize(`cd "${CWD}" && grep -n "x" f.ts`)).toBe('grep -n "x" f.ts');
  });

  it('strips a backslash-escaped-space unquoted cwd', () => {
    expect(normalize('cd /a/My\\ Projects/app && grep -rn "x" src/')).toBe('grep -rn "x" src/');
  });

  it('strips a single-quoted cwd', () => {
    expect(normalize(`cd '${CWD}' ; rg "x"`)).toBe('rg "x"');
  });

  it('strips a Windows-style quoted cwd (Claude Code uses bash on Windows)', () => {
    expect(normalize('cd "C:\\proj dir" && grep -n "x" f')).toBe('grep -n "x" f');
  });

  it('unwraps the rtk token proxy so the underlying bin is classified', () => {
    expect(normalize('rtk grep -n "x" f')).toBe('grep -n "x" f');
    expect(normalize('rtk rg "x"')).toBe('rg "x"');
  });

  it('strips cwd AND unwraps rtk together', () => {
    expect(normalize(`cd "${CWD}" && rtk grep -rn "x" src/`)).toBe('grep -rn "x" src/');
  });

  it('leaves a non-cd command untouched', () => {
    expect(normalize('grep -rn "x" src/')).toBe('grep -rn "x" src/');
  });

  it('does not strip a non-leading cd', () => {
    // Only a leading `cd ... &&` is cwd noise; a mid-command cd is intentional.
    expect(normalize('echo hi && cd /tmp && grep "x"')).toBe('echo hi && cd /tmp && grep "x"');
  });
});

describe('stripQuotes', () => {
  it('blanks double-quoted content including escaped quotes', () => {
    expect(stripQuotes('git commit -m "fix: a | grep thing \\"q\\""')).toBe('git commit -m ""');
  });

  it('blanks single-quoted content', () => {
    expect(stripQuotes("echo 'use grep here'")).toBe("echo ''");
  });

  it('leaves unquoted text intact', () => {
    expect(stripQuotes('grep -rn foo src/')).toBe('grep -rn foo src/');
  });
});

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
});

describe('hasCommandSearch — bin invoked as a command, not mentioned in a quote', () => {
  it('true for a direct grep / rg / fd invocation', () => {
    expect(hasCommandSearch('grep "x" src/')).toBe(true);
    expect(hasCommandSearch('rg "x"')).toBe(true);
    expect(hasCommandSearch('fd "x"')).toBe(true);
  });

  it('true for grep after a pipe or via xargs', () => {
    expect(hasCommandSearch('tsc | grep "x"')).toBe(true);
    expect(hasCommandSearch('find . -name "*.ts" | xargs grep "x"')).toBe(true);
  });

  it('FALSE when grep is only inside a quoted arg (commit message / echo)', () => {
    expect(hasCommandSearch('git commit -m "fix search-tool-counter | grep false positives"')).toBe(
      false,
    );
    expect(hasCommandSearch('echo "use grep here"')).toBe(false);
  });

  it('FALSE for git --grep flag (not a grep command)', () => {
    expect(hasCommandSearch('git log --grep="auth flow"')).toBe(false);
  });
});

describe('isPrimarySearchCommand — first pipeline segment is the search', () => {
  it('true when grep/find is the primary command', () => {
    expect(isPrimarySearchCommand('grep "x" src/ | head')).toBe(true);
    expect(isPrimarySearchCommand('find . -name "x"')).toBe(true);
  });

  it('FALSE for a downstream output filter (tsc | grep, vitest | grep)', () => {
    expect(isPrimarySearchCommand('tsc --noEmit | grep -E "FAIL"')).toBe(false);
    expect(isPrimarySearchCommand('bun vitest run x 2>&1 | grep error')).toBe(false);
  });

  it('FALSE when grep is only inside a quoted arg', () => {
    expect(isPrimarySearchCommand('git commit -m "... | grep ..."')).toBe(false);
  });
});
