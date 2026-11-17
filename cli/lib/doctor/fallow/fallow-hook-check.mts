/**
 * The fallow half of doctor's pre-commit checks (sc-2341). Split from hook-checks.mts, which sits
 * at its line budget, into its own folder because cli/lib/doctor is at its fan-out cap.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'unbash';
import {
  isJsonInteger,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
  parseJson,
} from '../../../../gate-engine/comment-firewall/types.mts';
import { detectGitRoot } from '../../detect-git-root.mts';
import { FALLOW_STAGED_BLOCK } from '../../husky/gate-policy/fallow-staged.mts';
import { extractGuardBlock } from '../../husky/husky-block.mts';
import { isDevkitRepo } from '../../husky/self-host.mts';
import { type CheckResult, check } from '../check-result.mts';

// The row name doctor --fix routes to an init re-run (HOOK_CHECKS in doctor.mts), as checkHusky's.
const NAME = '.husky/pre-commit';
// The exact marker grammar of husky.mts markStart/markEnd, for any monorepo package.
const MARK_START_RE = /^# >>> devkit-guards(?:: \S.*)? >>>$/;
const MARK_END_RE = /^# <<< devkit-guards(?:: \S.*)? <<<$/;
/** A word node's DEQUOTED value: `"fallow"` and `fallow` are the same argv entry. */
const valueOf = (word: JsonValue | undefined): string =>
  isJsonObject(word) && isJsonString(word.value) ? word.value : '';

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);
const DASH_C_RE = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const basename = (word: string) => word.split('/').at(-1) ?? word;
type Span = [number, number];

const SHELL_OPTION_WITH_ARG = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

/**
 * Wrappers that run the command after them, with the options that consume the next word. `skip` is
 * a count of leading operands that are not the command (`timeout DURATION cmd`, `pnpm exec cmd`).
 */
interface Wrapper {
  withArg: string[];
  skip?: number;
}
const WRAPPERS = new Map<string, Wrapper>([
  ['command', { withArg: [] }],
  ['builtin', { withArg: [] }],
  ['exec', { withArg: ['-a'] }],
  ['env', { withArg: ['-u', '--unset', '-C', '--chdir'] }],
  [
    'sudo',
    { withArg: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'] },
  ],
  ['doas', { withArg: ['-u', '-C'] }],
  ['nohup', { withArg: [] }],
  ['nice', { withArg: ['-n', '--adjustment'] }],
  ['time', { withArg: ['-f', '-o', '--format', '--output'] }],
  ['timeout', { withArg: ['-s', '-k', '--signal', '--kill-after'], skip: 1 }],
  ['stdbuf', { withArg: ['-i', '-o', '-e'] }],
  ['npx', { withArg: ['-p', '--package'] }],
  ['bunx', { withArg: ['-p', '--package'] }],
  ['pnpm', { withArg: [], skip: 1 }],
  ['yarn', { withArg: [] }],
]);

const TERMINAL_OPTIONS = new Set(['-v', '-V', '--help', '--version']);
const ENV_SPLIT_RE = /^(?:-S|--split-string=?)(.*)$/;

// Index of the command argv REALLY runs, past assignments and wrappers; -1 when a wrapper only
// looks the name up (`command -v`). `env -S '…'` instead yields the command LINE it splits and runs.
type Effective = { kind: 'argv'; at: number } | { kind: 'line'; line: string } | { kind: 'none' };
const NONE: Effective = { kind: 'none' };

function effectiveCommand(argv: string[]): Effective {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i] ?? '';
    const wrapper = WRAPPERS.get(basename(word));
    if (ASSIGNMENT_RE.test(word)) {
      i++;
      continue;
    }
    if (!wrapper) return { kind: 'argv', at: i };
    i++;
    let skip = wrapper.skip ?? 0;
    while (i < argv.length) {
      const option = argv[i] ?? '';
      // A lookup or a terminal option runs nothing after it: `command -v x`, `env --help x`.
      if (TERMINAL_OPTIONS.has(option)) return NONE;
      const split = basename(word) === 'env' ? ENV_SPLIT_RE.exec(option) : null;
      if (split) {
        const inline = split[1] ? [split[1]] : argv.slice(i + 1, i + 2);
        const after = split[1] ? i + 1 : i + 2;
        return { kind: 'line', line: [...inline, ...argv.slice(after)].join(' ') };
      }
      if (option === '--') {
        i++;
        break;
      }
      if (wrapper.withArg.includes(option)) i += 2;
      else if (option.startsWith('-') || ASSIGNMENT_RE.test(option)) i++;
      else if (skip > 0) {
        skip--;
        i++;
      } else break;
    }
  }
  return NONE;
}

