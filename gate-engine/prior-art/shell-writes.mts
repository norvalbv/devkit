/** Whether a Bash command writes files outside temp space, by FORM only (script bodies unread,
 * expansions count as no write): the prior-art gate needs one hit per session, not proof. */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { type Command, type Node, parse, type Redirect, type Word } from 'unbash';

const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>']);
const FD_TARGET = /^(\d+|-)$/;
const STDIN_SCRIPT_REDIRECTS = new Set(['<<', '<<-', '<<<']);
const INTERPRETER = /^(python(\d+(\.\d+)?)?|node|bun|ruby|tsx)$/;
const INLINE_SCRIPT_FLAGS = new Set(['-c', '-e', '--eval', '-']);
// Only value-less flags may precede `i`, so perl's `-Ilib` or `-Mstrict` never read as in-place.
const SED_IN_PLACE = /^(-[nErsuz]*i|--in-place)/;
const PERL_IN_PLACE = /^-[0-9alnpsw]*i/;
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s']);
const NO_VALUE_FLAGS: ReadonlySet<string> = new Set();
// Flags whose next word is a value, never a file operand (`truncate -s 0 f`, `cp -t dir a b`).
const TOUCH_VALUE_FLAGS = new Set(['-d', '-t', '-r', '--date', '--reference']);
const TRUNCATE_VALUE_FLAGS = new Set(['-s', '-r', '--size', '--reference']);
const COPY_VALUE_FLAGS = new Set([
  '-S',
  '-m',
  '-o',
  '-g',
  '--suffix',
  '--mode',
  '--owner',
  '--group',
]);
const TARGET_DIR_LONG = '--target-directory';
const SHORT_TARGET_CLUSTER = /^-[a-zA-Z]*t$/;
const SHORT_TARGET_ATTACHED = /^-t(.+)$/;

type Args = (string | null)[];

interface Scope {
  cwd: string;
  root: string;
  temps: string[];
}

interface Context {
  scope: Scope;
  /** a later pipeline stage: an interpreter there reads stdin, it does not author */
  filter: boolean;
  stdinScript: boolean;
  /** run by xargs or find -exec, which supply file operands at run time */
  wrapped: boolean;
}

type VerbRule = (args: Args, context: Context) => boolean;

