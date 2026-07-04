import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// sc-1042: the Stop-hook loop guards used `grep -q '…\s*true'`. `\s` is a GNU-grep extension,
// not guaranteed by POSIX; a strict POSIX/BSD grep can read it as a literal `s`, so the guard
// never matches and the hook re-runs on its own re-invoked stop. Fix was the POSIX class
// `[[:space:]]` (works on every grep). (Note: modern macOS ships a GNU-compatible BSD grep that
// does accept `\s` — this is a portability + in-file-consistency hardening, not env-specific.)
//
// This guards the `\s`/`\d`/`\w` regex-escape CLASS across every agent-hook, on ANY platform —
// a functional pipe test would pass on GNU-grep CI even with the bug present, since GNU accepts
// `\s`. It is NOT a full grep-portability proof: other GNU-only BRE extensions (\+ \? \| \< \>)
// are not covered (none are used today). Widen the regex below if that ever changes.

const HOOKS_DIR = fileURLToPath(new URL('../../agents-hooks/', import.meta.url));

describe('agent-hook grep patterns avoid GNU-only \\s\\d\\w escapes (sc-1042)', () => {
  const shFiles = readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.sh'));

  it('has hook scripts to check', () => {
    expect(shFiles.length).toBeGreaterThan(0);
  });

  it.each(shFiles)('%s uses no \\s/\\d/\\w regex escape', (file) => {
    const src = readFileSync(
      new URL(file, new URL('../../agents-hooks/', import.meta.url)),
      'utf8',
    );
    const offenders = src
      .split('\n')
      .map((line, i) => ({ n: i + 1, line }))
      .filter(({ line }) => /\\[sdw]/.test(line));
    expect(
      offenders,
      `use [[:space:]]/[0-9]/[[:alnum:]_] (BSD grep has no \\s\\d\\w): ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