// The command string a shell invocation runs, or undefined. Options end at `--` or the first
// operand; with `-c` (alone or bundled) that operand IS the script, otherwise it is a script PATH.
function shellCommandString(args: string[]): string | undefined {
  let dashC = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? '';
    if (word === '--') return dashC ? args[i + 1] : undefined;
    if (SHELL_OPTION_WITH_ARG.has(word)) i++;
    else if (DASH_C_RE.test(word)) dashC = true;
    else if (!word.startsWith('-') && !word.startsWith('+')) return dashC ? word : undefined;
  }
  return undefined;
}

// Function definitions in scope (name → body), and the names being expanded (recursion guard).
interface Scope {
  functions: Map<string, JsonValue>;
  active: Set<string>;
}

// The EFFECTIVE command is `fallow audit … --base`, a shell `-c` / `eval` string or a called
// function that runs one. Any other command's arguments are data (`echo`, a helper script path).
function isMergeBaseAudit(command: JsonObject, scope: Scope): boolean {
  const suffix = Array.isArray(command.suffix) ? command.suffix : [];
  const argv = [valueOf(command.name), ...suffix.map(valueOf)];
  const effective = effectiveCommand(argv);
  if (effective.kind === 'line') return scriptRunsAudit(effective.line, scope);
  if (effective.kind === 'none') return false;
  const { at } = effective;
  const head = basename(argv[at] ?? '');
  const rest = argv.slice(at + 1);
  if (head === 'fallow') {
    return rest[0] === 'audit' && rest.some((w) => w === '--base' || w.startsWith('--base='));
  }
  const body = scope.functions.get(argv[at] ?? '');
  if (body !== undefined && !scope.active.has(argv[at] ?? '')) {
    scope.active.add(argv[at] ?? '');
    const runs = auditPositions(body, scope).length > 0;
    scope.active.delete(argv[at] ?? '');
    return runs;
  }
  if (head === 'eval') return scriptRunsAudit(rest.join(' '), scope, true);
  const script = SHELLS.has(head) ? shellCommandString(rest) : undefined;
  return script !== undefined && scriptRunsAudit(script, scope);
}

// The JSON round-trip materialises unbash's lazy `parts`/`script` getters (see scanShellScript).
const treesOf = (src: string) => parse(src).commands.map((st) => parseJson(JSON.stringify(st)));
// `eval` runs in THIS shell, so its definitions persist; `sh -c` gets a child copy.
function scriptRunsAudit(src: string, outer: Scope, sameShell = false): boolean {
  const scope = sameShell ? outer : { functions: new Map(outer.functions), active: outer.active };
  return auditPositions(treesOf(src), scope).length > 0;
}

// Nodes whose children ALWAYS run when they do; any other (if, loops, &&, subshells) is conditional.
const SEQUENTIAL = new Set(['Statement', 'CompoundList', 'BraceGroup']);

// Offsets of Commands that can run a merge-base audit, in source order. A function counts at later
// call sites, and only if defined UNCONDITIONALLY (branches are not evaluated: under-report, by design).
function auditPositions(
  node: JsonValue,
  scope: Scope,
  out: number[] = [],
  unconditional = true,
): number[] {
  if (Array.isArray(node)) {
    for (const item of node) auditPositions(item, scope, out, unconditional);
    return out;
  }
  if (!isJsonObject(node)) return out;
  if (node.type === 'Function') {
    if (unconditional) scope.functions.set(valueOf(node.name), node.body ?? null);
    return out;
  }
  if (node.type === 'Command' && isMergeBaseAudit(node, scope)) {
    out.push(isJsonInteger(node.pos) ? node.pos : 0);
    return out;
  }
  const always = unconditional && SEQUENTIAL.has(String(node.type));
  for (const value of Object.values(node)) auditPositions(value, scope, out, always);
  return out;
}

// Words that span lines (multi-line quoted strings): text inside them is data, never a comment.
function multilineWordSpans(node: JsonValue, spans: Span[] = []): Span[] {
  if (Array.isArray(node)) {
    for (const item of node) multilineWordSpans(item, spans);
    return spans;
  }
  if (!isJsonObject(node)) return spans;
  const { text, pos, end } = node;
  if (isJsonString(text) && text.includes('\n') && isJsonInteger(pos) && isJsonInteger(end)) {
    spans.push([pos, end]);
  }
  for (const value of Object.values(node)) multilineWordSpans(value, spans);
  return spans;
}