/** A word's value when it is literal; `null` when an expansion or substitution decides it. */
function literal(word: Word | undefined): string | null {
  return word && !/[$`]/.test(word.text) ? word.value : null;
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
}

/** Inside the repo always counts (even a repo under tmp); elsewhere only outside temp and /dev. */
function writtenPlace(target: string | null, scope: Scope): boolean {
  if (target === null) return false;
  const path = resolve(scope.cwd, expandHome(target));
  if (inside(path, scope.root)) return true;
  return !path.startsWith('/dev/') && !scope.temps.some((dir) => inside(path, dir));
}

/** `>&` writes only when its target is a file, not an fd duplication such as `2>&1`. */
function writeRedirect(r: Redirect): boolean {
  return (
    WRITE_REDIRECTS.has(r.operator) ||
    (r.operator === '>&' && !FD_TARGET.test(r.target?.value ?? ''))
  );
}

function redirectsWrite(redirects: Redirect[], scope: Scope): boolean {
  return redirects.some((r) => writeRedirect(r) && writtenPlace(literal(r.target), scope));
}

function operands(args: Args, valueFlags: ReadonlySet<string> = NO_VALUE_FLAGS): Args {
  const found: Args = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? null;
    if (!arg?.startsWith('-')) found.push(arg);
    else if (valueFlags.has(arg)) i++;
  }
  return found;
}

/** Where `patch` writes: `-d DIR`, `-dDIR` or `--directory[=]DIR`, else cwd. */
function patchDir(args: Args): string | null {
  for (const [i, a] of args.entries()) {
    if (a === '-d' || a === '--directory') return args[i + 1] ?? null;
    if (a?.startsWith('--directory=')) return a.slice('--directory='.length);
    if (a?.startsWith('-d')) return a.slice(2);
  }
  return '.';
}

/** In-place editors write their last operand; with none (fed by xargs or find) they still write. */
function inPlaceWrites(args: Args, scope: Scope): boolean {
  const files = operands(args);
  return files.length === 0 || writtenPlace(files.at(-1) ?? null, scope);
}

function hasFlag(args: Args, flag: RegExp): boolean {
  return args.some((a) => a !== null && flag.test(a));
}

function interpreterWrites(args: Args, { filter, stdinScript }: Context): boolean {
  if (filter) return false;
  const inline = args.some((a) => a !== null && INLINE_SCRIPT_FLAGS.has(a));
  return inline || (stdinScript && operands(args).length === 0);
}

/** `xargs [flags] cmd …` and `find … -exec cmd … ;` run `cmd` on paths only known at run time. */
function wrappedWrites(inner: Args, context: Context): boolean {
  const nested = { ...context, filter: true, stdinScript: false, wrapped: true };
  return inner.length > 0 && verbWrites(inner, nested);
}

function xargsInner(args: Args): Args {
  let i = 0;
  while (i < args.length && args[i]?.startsWith('-')) i += XARGS_VALUE_FLAGS.has(args[i]!) ? 2 : 1;
  return args.slice(i);
}

function findInner(args: Args): Args {
  const at = args.findIndex((a) => a === '-exec' || a === '-execdir');
  if (at < 0) return [];
  const end = args.findIndex((a, i) => i > at && (a === ';' || a === '+'));
  return args.slice(at + 1, end < 0 ? undefined : end);
}

/** `git -C a -C b` is cumulative: each `-C` resolves against the one before it. */
function gitApplyWrites(args: Args, { scope }: Context): boolean {
  let dir: string | null = scope.cwd;
  let i = 0;
  for (; args[i] === '-C' || args[i] === '-c'; i += 2) {
    const next = args[i + 1];
    if (args[i] === '-C')
      dir = dir === null || next == null ? null : resolve(dir, expandHome(next));
  }
  return args[i] === 'apply' && writtenPlace(dir, scope);
}

/** Every operand is written; with none under xargs or find, the run-time operands are. */
const everyOperand =
  (valueFlags: ReadonlySet<string>): VerbRule =>
  (args, { scope, wrapped }) => {
    const files = operands(args, valueFlags);
    return files.length === 0 ? wrapped : files.some((a) => writtenPlace(a, scope));
  };

/** A `--target-directory` long option, or a GNU-unique prefix of it such as `--target-dir`. */
function targetLong(name: string): boolean {
  return name.length > 3 && TARGET_DIR_LONG.startsWith(name);
}

/** cp/mv/install's target directory (`-t DIR`, `-rt DIR`, `-tDIR`, `--target-dir[=]DIR`). */
function targetDir(args: Args): string | null | undefined {
  for (const [i, a] of args.entries()) {
    if (a === null) continue;
    const eq = a.indexOf('=');
    if (targetLong(eq < 0 ? a : a.slice(0, eq)))
      return eq < 0 ? (args[i + 1] ?? null) : a.slice(eq + 1);
    if (SHORT_TARGET_CLUSTER.test(a)) return args[i + 1] ?? null;
    const attached = SHORT_TARGET_ATTACHED.exec(a);
    if (attached) return attached[1];
  }
  return undefined;
}

/** `cp`/`mv`/`install` write into their target directory when given, else their last operand. */
const copyTarget: VerbRule = (args, { scope, wrapped }) => {
  const dir = targetDir(args);
  const target = dir === undefined ? operands(args, COPY_VALUE_FLAGS).at(-1) : dir;
  return target === undefined ? wrapped : writtenPlace(target, scope);
};
const shellScript: VerbRule = (args, { scope }) =>
  args[0] === '-c' && args[1] != null && scriptWrites(args[1], scope);

const VERB_RULES = new Map<string, VerbRule>([
  ['xargs', (args, context) => wrappedWrites(xargsInner(args), context)],
  ['find', (args, context) => wrappedWrites(findInner(args), context)],
  ['git', gitApplyWrites],
  ['patch', (args, { scope }) => writtenPlace(patchDir(args), scope)],
  ['sed', (args, { scope }) => hasFlag(args, SED_IN_PLACE) && inPlaceWrites(args, scope)],
  [
    'perl',
    (args, context) =>
      hasFlag(args, PERL_IN_PLACE)
        ? inPlaceWrites(args, context.scope)
        : interpreterWrites(args, context),
  ],
  ['tee', everyOperand(NO_VALUE_FLAGS)],
  ['touch', everyOperand(TOUCH_VALUE_FLAGS)],
  ['truncate', everyOperand(TRUNCATE_VALUE_FLAGS)],
  ['cp', copyTarget],
  ['mv', copyTarget],
  ['install', copyTarget],
  ['bash', shellScript],
  ['sh', shellScript],
  ['zsh', shellScript],
]);

function verbWrites(command: Args, context: Context): boolean {
  const name = basename(command[0] ?? '');
  const rule = VERB_RULES.get(name) ?? (INTERPRETER.test(name) ? interpreterWrites : undefined);
  return rule?.(command.slice(1), context) ?? false;
}

function commandWrites(command: Command, scope: Scope, filter: boolean): boolean {
  if (redirectsWrite(command.redirects, scope)) return true;
  const stdinScript = command.redirects.some((r) => STDIN_SCRIPT_REDIRECTS.has(r.operator));
  const words = [command.name, ...command.suffix].map(literal);
  return verbWrites(words, { scope, filter, stdinScript, wrapped: false });
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
