/**
 * The capture LEXER for the sentry gate (sc-1984): given a line or a hunk of staged source, which
 * Sentry capture calls does it really contain?
 *
 * "Really" is the whole difficulty. Review of this module's first cut found capture-shaped text in
 * strings, in trailing and multi-line comments, in template text, and behind receivers of every
 * shape — each one either inventing instrumentation the commit never added or hiding instrumentation
 * it did. So the lexer strips literals and comments with cross-line state before matching, and
 * decides qualification structurally rather than by listing receiver forms.
 *
 * It is still a lexer built from regexes, not a parser, so exotic source can defeat it. That is
 * survivable ONLY because nothing here carries blocking authority: `evidence.mts` decides what may
 * block from a deliberately over-inclusive raw-text test, and this module decides the finer question
 * of what to SHOW and what to name in the inventory.
 */

// ─── The capture matcher ────────────────────────────────────────────────────────

// The pattern finds the NAME only; `scanCode` decides whether it is CALLED and by whom. Enumerating
// receiver forms in a pattern always leaves one unlisted, and each miss reads as unqualified.
const CAPTURE_CALL_RE = /\b(capture[A-Z][\w$]*)/g;

// Reached THROUGH something — `.`, `?.`, `!.`, and past a `#` private name — whatever produced it.
const DOT_REACHED_RE = /[?!]?\.#?$/;
// DEFINING a wrapper is not CALLING one, and both have the same shape. The keyword catches the
// function form; `opensABody` catches the rest by asking what FOLLOWS the arguments.
const DECLARES_RE = /\bfunction\s*\*?$/;
// `new captureContained(err)` CONSTRUCTS something; it does not report an error to Sentry.
const CONSTRUCTS_RE = /\bnew$/;
// …and that something is Sentry itself only when the bare word `Sentry` owns the dot. `mySentry.`
// and `a.Sentry.` both fail: a longer identifier and a nested member are different objects.
const SENTRY_OWNED_RE = /(?:^|[^\w$.])Sentry\s*[?!]?\.$/;

// Look-alikes. Promoting them re-imports the distractors whose removal moved the eval 0.83 → ~0.91.
const CAPTURE_DENY_RE = /^capture(?:StackTrace|Screenshot|Screen|Thumbnail|Video|Image|Frame)$/;

// Where an expression may START, so a `/` there opens a regex rather than dividing. `]` is absent:
// it closes an index or an array literal, both VALUES, after which a slash always divides.
// The lookbehind excludes a DOUBLED `+` or `-`: postfix `count++` yields a value, so the slash after
// it divides. A single one is still an operator, after which a regex may open.
const REGEX_PRECEDER_RE =
  /(?:^|(?<![+-])[=(,:;!&|?{}[+\-*%<>~^]|\b(?:return|throw|typeof|case|in|of|new|delete|void|await|yield|do|else))\s*$/;

// `)` is the one ambiguous predecessor — `foo() / 2` divides, `if (ok) /re/` does not — so which it
// is depends on what OPENED the paren.
const CONTROL_KEYWORD_RE = /\b(?:if|while|for|switch|catch|with)\s*$/;

// `}` is ambiguous for the same reason: it closes a BLOCK (after which a slash opens a regex) or an
// object LITERAL (after which it divides). Which one is decided by where the matching `{` sat.
const OBJECT_POSITION_RE = /(?:^|[=(,:[+\-*%<>~^!&|?]|\breturn|\btypeof)\s*$/;

/** True when `text` ends with the `}` of an object literal — a VALUE, so a following `/` divides. */
function closesObjectLiteral(text: string): boolean {
  return closesFrom(text, '}', '{', (before) => OBJECT_POSITION_RE.test(before));
}

/** Match a closer back to its opener and ask `decide` about the text before it. */
function closesFrom(
  text: string,
  close: string,
  open: string,
  decide: (before: string) => boolean,
): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(close)) return false;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    if (trimmed[i] === close) depth += 1;
    else if (trimmed[i] === open && (depth -= 1) === 0) return decide(trimmed.slice(0, i));
  }
  return false;
}

/** True when `text` ends with the `)` that closes a control-flow condition, after which a `/` begins
 * a regex rather than a division. */
function closesControlCondition(text: string): boolean {
  return closesFrom(text, ')', '(', (before) => CONTROL_KEYWORD_RE.test(before));
}

/** Index just past the quoted span starting at `text[i]`. An escaped quote does not end it. */
function pastQuote(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Index just past the regex literal starting at `text[i]`, flags included. A `/` inside a character
 * class does not close it. */
function pastRegex(text: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < text.length && text[j] !== '\n') {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '/' && !inClass) break;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    j += 1;
  }
  while (/[dgimsuvy]/.test(text[j + 1] ?? '')) j += 1;
  return j + 1;
}

