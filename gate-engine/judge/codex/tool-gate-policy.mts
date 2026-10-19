// What a codex gate judge may run: the read-only shell a Claude judge's tool grant gives it, decided
// before the call by the PreToolUse hook (tool-gate-hook.mts). Anything not provably a read is denied.
import { type Command, type Node, parse, type Redirect, type Statement, type Word } from 'unbash';

export type ToolDecision = { allow: true } | { allow: false; reason: string };

/** What one judge may touch: its checklist script paths and, when confined, the repository root. */
export interface GateScope {
  grants: string[];
  repoRoot?: string;
}

const ALLOW: ToolDecision = { allow: true };
const READ_ONLY =
  'a gate judge reviews by reading: shell reads, git reads and its checklist script only; tests belong to the pre-push suite';

const deny = (why: string): ToolDecision => ({ allow: false, reason: `${why} — ${READ_ONLY}` });

/** Heads whose every argument form only reads, plus the ones that need their flags checked below. */
const PLAIN_HEADS = new Set([
  'basename',
  'cat',
  'cut',
  'diff',
  'dirname',
  'echo',
  'grep',
  'head',
  'ls',
  'nl',
  'printf',
  'pwd',
  'tail',
  'tr',
  'true',
  'wc',
]);

const GIT_READS = new Set([
  'blame',
  'cat-file',
  'diff',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'rev-parse',
  'show',
  'status',
]);

// `-C <dir>` and pager switches only; `-c`, `--exec-path` and `--config-env` can run commands.
const GIT_GLOBALS = new Set(['--no-pager', '-P']);
const GIT_WRITE_OR_EXEC = ['output', 'ext-diff', 'textconv', 'filters', 'open-files-in-pager'];
const FIND_EXEC = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fls',
  '-fprint',
  '-fprint0',
  '-fprintf',
]);
const SED_PRINT = /^(\d+|\$)(,(\d+|\$))?p(;(\d+|\$)(,(\d+|\$))?p)*$/;

/** `--name[=v]` naming one of `names`, abbreviations included: GNU tools and git take a unique prefix. */
function longOption(arg: string, names: string[]): boolean {
  const name = arg.startsWith('--') ? arg.slice(2).split('=')[0] : '';
  return name !== '' && names.some((n) => n.startsWith(name));
}

/** A short-option cluster reaching `letter` before any value: `-uo f`, `-o/tmp/x`. */
const shortOption = (arg: string, letter: string): boolean =>
  new RegExp(`^-[A-Za-z]*${letter}`).test(arg);

const bare = (path: string): string => path.replace(/^\.\//, '');

/** Exactly a granted checklist path: the checkout holds the diff under review, so a lookalike is not. */
function grantedScript(path: string | undefined, grants: string[]): boolean {
  return path !== undefined && grants.some((g) => bare(g) === bare(path));
}

function gitArgsError(args: string[], scope: GateScope): string | null {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' && cdError([args[i + 1] ?? ''], scope))
      return 'git -C only into the repository under review';
    if (args[i] === '-C') i += 2;
    else if (GIT_GLOBALS.has(args[i])) i += 1;
    else return `git option ${args[i]} is not a read`;
  }
  if (!GIT_READS.has(args[i] ?? '')) return `git ${args[i] ?? ''} is not a read`;
  const bad = args
    .slice(i + 1)
    .find((a) => longOption(a, GIT_WRITE_OR_EXEC) || shortOption(a, 'O'));
  return bad ? `git ${bad} writes or runs a program` : null;
}

const uniqError = (args: string[]): string | null =>
  args.filter((a) => !a.startsWith('-')).length > 1
    ? 'uniq with two files writes the second'
    : null;

const sortError = (args: string[]): string | null =>
  args.some((a) => shortOption(a, 'o') || longOption(a, ['output', 'compress-program']))
    ? 'sort -o / --compress-program writes or runs a program'
    : null;

const rgError = (args: string[]): string | null =>
  args.some(
    (a) => shortOption(a, 'z') || longOption(a, ['pre', 'pre-glob', 'search-zip', 'hostname-bin']),
  )
    ? 'rg --pre / -z / --hostname-bin runs a program'
    : null;

const findError = (args: string[]): string | null =>
  args.some((a) => FIND_EXEC.has(a)) ? 'find -exec / -delete runs or writes' : null;

const sedError = (args: string[]): string | null =>
  args[0] === '-n' && SED_PRINT.test(args[1] ?? '') && !args.slice(2).some((a) => a.startsWith('-'))
    ? null
    : "only sed -n '<N>,<M>p' <files> is a read";

const nodeHint = (grants: string[]): string =>
  `node runs only the granted checklist script — write its path literally: node ${grants.join(' | node ') || '(none granted)'}`;

const nodeError = (args: string[], scope: GateScope): string | null =>
  grantedScript(args[0], scope.grants) ? null : nodeHint(scope.grants);

