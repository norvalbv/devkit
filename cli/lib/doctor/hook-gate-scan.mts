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
