/**
 * Shell-shape scanning shared by the two hook checks: stray-gate-calls.mts (a gate invoked twice
 * per commit) and unguarded-gate-calls.mts (a gate whose fail-open exit cannot survive `sh -e`).
 *
 * Both need to know which text on a hook line is CODE — a bin name inside a remedy string or after
 * a `#` is a mention, not an invocation — so the quote walker lives here rather than in either
 * caller. Everything else stays with its own check: the two have opposite tolerance for ambiguity
 * (see unguarded-gate-calls.mts) and sharing the decision logic would force one bias on both.
 *
 * This is deliberately NOT a shell parser. It handles the constructs that appear in real husky
 * hooks — quotes, comments, line continuations, `;` separators — and each check declares what it
 * cannot see.
 */

const WHITESPACE = /\s/;
/** An ODD number of trailing backslashes continues the line; `foo \\` ends in a literal one. */
const TRAILING_BACKSLASHES = /(\\+)$/;

/**
 * Does this physical line continue onto the next? Comment-stripped first: a `\` at the end of a
 * COMMENT continues nothing — the next line is a fresh command — and joining them lets the later
 * stripComment() delete a real statement, which is a false clean.
 */
function continuesLine(line: string): boolean {
  const m = TRAILING_BACKSLASHES.exec(stripComment(line));
  return m ? m[1].length % 2 === 1 : false;
}

/**
 * Is the position after `before` inside a quoted string, or past an inline `#` comment? Walks the
 * prefix tracking shell quote state. Ambiguity resolves toward "quoted", i.e. toward NOT treating
 * the text as code.
 */
export function isQuotedOrCommented(before: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#') return true;
  }
  return quote !== null;
}

/** The line with any unquoted `#` comment removed. Quote state is per-line, as above. */
export function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    // Only a `#` that STARTS a word opens a comment: `foo#bar` and `${x#y}` are not comments.
    if (c === '#' && (i === 0 || WHITESPACE.test(line[i - 1] ?? ''))) return line.slice(0, i);
  }
  return line;
}

/** One logical line: continuations joined, with the 1-based physical line it started on. */
export interface LogicalLine {
  text: string;
  line: number;
}

/**
 * Join `\`-continued physical lines into one logical line. A hook that sets an env var on one line
 * and runs the command on the next (`VAR=x \` / `  node gate.mjs`) is a single command, and a
 * line-at-a-time reader sees only its tail — which is how two real hazards went unreported.
 */
export function logicalLines(text: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  const raw = text.split('\n');
  let buf: string | null = null;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] ?? '';
    const continued = continuesLine(line);
    const body = continued ? line.slice(0, -1) : line;
    if (buf === null) {
      buf = body;
      start = i + 1;
    } else {
      buf += ` ${body.trim()}`;
    }
    if (!continued) {
      out.push({ text: buf, line: start });
      buf = null;
    }
  }
  if (buf !== null) out.push({ text: buf, line: start });
  return out;
}

/**
 * The LAST element of a top-level AND-OR list — the one whose exit status becomes the list's, and
 * therefore the only one `set -e` can see.
 *
 * Detecting `||` and calling the whole statement guarded is wrong, and was a review finding here:
 * under `-e` only the LEFT operand is exempt, so `some_check || node gate.mjs --gate` still aborts
 * when the gate fails. Splitting and judging the tail gets `cmd || rc=$?` (safe — the tail is an
 * assignment) and `cmd || gate` (hazard) both right with one rule.
 *
 * Quote- and substitution-aware: `grep -E 'a||b' file` contains no operator at all, and reading one
 * there would drop a statement that really does abort.
 */
export function lastAndOrSegment(stmt: string): string {
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i] ?? '';
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (stmt.startsWith('||', i) || stmt.startsWith('&&', i))) {
      i++;
      start = i + 1;
    }
  }
  return stmt.slice(start).trim();
}

/**
 * Split a statement into shell words on unquoted whitespace. Needed to tell `VAR=x` (an assignment,
 * which cannot fail) from `VAR=x cmd` (an assignment PREFIX on a command, which can) — a
 * distinction a regex on the whole statement gets wrong, and one that appears in real hooks as
 * `MATCHER_CHANGED_FILES="$(…)" \` followed by the command on the next line.
 */