// A relative grant resolves from the cwd: `cd` elsewhere could reach a lookalike the diff added.
const cdError = (args: string[], scope: GateScope): string | null =>
  args.length === 1 && scope.repoRoot !== undefined && args[0].replace(/\/$/, '') === scope.repoRoot
    ? null
    : `cd only into the repository under review${scope.repoRoot ? ` (${scope.repoRoot})` : ''}`;

type HeadCheck = (args: string[], scope: GateScope) => string | null;

const HEAD_CHECKS = new Map<string, HeadCheck>([
  ['uniq', uniqError],
  ['sort', sortError],
  ['rg', rgError],
  ['find', findError],
  ['sed', sedError],
  ['git', gitArgsError],
  ['node', nodeError],
  ['cd', cdError],
]);

/** Why this head + argv is not a read, or null when it is. */
function commandError(head: string, args: string[], scope: GateScope): string | null {
  if (PLAIN_HEADS.has(head)) return null;
  const check = HEAD_CHECKS.get(head);
  return check ? check(args, scope) : `${head} is not a read-only command`;
}

/** Why this word could expand or execute under zsh/bash, or null for a static string. */
function wordError(word: Word): string | null {
  for (const part of word.parts ?? [
    { type: 'Literal' as const, text: word.text, value: word.value },
  ]) {
    if (part.type === 'SingleQuoted' || part.type === 'AnsiCQuoted') continue;
    if (part.type === 'DoubleQuoted') {
      if (part.parts.every((c) => c.type === 'Literal')) continue;
      return 'an expansion inside double quotes runs code — pass text arguments in single quotes';
    }
    if (part.type !== 'Literal') return `${part.text} expands — write the value literally`;
    // zsh: `=(cmd)` / `=cmd` expansion, `*(e:cmd:)` glob qualifiers, brace and pwsh script blocks.
    if (part.text.startsWith('=') || /[(){}]/.test(part.text))
      return `${part.text} is not a plain word — quote it`;
    // A glob expands to names the reviewed diff controls, such as a file named `--output=x`.
    if (/[*?[\]^]/.test(part.text)) return `${part.text} is a glob — name the files, or quote it`;
  }
  return null;
}

const DEV_NULL_REDIRECT = (r: Redirect): boolean =>
  (r.operator === '>' && r.target?.text === '/dev/null' && (r.fileDescriptor ?? 1) <= 2) ||
  (r.operator === '>&' && r.fileDescriptor === 2 && r.target?.text === '1');

/** Collect a statement's leaf commands into `out`; the reason when it holds more than a plain list. */
function collectLeaves(node: Node, out: Command[]): string | null {
  if (node.type === 'Command') {
    out.push(node);
    return null;
  }
  if (node.type !== 'Pipeline' && node.type !== 'AndOr') return `${node.type} blocks are not reads`;
  for (const child of node.commands) {
    const why = collectLeaves(child, out);
    if (why) return why;
  }
  return null;
}

/** Why one leaf command is not a read, or null when it is. */
function leafError(leaf: Command, scope: GateScope): string | null {
  if (leaf.prefix.length > 0) return 'environment assignments are not reads';
  if (!leaf.redirects.every(DEV_NULL_REDIRECT)) return 'redirects may only discard output';
  if (!leaf.name) return 'a command with no name is not a read';
  const head = leaf.name.value;
  const wordWhy = [leaf.name, ...leaf.suffix].map(wordError).find((w) => w !== null);
  // `node $SCRIPT` (the briefs' form) gets the literal path back so one retry recovers.
  if (wordWhy) return head === 'node' ? nodeHint(scope.grants) : wordWhy;
  return commandError(
    head,
    leaf.suffix.map((w) => w.value),
    scope,
  );
}

function statementError(statement: Statement, scope: GateScope): string | null {
  if (statement.background) return 'background jobs are not reads';
  if (!statement.redirects.every(DEV_NULL_REDIRECT)) return 'redirects may only discard output';
  const leaves: Command[] = [];
  const notAList = collectLeaves(statement.command, leaves);
  if (notAList) return notAList;
  for (const leaf of leaves) {
    const why = leafError(leaf, scope);
    if (why) return why;
  }
  return null;
}

function commandDecision(command: string, scope: GateScope): ToolDecision {
  const script = parse(command);
  // unbash recovers past a syntax error and drops the tail, which zsh would still run.
  if (script.errors?.length) return deny(`unparsed shell syntax (${script.errors[0].message})`);
  for (const statement of script.commands) {
    const why = statementError(statement, scope);
    if (why) return deny(why);
  }
  return ALLOW;
}

/** The hook's verdict on one tool call. */
export function judgeToolCall(
  tool: string,
  command: string | undefined,
  scope: GateScope,
): ToolDecision {
  if (tool.startsWith('mcp__') || tool === 'update_plan') return ALLOW;
  if (tool !== 'Bash') return deny(`the ${tool || 'unnamed'} tool is not available`);
  return command?.trim() ? commandDecision(command, scope) : deny('empty command');
}