/** Index just past the template starting at `text[i]`, handing each `${…}` body to `onInterp`. A
 * brace inside a quoted span or a nested template does not close an interpolation. */
function pastTemplate(
  text: string,
  i: number,
  onInterp: (body: string) => void,
  onText: (span: string) => void = () => {},
): number {
  let j = i + 1;
  let textFrom = j;
  while (j < text.length && text[j] !== '`') {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] !== '$' || text[j + 1] !== '{') {
      j += 1;
      continue;
    }
    onText(text.slice(textFrom, j));
    j += 2;
    const from = j;
    let depth = 1;
    let prev = '';
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === "'" || c === '"') j = pastQuote(text, j);
      else if (c === '`') j = pastTemplate(text, j, () => {});
      // Braces inside a comment are prose, as inside a string or regex they are data.
      else if (c === '/' && text[j + 1] === '/') {
        const eol = text.indexOf('\n', j);
        j = eol === -1 ? text.length : eol;
      } else if (c === '/' && text[j + 1] === '*') {
        const close = text.indexOf('*/', j + 2);
        j = close === -1 ? text.length : close + 2;
      }
      // …and a regex's braces likewise: recognised only where an expression may start.
      else if (c === '/' && text[j + 1] !== '/' && REGEX_PRECEDER_RE.test(prev)) {
        j = pastRegex(text, j);
      } else {
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        if (depth > 0) j += 1;
      }
      if (!/\s/.test(c)) prev = text.slice(from, j);
    }
    onInterp(text.slice(from, j));
    j += 1;
    textFrom = j;
  }
  onText(text.slice(textFrom, Math.min(j, text.length)));
  return j + 1;
}