const LEADING_TABS_RE = /^\t+/;
const within = (spans: Span[], at: number) => spans.some(([from, to]) => from <= at && at < to);

// Heredoc bodies as source spans. unbash keeps the body text but no position for it, and the body
// runs past its statement's `end`, so the span is read off the source up to the delimiter line.
function heredocSpans(src: string, node: JsonValue, spans: Span[] = []): Span[] {
  if (Array.isArray(node)) {
    for (const item of node) heredocSpans(src, item, spans);
    return spans;
  }
  if (!isJsonObject(node)) return spans;
  const op = node.operator;
  if (isJsonString(op) && (op === '<<' || op === '<<-') && isJsonInteger(node.end)) {
    const delimiter = valueOf(node.target);
    const last = spans.at(-1)?.[1] ?? 0;
    let at = Math.max(src.indexOf('\n', node.end) + 1, last);
    while (at > 0 && at < src.length) {
      const eol = src.indexOf('\n', at);
      const next = eol === -1 ? src.length : eol + 1;
      const line = src.slice(at, eol === -1 ? src.length : eol);
      if ((op === '<<-' ? line.replace(LEADING_TABS_RE, '') : line) === delimiter) break;
      at = next;
    }
    spans.push([src.indexOf('\n', node.end) + 1, at]);
  }
  for (const value of Object.values(node)) heredocSpans(src, value, spans);
  return spans;
}

/** Lines of commands OUTSIDE every devkit block that can run a merge-base audit. */
export function mergeBaseFallowLines(hook: string): number[] {
  const trees = treesOf(hook);
  // A marker is a COMMENT line — also inside `if … fi` — but text in a heredoc or a multi-line
  // quoted string is data, and a marker there opens nothing.
  const data: Span[] = [...heredocSpans(hook, trees), ...multilineWordSpans(trees)];
  const blocks: Span[] = [];
  let open = -1;
  let offset = 0;
  for (const line of hook.split('\n')) {
    if (!within(data, offset)) {
      if (MARK_START_RE.test(line)) open = offset;
      else if (MARK_END_RE.test(line) && open >= 0) {
        blocks.push([open, offset + line.length]);
        open = -1; // a stray second end marker must not re-close the same block
      }
    }
    offset += line.length + 1;
  }
  const lineOf = (pos: number) => hook.slice(0, pos).split('\n').length;
  const scope: Scope = { functions: new Map(), active: new Set() };
  const lines = auditPositions(trees, scope)
    .filter((pos) => !within(blocks, pos))
    .map(lineOf);
  return [...new Set(lines)].sort((a, b) => a - b);
}

// A pasted merge-base audit still runs with fallow deselected, so it is always an advisory (--fix
// cannot delete a consumer's lines); only a SELECTED fallow requires the staged gate in the block.
export function checkFallowHook(cwd: string, fallow: boolean | undefined): CheckResult[] {
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  let hook: string;
  try {
    hook = readFileSync(hookPath, 'utf8');
  } catch {
    return []; // absent or unreadable (even mid-doctor): checkHusky owns that report
  }
  const results: CheckResult[] = [];
  const block = extractGuardBlock(hook, pkgRel);
  // Exact generated text, not a marker; devkit's own block is held byte-exact by hook-parity instead.
  if (fallow && block !== null && !isDevkitRepo(cwd) && !block.includes(FALLOW_STAGED_BLOCK)) {
    results.push(
      check(
        NAME,
        'DRIFT',
        'fallow is selected but the devkit block has no staged fallow gate',
        'run `devkit upgrade` (or `devkit init --force`) to regenerate the block',
        true,
      ),
    );
  }
  const pasted = mergeBaseFallowLines(hook);
  if (pasted.length) {
    results.push(
      check(
        NAME,
        'DRIFT',
        `merge-base fallow audit reachable OUTSIDE the devkit block (line ${pasted.join(', ')}) — it judges every commit since the merge-base, not the staged set`,
        fallow
          ? "delete it: devkit's block now runs `git diff --cached | fallow audit --diff-stdin`"
          : 'delete it, or re-enable fallow (`devkit init --fallow`) for the staged-scoped gate',
        false,
        true,
      ),
    );
  }
  return results;
}
