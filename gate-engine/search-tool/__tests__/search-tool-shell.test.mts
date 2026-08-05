import { describe, expect, it } from 'vitest';
import {
  hasCommandSearch,
  isPrimarySearchCommand,
  normalize,
  stripQuotes,
} from '../search-tool-shell.mts';

// Unit tests for the generic Bash-command-string parsing primitives shared
// by search-tool-lib.mts (split out once that file grew past the size
// ratchet — see search-tool-shell.mts's header). Pure string functions —
// provider-agnostic (Cursor vs Claude run the same Bash strings) so there
// are no provider-specific cases. The one OS-relevant case (Windows-style
// quoted cwd) lives under normalize.

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