export function words(stmt: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let cur = '';
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i] ?? '';
    if (c === '\\') {
      cur += c + (stmt[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && WHITESPACE.test(c)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split a logical line into statements on unquoted `;`, keeping `;;` (a case-branch terminator)
 * as its own boundary. `cmd; rc=$?` on one line is the same hazard as the two-line form, so a
 * reader that only looks at whole lines can be silenced by a single reflow.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let depth = 0; // $( ) and ( ) nesting — a `;` inside a substitution is not a separator here
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '\\') {
      cur += c + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) {
      if (text[i + 1] === ';') i++; // `;;`
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/* Shipped-script dependency scanning: ship/dist-integrity.mts reads `source` / `bash` targets out
 * of the .sh devkit publishes. Resolving one to a dist path stays with that caller (sc-2522). */
import {
  isJsonInteger,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
  parseJson,
} from '../../../gate-engine/comment-firewall/types.mts';

/** An assignment whose value is provably the script's OWN directory, in either shipped spelling. */
const SCRIPT_DIR_VALUE =
  /^\$\(cd "\$\(dirname "(?:\$\{BASH_SOURCE\[0\]\}|\$0)"\)"(?: 2>\/dev\/null)? && pwd(?: -P)?\)$/;
/** Continuations joined, whitespace squeezed: a joined `\` or a CRLF `\r` is not part of an idiom. */
const normalise = (text: string): string =>
  text
    .replace(/\\\s*\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** One outer quote pair off a `bash -c` argument, EITHER kind: there they delimit a script. */
function unquoteScript(argument: string): string {
  const quote = argument.startsWith('"') ? '"' : argument.startsWith("'") ? "'" : '';
  const wrapped = quote !== '' && argument.length > 1 && argument.endsWith(quote);
  return wrapped ? argument.slice(1, -1) : argument;
}

/** Re-enters the parser for an inline `bash -c` script; `undefined` there is a hole, as ever. */
type InlineParser = (text: string) => ShellScan | undefined;
export interface ShellScan {
  /** EVERY assignment, trusted or not: a later `DIR=/tmp` has to invalidate an earlier one. */
  assignments: { name: string; at: number; trusted: boolean }[];
  operands: { text: string; at: number }[];
}

/** The names whose NEAREST PRECEDING assignment proves them the script's own directory. */
/** Every name this script assigns at all: one of them is never an inherited external root. */
export function assignedNames(scan: ShellScan): Set<string> {
  return new Set(scan.assignments.map((a) => a.name));
}

export function ownDirVars(scan: ShellScan, before: number): Set<string> {
  if (scan.assignments.some((a) => a.name === ANY_NAME && a.at < before)) return new Set();
  const nearest = new Map<string, { at: number; trusted: boolean }>();
  for (const a of scan.assignments) {
    const seen = nearest.get(a.name);
    if (a.at < before && (seen === undefined || a.at > seen.at)) nearest.set(a.name, a);
  }
  return new Set([...nearest].filter(([, a]) => a.trusted).map(([name]) => name));
}
/** The string a `{ text }` word node carries, trimmed so a CRLF checkout reads like an LF one. */
const wordText = (value: JsonValue | undefined): string | undefined =>
  isJsonObject(value) && isJsonString(value.text) ? value.text.trim() : undefined;

/** A command's name followed by its arguments. */
function wordsOf(command: JsonObject): string[] {
  const name = isJsonObject(command.name) ? command.name : {};
  const suffix = Array.isArray(command.suffix) ? command.suffix : [];
  return [wordText({ text: name.value ?? null }), ...suffix.map(wordText)].filter(
    (word): word is string => word !== undefined,
  );
}

/** Builtins that write a variable without an Assignment node, so trust has to be withdrawn. */
const MUTATORS = new Set([
  'printf',
  'read',
  'declare',
  'typeset',
  'local',
  'export',
  'mapfile',
  'readarray',
  'getopts',
  'unset',
]);
/** A mutation whose target is an expansion could hit any name; `*` withdraws trust from all. */
const ANY_NAME = '*';
/** A target slot: `NAME`, or the `NAME` of a `NAME=value`. An argument never matches. */
const TARGET_NAME = /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/;

/** The variables a mutator's arguments name. `printf -v "$x"` names one this cannot know. */
function mutatedNames(args: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === '-v') {
      const target = args[++i];
      names.push(target === undefined || target.includes('$') ? ANY_NAME : (target ?? ANY_NAME));
      continue;
    }
    if (word.startsWith('-')) continue;
    const named = TARGET_NAME.exec(word);
    if (named) names.push(named[1]!);
  }
  return names;
}

/** Wrapper options that swallow the next word: `exec -a name`, `env -u NAME`. */
const WRAPPER_WITH_ARG = new Set(['-a', '-u', '--argv0', '--unset']);
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Index of the command a statement really runs, past any wrapper: `command`, `builtin`, `exec -a
 * name`, `env -i FOO=1`. `undefined` for a wrapper option this cannot classify, which BLOCKS.
 */
function commandHead(words: string[]): number | undefined {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (word === 'command' || word === 'builtin') {
      i++;
      continue;
    }
    if (word !== 'exec' && word !== 'env') break;
    i++;
    while (i < words.length) {
      const option = words[i]!;
      if (option === '--') {
        i++;
        break;
      }
      // `env -S '…'` carries a whole command line this cannot see into: a hole, not a skip.
      if (option === '-S' || option === '--split-string') return undefined;
      if (WRAPPER_WITH_ARG.has(option)) i += 2;
      else if (ASSIGNMENT_PREFIX.test(option)) i++;
      else if (!option.startsWith('-')) break;
      else if (/^-[a-zA-Z]+$/.test(option)) i++;
      else return undefined;
    }
  }
  return i;
}

/** The only node types between a script's root and a top-level assignment. */
const ROOT_PATH = new Set(['Script', 'Statement', 'Command', 'Assignment']);

/** Gather both halves in one pass; `false` means a construct this cannot read, which BLOCKS. */
function collectShell(
  node: JsonValue,
  scan: ShellScan,
  inline: InlineParser,
  root = true,
): boolean {
  if (Array.isArray(node)) return node.every((item) => collectShell(item, scan, inline, root));
  if (!isJsonObject(node)) return true;
  const at = isJsonInteger(node.pos) ? node.pos : 0;
  if (node.type === 'Assignment' && isJsonString(node.name)) {
    // Normalised AND trimmed: a CRLF checkout leaves a \r that collapses to a trailing space,
    // which the anchored regex rejects — and then no directive in the file resolves.
    const value = normalise(wordText(node.value) ?? '');
    // Only a top-level assignment is trusted: one inside a function, branch or subshell may never
    // run, and certifying it would let an unreachable line vouch for a real directive.
    scan.assignments.push({ name: node.name, at, trusted: root && SCRIPT_DIR_VALUE.test(value) });
  }
  if (node.type === 'Command') {
    const words = wordsOf(node);
    const head = commandHead(words);
    if (head === undefined) return false;
    // `eval` can assign anything, and a mutator writes a name no Assignment node records. Both
    // only matter at top level, the same scope whose assignments are the only trusted ones.
    if (root && words[head] === 'eval') return false;
    if (root && MUTATORS.has(words[head] ?? '')) {
      for (const name of mutatedNames(words.slice(head + 1))) {
        scan.assignments.push({ name, at, trusted: false });
      }
    }
    if (words[head] === '.' || words[head] === 'source') {
      if (words[head + 1] !== undefined) scan.operands.push({ text: words[head + 1], at });
    } else if (words[head] === 'bash') {
      // Keyed on the `bash` literal, not a .sh suffix, which would claim consumer hook paths too.
      const script = execBashScript(words, head + 1);
      if (script === undefined) return false;
      if (script.word !== null && !script.inline) scan.operands.push({ text: script.word, at });
      // `bash -c '…'` runs a SCRIPT in a CHILD shell, whose scope this cannot vouch for in either
      // direction, so it is parsed to FIND directives and any it finds is a hole.
      if (script.word !== null && script.inline) {
        const nested = inline(unquoteScript(script.word));
        if (nested === undefined || nested.operands.length > 0) return false;
      }
    }
  }
  const nested = root && (node.type === undefined || ROOT_PATH.has(String(node.type)));
  return Object.values(node).every((value) => collectShell(value, scan, inline, nested));
}

/** bash options that swallow the following word, so it is never the script path. */
const BASH_OPTION_WITH_ARG = new Set(['-O', '+O', '--rcfile', '--init-file']);

/** What `bash …` runs, and whether `-c` makes it an inline SCRIPT rather than a path. */
type BashTarget = { word: string | null; inline: boolean } | undefined;

function execBashScript(words: string[], from: number): BashTarget {
  for (let i = from; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--') return { word: words[i + 1] ?? null, inline: false };
    // A bundle carries `-c` too: `bash -lc '…'` takes an inline SCRIPT, not the path `-lc` implies.
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) return { word: words[i + 1] ?? null, inline: true };
    if (BASH_OPTION_WITH_ARG.has(word)) i++;
    else if (!word.startsWith('-') && !word.startsWith('+')) return { word, inline: false };
    else if (!/^(?:[-+][a-zA-Z]+|--[a-z]+)$/.test(word)) return undefined;
  }
  return { word: null, inline: false };
}

/** Parse a shipped script and gather its assignments and directive operands; `undefined` BLOCKS. */
export function scanShellScript(
  text: string,
  parse: (source: string) => { errors?: unknown[] },
): ShellScan | undefined {
  const scan: ShellScan = { assignments: [], operands: [] };
  const again = (nested: string): ShellScan | undefined => scanShellScript(nested, parse);
  try {
    const ast = parse(text);
    // Unparseable is a HOLE, not a pass. The JSON round-trip materialises the parser's lazy
    // `parts`/`script` getters, which a plain key walk cannot reach.
    if ((ast.errors?.length ?? 0) > 0) return undefined;
    return collectShell(parseJson(JSON.stringify(ast)), scan, again) ? scan : undefined;
  } catch {
    return undefined;
  }
}