// Commented-out code instruments nothing, so the inventory must not read it as instrumentation — the
// judge prompt says the same and the two must not contradict each other. A `/*` with no closer opens
// a block that swallows EVERY following line, which a line-local check cannot see. Any over-strip
// loses a capture rather than inventing one — the fail-closed direction, since a false inventory
// entry tells the judge an un-instrumented surface is covered.
// `/*` is absent: a line may open AND close a block and still carry a call — `/* note *\/ cap(e);`.
// stripComments removes the span properly, so the line-local guard only needs the forms that run to
// end of line.
const COMMENT_LINE_RE = /^(?:\/\/|\*|#)/;

/** Running block-comment state, carried from one diff line to the next within a file segment. */
export interface CommentScan {
  inBlock: boolean;
}

/** A fresh scan — a segment's first line is never already inside a comment. */
export const newScan = (): CommentScan => ({ inBlock: false });

/** What one pass of `stripCode` observed beyond the code itself. */
interface ScanResult {
  code: string;
  /** A block CLOSE met while not inside a block — the window began inside a comment the text never
   * shows opening, which only a caller holding the whole hunk can act on. */
  strayClose: boolean;
}

/**
 * Comments AND literals removed in ONE left-to-right pass, keeping template `${…}` bodies (code) and
 * the exact newline count, since callers split the result back into diff lines.
 *
 * The two cannot be separate passes in either order, as review proved from both sides: strip literals
 * first and the slash of a block CLOSE reads as a regex opener, swallowing the line; strip comments
 * first and a `//` inside a string ends it. Handling both here lets a close be recognised BEFORE
 * anything asks whether a slash opens a regex, which is what allows `*` back into the expression-start
 * set so `weight * /re/.test(x)` is read as the regex it is.
 */
export function stripCode(text: string, scan: CommentScan): ScanResult {
  let out = '';
  let strayClose = false;
  let i = 0;
  const blankOut = (from: number, to: number) => {
    out += '\n'.repeat(text.slice(from, to).split('\n').length - 1);
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (scan.inBlock) {
      const close = text.indexOf('*/', i);
      const end = close === -1 ? text.length : close + 2;
      blankOut(i, end);
      if (close !== -1) scan.inBlock = false;
      i = end;
    } else if (c === '*' && next === '/') {
      strayClose = true;
      i += 2;
    } else if (c === '/' && next === '/') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol;
    } else if (c === '/' && next === '*') {
      scan.inBlock = true;
      i += 2;
    } else if (c === "'" || c === '"') {
      const end = pastQuote(text, i);
      blankOut(i, end);
      i = end;
    } else if (c === '`') {
      i = pastTemplate(
        text,
        i,
        (body) => {
          out += ` ${stripCode(body, newScan()).code} `;
        },
        (span) => {
          out += '\n'.repeat(span.split('\n').length - 1);
        },
      );
    } else if (
      c === '/' &&
      (REGEX_PRECEDER_RE.test(out) || closesControlCondition(out)) &&
      !closesObjectLiteral(out)
    ) {
      const end = pastRegex(text, i);
      blankOut(i, end);
      out += ' ';
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return { code: out, strayClose };
}

/**
 * Every capture SYMBOL a line calls, or [] — the receiver rule is the whole point:
 *   · unqualified (`captureContained(...)`) or `Sentry.`-qualified counts;
 *   · anything reached through a dot does NOT, whatever produced the object — `Error.`, `this.`,
 *     `client?.`, `client!.`, `getClient().`, `arr[0].`, `obj.client.`. Each names a different
 *     object's method, and the one that matters (`Error.captureStackTrace`) is local error plumbing.
 * The rule is checked structurally rather than by listing receiver shapes, so a form nobody thought
 * of fails CLOSED (not a capture) instead of open (false instrumentation evidence).
 * This is the RELEVANCE matcher and is deliberately WIDER than diff-focus's SENTRY_CAPTURE_RE, which
 * is the cache-identity ERASURE matcher: every match there is deleted from a verdict key and so can
 * never invalidate an earned verdict, which is why that one must stay conservative and these two must
 * never be merged.
 */
export function captureSymbols(line: string): string[] {
  if (COMMENT_LINE_RE.test(line.trim())) return [];
  return scanCode(stripCode(line, newScan()).code).map((hit) => hit.symbol);
}

/** One capture call found in stripped code, with the offset of its NAME. */
interface CaptureHit {
  symbol: string;
  index: number;
  /** Offset of the `(` that opens the arguments. A call can SPAN lines, and the commit that adds
   * only its argument list still adds the call, so attribution needs both ends. */
  argsIndex: number;
}

/**
 * Capture calls in already-stripped CODE, which may span newlines — `captureContained` on one line
 * and its `(err)` on the next is ONE call, and scanning line by line would report neither it nor the
 * receiver that precedes it. Callers strip comments and strings first (per line, so block state is
 * tracked) and then join, so this sees only executable text.
 */
export function scanCode(code: string): CaptureHit[] {
  const hits: CaptureHit[] = [];
  for (const match of code.matchAll(CAPTURE_CALL_RE)) {
    const args = callArgsAt(code, match.index + match[0].length);
    if (args === -1) continue;
    const before = code.slice(0, match.index).trimEnd();
    if (DECLARES_RE.test(before) || CONSTRUCTS_RE.test(before)) continue;
    if (opensABody(code, args + 1)) continue;
    if (DOT_REACHED_RE.test(before) && !SENTRY_OWNED_RE.test(before)) continue;
    if (CAPTURE_DENY_RE.test(match[1])) continue;
    hits.push({ symbol: match[1], index: match.index, argsIndex: args });
  }
  return hits;
}

/**
 * Where this name's argument list opens, or -1 if the name is not being CALLED. Walked rather than
 * matched because a type argument can contain anything — `captureContained<(e: Error) => void>(h)`
 * puts both parentheses and a `>` inside the generic — and each pattern that tried to spell that out
 * excluded some valid call instead. The `<` must ABUT the name: that single rule is what keeps
 * `captureCount < x && y > (z)` a comparison rather than a generic call.
 */
function callArgsAt(code: string, from: number): number {
  let i = from;
  if (code[i] === '<') {
    let depth = 0;
    for (; i < code.length; i += 1) {
      // A type argument may hold a single `&` or `|` (intersection, union) but never a doubled one,
      // and never an equality operator. Meeting either means this is a COMPARISON written without
      // spaces — `captureCount<x && y>(z)` — which abuts the name exactly as a generic does.
      const pair = code.slice(i, i + 2);
      if (pair === '&&' || pair === '||' || pair === '==' || pair === '!=') return -1;
      if (code[i] === '<') depth += 1;
      else if (code[i] === '=' && code[i + 1] === '>')
        i += 1; // an arrow, not a closer
      else if (code[i] === '>' && (depth -= 1) === 0) {
        i += 1;
        break;
      }
    }
    if (depth !== 0) return -1;
  }
  const skipSpace = () => {
    while (code[i] === ' ' || code[i] === '\t' || code[i] === '\n') i += 1;
  };
  skipSpace();
  // A non-null assertion and an optional call may both sit between the name and its arguments.
  if (code[i] === '!') i += 1;
  skipSpace();
  if (code[i] === '?' && code[i + 1] === '.') i += 2;
  skipSpace();
  return code[i] === '(' ? i : -1;
}

/** True when what follows the arguments at `from` is a DECLARATION rather than a call. Two shapes: a
 * body brace (`captureContained(e) {`), possibly behind a return type; and a body-LESS TypeScript
 * signature (`captureContained(e: Error): void;`) as found in an interface or abstract class. The
 * second is told apart from `cond ? captureContained(e) : other` — which also puts a colon after the
 * arguments — by requiring a PARAMETER annotation, which a call's arguments cannot carry. */
function opensABody(code: string, from: number): boolean {
  let depth = 1;
  let i = from;
  while (i < code.length && depth > 0) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') depth -= 1;
    i += 1;
  }
  const rest = code.slice(i).trimStart();
  if (rest.startsWith('{')) return true;
  if (!rest.startsWith(':')) return false;
  const brace = rest.indexOf('{');
  const ends = rest.search(/[;=]/);
  if (brace !== -1 && (ends === -1 || brace < ends)) return true;
  return hasParamAnnotation(code.slice(from, i - 1));
}

/** True when an argument list carries a top-level `name:` type annotation — the mark of a parameter
 * list rather than a call's arguments. Two colons must NOT count: an object key (`{ a: 1 }`) sits
 * below depth 0, and a ternary's (`x ? y : z`) is claimed by the `?` that opened it. An optional
 * parameter's `?` is told from a ternary's by what follows it — `name?:` immediately, an expression
 * otherwise. */
function hasParamAnnotation(args: string): boolean {
  let depth = 0;
  let openTernaries = 0;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === '?' && depth === 0 && args.slice(i + 1).trimStart()[0] !== ':')
      openTernaries += 1;
    else if (c === ':' && depth === 0) {
      if (openTernaries > 0) openTernaries -= 1;
      else if (/[\w$?]\s*$/.test(args.slice(0, i))) return true;
    }
  }
  return false;
}

