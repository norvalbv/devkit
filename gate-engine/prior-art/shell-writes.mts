/** Whether a Bash command writes files outside temp space, by FORM only (script bodies unread,
 * expansions count as no write): the prior-art gate needs one hit per session, not proof. */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { type Command, type Node, parse, type Redirect, type Word } from 'unbash';

const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>']);
const STDIN_SCRIPT_REDIRECTS = new Set(['<<', '<<-', '<<<']);
const INTERPRETER = /^(python(\d+(\.\d+)?)?|node|bun|ruby|perl|tsx)$/;
const INLINE_SCRIPT_FLAGS = new Set(['-c', '-e', '--eval', '-']);
const IN_PLACE_FLAG = /^(-[a-zA-Z]*i|--in-place)/;
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s']);
const EVERY_OPERAND_WRITTEN = new Set(['tee', 'touch', 'truncate']);
const LAST_OPERAND_WRITTEN = new Set(['cp', 'mv', 'install']);

interface Scope {
  cwd: string;
  root: string;
  temps: string[];
}

/** A word's value when it is literal; `null` when an expansion or substitution decides it. */
function literal(word: Word | undefined): string | null {
  return word && !/[$`]/.test(word.text) ? word.value : null;
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Inside the repo always counts (even a repo under tmp); elsewhere only outside temp and /dev. */
function writtenPlace(target: string | null, scope: Scope): boolean {
  if (target === null) return false;
  const expanded = target === '~' || target.startsWith('~/') ? homedir() + target.slice(1) : target;
  const path = resolve(scope.cwd, expanded);
  if (inside(path, scope.root)) return true;
  return !path.startsWith('/dev/') && !scope.temps.some((dir) => inside(path, dir));
}

function redirectsWrite(redirects: Redirect[], scope: Scope): boolean {
  return redirects.some(
    (r) => WRITE_REDIRECTS.has(r.operator) && writtenPlace(literal(r.target), scope),
  );
}

/** `xargs [flags] cmd …` and `find … -exec cmd … ;` run `cmd` on paths only known at run time. */
function wrapped(name: string, args: (string | null)[]): (string | null)[] | null {
  if (name === 'find') {
    const at = args.findIndex((a) => a === '-exec' || a === '-execdir');
    if (at < 0) return null;
    const end = args.findIndex((a, i) => i > at && (a === ';' || a === '+'));
    return args.slice(at + 1, end < 0 ? undefined : end);
  }
  let i = 0;
  while (i < args.length && args[i]?.startsWith('-')) i += XARGS_VALUE_FLAGS.has(args[i]!) ? 2 : 1;
  return args.slice(i);
}

function operands(args: (string | null)[]): (string | null)[] {
  return args.filter((a) => !a?.startsWith('-'));
}

/** In-place editors write their last operand; with none (fed by xargs or find) they still write. */
function inPlaceWrites(args: (string | null)[], scope: Scope): boolean {
  const files = operands(args);
  return files.length === 0 || writtenPlace(files.at(-1) ?? null, scope);
}

function verbWrites(
  command: (string | null)[],
  scope: Scope,
  filter: boolean,
  stdinScript: boolean,
): boolean {
  const name = basename(command[0] ?? '');
  const args = command.slice(1);
  if (name === 'xargs' || name === 'find') {
    const inner = wrapped(name, args);
    return inner !== null && inner.length > 0 && verbWrites(inner, scope, true, false);
  }
  if (name === 'git') {
    let i = 0;
    while (args[i] === '-C' || args[i] === '-c') i += 2;
    return args[i] === 'apply';
  }
  if ((name === 'sed' || name === 'perl') && args.some((a) => a !== null && IN_PLACE_FLAG.test(a)))
    return inPlaceWrites(args, scope);
  if (name === 'patch') return true;
  if (EVERY_OPERAND_WRITTEN.has(name)) return operands(args).some((a) => writtenPlace(a, scope));
  if (LAST_OPERAND_WRITTEN.has(name)) return writtenPlace(operands(args).at(-1) ?? null, scope);
  if ((name === 'bash' || name === 'sh' || name === 'zsh') && args[0] === '-c')
    return args[1] != null && scriptWrites(args[1], scope);
  if (filter || !INTERPRETER.test(name)) return false;
  return (
    args.some((a) => a !== null && INLINE_SCRIPT_FLAGS.has(a)) ||
    (stdinScript && operands(args).length === 0)
  );
}

function commandWrites(command: Command, scope: Scope, filter: boolean): boolean {
  if (redirectsWrite(command.redirects, scope)) return true;
  const stdinScript = command.redirects.some((r) => STDIN_SCRIPT_REDIRECTS.has(r.operator));
  const words = [command.name, ...command.suffix].map(literal);
  return verbWrites(words, scope, filter, stdinScript);
}

function children(node: Node): Node[] {
  switch (node.type) {
    case 'Statement':
      return [node.command];
    case 'AndOr':
    case 'CompoundList':
      return node.commands;
    case 'If':
      return node.else ? [node.clause, node.then, node.else] : [node.clause, node.then];
    case 'While':
      return [node.clause, node.body];
    case 'Case':
      return node.items.map((item) => item.body);
    case 'Subshell':
    case 'BraceGroup':
    case 'For':
    case 'Select':
    case 'ArithmeticFor':
    case 'Function':
    case 'Coproc':
      return [node.body];
    default:
      return [];
  }
}

/** A pipeline's later stages are filters: an interpreter there reads stdin, it does not author. */
function nodeWrites(node: Node, scope: Scope, filter: boolean): boolean {
  if (node.type === 'Command') return commandWrites(node, scope, filter);
  if (node.type === 'Pipeline')
    return node.commands.some((c, i) => nodeWrites(c, scope, filter || i > 0));
  if ('redirects' in node && redirectsWrite(node.redirects, scope)) return true;
  return children(node).some((child) => nodeWrites(child, scope, filter));
}

function scriptWrites(command: string, scope: Scope): boolean {
  const ast = parse(command);
  if (ast.errors?.length) return false;
  return ast.commands.some((statement) => nodeWrites(statement, scope, false));
}

/** True when `command`, run from `cwd`, writes a file inside `root` or anywhere outside temp. */
export function writesToRepo(command: string, cwd: string, root: string): boolean {
  const temps = ['/tmp', '/private/tmp', tmpdir()];
  try {
    temps.push(realpathSync(tmpdir()));
  } catch {
    // an unresolvable tmpdir keeps its literal spelling only
  }
  return scriptWrites(command, { cwd, root, temps });
}
