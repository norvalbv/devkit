import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComment } from '../lib/doctor/hook-gate-scan.mts';
import { shippedRootDirFiles, shippedTreeFiles } from '../../scripts/shipped-assets.mjs';

// dist carries the compiled .mjs, a source checkout the .mts, so a .sh naming one alone ENOENTs in
// the other tree — #547's bounded_remote_git, which blocked every consumer ship. See the decision.

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const SHELL_EXT = /\.sh$/;
// A word ending in .mts is a path the shell resolves. Prose naming one sits inside a quoted string
// with other words, so the word carries whitespace an expansion cannot explain.
const MTS_SUFFIX_RE = /\.mts$/;
const MODULE_SUFFIX_RE = /\.(mts|mjs)$/;
const TRAILING_OPERATORS_RE = /[;)&|]+$/;
const QUOTE_RE = /["']/g;
const EXPANSION_RE = /\$\([^)]*\)|\$\{[^}]*\}/g;
const WHITESPACE_RE = /\s/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Finding = { line: number; ref: string; missing: string };

// The twin must be the SAME path with the other extension, within reach of the call site: a
// basename or whole-file match calls a site resolved on an unrelated mention of another module.
const RESOLUTION_WINDOW = 3;

/** One shell word per unquoted-whitespace-delimited token, quotes kept. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\') {
      word += char + (line[i + 1] ?? '');
      i += 1;
    } else if (quote) {
      word += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      word += char;
    } else if (WHITESPACE_RE.test(char)) {
      if (word) words.push(word);
      word = '';
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

/** The module path a word names, or null when the word is not one path ending at .mts or .mjs. */
function modulePath(word: string): string | null {
  const bare = word
    .replace(QUOTE_RE, '')
    .replace(TRAILING_OPERATORS_RE, '')
    .replace(ASSIGNMENT_RE, '');
  if (!MODULE_SUFFIX_RE.test(bare)) return null;
  return WHITESPACE_RE.test(bare.replace(EXPANSION_RE, '$')) ? null : bare;
}

/** Every .mts path a script resolves whose identical .mjs path is not beside the call site. */
function unresolvedMtsRefs(source: string): Finding[] {
  const perLine = source
    .split('\n')
    .map((line) => shellWords(stripComment(line)).flatMap((word) => modulePath(word) ?? []));
  const findings: Finding[] = [];
  perLine.forEach((refs, index) => {
    for (const ref of refs.filter((path) => MTS_SUFFIX_RE.test(path))) {
      const missing = ref.replace(MTS_SUFFIX_RE, '.mjs');
      const window = perLine.slice(
        Math.max(0, index - RESOLUTION_WINDOW),
        index + RESOLUTION_WINDOW + 1,
      );
      if (!window.some((near) => near.includes(missing)))
        findings.push({ line: index + 1, ref, missing });
    }
  });
  return findings;
}

const shippedShellScripts = () => [
  ...shippedTreeFiles(ROOT, SHELL_EXT),
  ...shippedRootDirFiles(ROOT, SHELL_EXT),
];