/** A hunk's POST-IMAGE lines (context + added), stripped to code. Scanned as ONE text so a literal or
 * comment spanning lines is removed whole; a stray block CLOSE proves the window opened inside a
 * comment the diff never shows starting, so the scan is repeated already inside one. */
export function hunkCodeLines(lines: string[]): Array<{ added: boolean; code: string }> {
  const post = imageLines(lines, '-');
  const stripped = imageCode(post, '+').split('\n');
  return post.map((l, i) => ({ added: l.startsWith('+'), code: stripped[i] ?? '' }));
}

/** One IMAGE of a hunk: `drop` names the prefix absent from it — `-` for the post-image (context +
 * added), `+` for the pre-image (context + removed). Both include CONTEXT, which is what carries a
 * comment or literal opened on an unchanged line into the changed ones. */
function imageLines(lines: string[], drop: '+' | '-'): string[] {
  return lines.filter((l) => !l.startsWith(drop) && !l.startsWith('@@ '));
}

/** That image stripped to code, scanned as ONE text and re-scanned already inside a block when a
 * stray close proves the window opened within a comment the diff never shows starting. */
function imageCode(lines: string[], keep: '+' | '-'): string {
  const body = lines.map((l) => l.replace(keep === '+' ? /^[+ ]/ : /^[- ]/, '')).join('\n');
  const first = stripCode(body, newScan());
  return (first.strayClose ? stripCode(body, { inBlock: true }) : first).code;
}

/** True if this hunk contains a capture CALL anywhere, in EITHER image. Each is scanned whole — with
 * its context lines, which is where a block comment or literal enclosing the change usually opens. */
export function capturesHunk(hunk: string): boolean {
  const lines = hunk.split('\n');
  const pre = imageLines(lines, '+');
  if (pre.some((l) => l.startsWith('-')) && scanCode(imageCode(pre, '-')).length > 0) return true;
  return (
    scanCode(
      hunkCodeLines(lines)
        .map((l) => l.code)
        .join('\n'),
    ).length > 0
  );
}
