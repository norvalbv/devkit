// The counter's exact-string exemption (sc-3404), kept out of search-tool-lib.mts for its size
// ceiling. Decision: docs/decisions/search-counter-exempts-exact-strings.md.

import { looksLikeCopiedOutput } from './search-tool-exact.mts';
import { classify, inScopeInvocations } from './search-tool-lib.mts';
import { splitUnquotedSegments, tokenizeArgv } from './search-tool-shell.mts';

const RE_HAS_WHITESPACE = /\s/;
// A quoted span (kept) or an unquoted redirection (`2>&1`, `2>/dev/null`, `> out`, `&>f`, `< in`),
// which is neither a separator nor a grep target.
const RE_QUOTED_OR_REDIRECT =
  /("(?:\\.|[^"\\])*"|'[^']*')|(?:\d*|&)(?:>>?|<)(?:&\d*|\s*[^\s|;&<>()]+)?/g;
const stripRedirects = (cmd: string): string =>
  cmd.replace(RE_QUOTED_OR_REDIRECT, (m, quoted?: string) => quoted ?? ' ');

// Is there a `$(`, `<(`, `>(` or backtick bash would expand — outside single quotes (double quotes expand)?
function hasSubstitution(cmd: string): boolean {
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (c === '\\') i += 1;
    else if (c === '`' || ('$<>'.includes(c) && cmd[i + 1] === '(')) return true;
    else if (c === '"') quote = quote ? '' : '"';
    else if (c === "'" && !quote) quote = "'";
  }
  return false;
}

// Segment heads allowed in an exempt command: content searches and plain output filters. Anything else
// (find, fd, echo, sudo, `f\ind`, `$'find'`) counts — wrappers and spellings are unbounded.
const SEGMENT_HEADS = new Set([
  'grep',
  'rg',
  'ripgrep',
  'ack',
  'ag',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
]);

const onlyContentSearches = (cmd: string): boolean =>
  splitUnquotedSegments(cmd).every((segment) => {
    const head = tokenizeArgv(segment.trim())[0];
    return head === undefined || SEGMENT_HEADS.has(head);
  });

// Per bin: no-value short flags and long flags that keep a plain content search (rg's -r/-E/-t take values).
const GREP_LONG =
  'recursive|line-number|ignore-case|files-with-matches|word-regexp|line-regexp|fixed-strings|count|only-matching|no-messages|quiet|with-filename|no-filename|color|colour|invert-match';
const RG_LONG = `${GREP_LONG}|no-heading|heading|smart-case|case-sensitive|hidden|no-ignore`;
const ACK_LONG = 'ignore-case|word-regexp|count|invert-match|color|colour';
const SAFE_FLAGS = new Map([
  [
    'grep',
    {
      short: 'rRnilwHhcoqsLvxFEPZz',
      long: new RegExp(`^--(${GREP_LONG}|extended-regexp)(=\\S*)?$`),
    },
  ],
  ['rg', { short: 'nilwHhcoqsSLvxFPUuz', long: new RegExp(`^--(${RG_LONG})(=\\S*)?$`) }],
  ['ripgrep', { short: 'nilwHhcoqsSLvxFPUuz', long: new RegExp(`^--(${RG_LONG})(=\\S*)?$`) }],
  ['ack', { short: 'ilnwvcoHhLQs', long: new RegExp(`^--(${ACK_LONG})(=\\S*)?$`) }],
  ['ag', { short: 'ilnwvcoHhLQs', long: new RegExp(`^--(${ACK_LONG})(=\\S*)?$`) }],
]);
// Context/count flags: their value (joined or next token) was already discarded by the parser.
const RE_SAFE_VALUE_FLAG =
  /^(-[ABCm]\d*|--(after-context|before-context|context|max-count)(=\d+)?)$/;
const RE_SHORT_CLUSTER = /^-([a-zA-Z]+)$/;

// Is every flag one the parser fully understands for this bin? Anything else (--files, --exclude, -f,
// -t, grep --smart-case) may take a value or switch modes, so the argv — and the exemption — is not trusted.
function flagsUnderstood(bin: string, flags: string[]): boolean {
  const safe = SAFE_FLAGS.get(bin);
  if (!safe) return false;
  return flags.every((f) => {
    if (safe.long.test(f) || RE_SAFE_VALUE_FLAG.test(f)) return true;
    const cluster = f.match(RE_SHORT_CLUSTER);
    return cluster !== null && [...cluster[1]].every((c) => safe.short.includes(c));
  });
}

// A multi-word literal copied from output (a log line, an error): the counter
// exempts it from the streak. See looksLikeCopiedOutput for which shapes.
export function isExactStringSearch(pattern: string | null | undefined): boolean {
  const t = (pattern ?? '').trim();
  return RE_HAS_WHITESPACE.test(t) && classify(t).verdict === 'literal' && looksLikeCopiedOutput(t);
}

// Only content searches and filters (onlyContentSearches), and every in-scope grep carries only exact strings — a pattern-less
// `rg --files`, an unrecognised flag or a chained concept grep keeps the command counted.
export function isExactStringCommand(
  cmd: string,
  excludeRoots: string[],
  scanRoots: string[],
): boolean {
  if (hasSubstitution(cmd)) return false;
  const plain = stripRedirects(cmd);
  if (!onlyContentSearches(plain)) return false;
  const invocations = inScopeInvocations(plain, excludeRoots, scanRoots);
  return (
    invocations.length > 0 &&
    invocations.every(
      (inv) =>
        flagsUnderstood(inv.bin, inv.flags) &&
        inv.patterns.length > 0 &&
        inv.patterns.every(isExactStringSearch),
    )
  );
}