describe('shipped shell scripts resolve both module extensions', () => {
  it('names a .mjs sibling for every .mts path it runs', () => {
    const offenders = shippedShellScripts().flatMap((rel) =>
      unresolvedMtsRefs(readFileSync(join(ROOT, rel), 'utf8')).map(
        (f) => `${rel}:${f.line} runs ${f.ref} with no ${f.missing} beside it`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('scans a non-empty set', () => {
    expect(shippedShellScripts().length).toBeGreaterThan(20);
  });

  it('flags the sc-2352 shape, so a passing scan is not a vacuous one', () => {
    const preFix =
      'bounded_remote_git() {\n  node "$SCRIPT_DIR/review/process/gate-supervisor.mts" 60 -- git "$@"\n}\n';
    expect(unresolvedMtsRefs(preFix)).toEqual([
      {
        line: 2,
        ref: '$SCRIPT_DIR/review/process/gate-supervisor.mts',
        missing: '$SCRIPT_DIR/review/process/gate-supervisor.mjs',
      },
    ]);
  });

  it('accepts the fallback idiom the fixed call sites use', () => {
    const fixed =
      'sup="$D/gate-supervisor.mts"\n[ -f "$sup" ] || sup="$D/gate-supervisor.mjs"\nnode "$sup"\n';
    expect(unresolvedMtsRefs(fixed)).toEqual([]);
  });

  it('is not satisfied by a same-basename mention elsewhere in the file', () => {
    const decoy =
      '# a/foo.mjs is resolved over in the other helper\nBAR="$D/foo.mts"\nnode "$BAR"\n';
    expect(unresolvedMtsRefs(decoy)).toEqual([
      { line: 2, ref: '$D/foo.mts', missing: '$D/foo.mjs' },
    ]);
  });

  it('is not satisfied by a trailing comment naming the .mjs path', () => {
    const commented = 'node "$D/foo.mts" # $D/foo.mjs is resolved below\n';
    expect(unresolvedMtsRefs(commented)).toEqual([
      { line: 1, ref: '$D/foo.mts', missing: '$D/foo.mjs' },
    ]);
  });

  it('reads a # inside quotes as code, not as a comment', () => {
    const quotedHash = 'node "$D/a.mts" "#tag"\n[ -f x ] || node "$D/a.mjs"\n';
    expect(unresolvedMtsRefs(quotedHash)).toEqual([]);
  });

  it('reads path-shaped prose inside a longer string as prose', () => {
    const prose = 'echo "See docs/gate-supervisor.mts for setup"\n';
    expect(unresolvedMtsRefs(prose)).toEqual([]);
  });

  it('flags an unquoted call site with no fallback', () => {
    const bare = 'node $D/foo.mts 60 -- git "$@"\n';
    expect(unresolvedMtsRefs(bare)).toEqual([
      { line: 1, ref: '$D/foo.mts', missing: '$D/foo.mjs' },
    ]);
  });

  it('accepts an unquoted call site whose twin is beside it', () => {
    const bare = 'sup=$D/foo.mts\n[ -f $sup ] || sup=$D/foo.mjs\nnode $sup\n';
    expect(unresolvedMtsRefs(bare)).toEqual([]);
  });

  it('flags a call site behind a $ {var#pattern} expansion on the same line', () => {
    const expansion = 'echo "${x#pre}" && node $D/foo.mts\n';
    expect(unresolvedMtsRefs(expansion)).toEqual([
      { line: 1, ref: '$D/foo.mts', missing: '$D/foo.mjs' },
    ]);
  });

  it('reads quote-terminal prose as prose', () => {
    const prose = 'echo "See docs/gate-supervisor.mts"\n';
    expect(unresolvedMtsRefs(prose)).toEqual([]);
  });

  it('resolves a path built through a command substitution', () => {
    const built =
      'sup="$(dirname "$0")/review/gate-supervisor.mts"\n[ -f "$sup" ] || sup="$(dirname "$0")/review/gate-supervisor.mjs"\n';
    expect(unresolvedMtsRefs(built)).toEqual([]);
  });

  it('flags a bare same-directory call site', () => {
    const sameDir = 'node gate-supervisor.mts 60\n';
    expect(unresolvedMtsRefs(sameDir)).toEqual([
      { line: 1, ref: 'gate-supervisor.mts', missing: 'gate-supervisor.mjs' },
    ]);
  });

  it('is not satisfied by the .mjs named inside nearby prose', () => {
    const nearbyProse = 'echo "note: consider $D/foo.mjs as an alternative"\nnode "$D/foo.mts"\n';
    expect(unresolvedMtsRefs(nearbyProse)).toEqual([
      { line: 2, ref: '$D/foo.mts', missing: '$D/foo.mjs' },
    ]);
  });

  it('is not satisfied by the twin of a different module on the same line', () => {
    const wrongTwin = 'node "$D/a.mts" --with "$D/b.mjs"\n';
    expect(unresolvedMtsRefs(wrongTwin)).toEqual([
      { line: 1, ref: '$D/a.mts', missing: '$D/a.mjs' },
    ]);
  });
});
