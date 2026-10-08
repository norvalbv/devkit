/**
 * git-pathspec gate: flags an unmarked variable reaching a pathspec-reading git subcommand after
 * `--`, so a filename like `a[b]` cannot also match `ab`.
 *
 * A call already in literal mode (`--literal-pathspecs`, directly or via its wrapper) must not also
 * carry `:(literal)`: git reads the prefix as filename text and matches nothing (`mixed`).
 *
 * Reads worktree text, like `bun run lint`. Not seen: argv built by `args.push('--', …)`, and git
 * reached through `set -- git …` or a supervisor's `-- git`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse } from 'unbash';
import {
  isJsonInteger,
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from '../gate-engine/comment-firewall/types.mts';

export interface Hit {
  file: string;
  line: number;
  sub: string;
  arg: string;
  kind: 'raw' | 'mixed';
}

/** Subcommands whose post-`--` operands are pathspecs that glob; mv, ls-tree, check-ignore etc. do not. */
const PATHSPEC_SUBS = new Set(
  'add rm reset restore checkout status diff log ls-files commit grep clean stash'.split(' '),
);
const SPAWNERS = new Set(['spawnSync', 'execFileSync', 'spawn', 'execFile']);
const DECLARERS = new Set(['local', 'declare', 'typeset', 'readonly', 'export']);
const SHELL_MARKER = /#\s*pathspec:\s*\S/;
const TS_MARKER = /\/\/\s*pathspec:\s*\S/;
const LITERAL_ENV = /GIT_LITERAL_PATHSPECS['"]?\s*[:=]\s*['"]?1/;
const LITERAL_MAGIC = /^:\([^)]*\bliteral\b/;
const ARRAY_REF = /^\$\{(\w+)\[@\]\}$|^\$\{(\w+)\[@\]\+"\$\{\2\[@\]\}"\}$/;
const DECLARED_ARRAY = /^(\w+)\+?=\((.*)\)$/s;

type Safety = 'const' | 'magic' | 'raw';

function lineAt(text: string, pos: number): number {
  return text.slice(0, pos).split('\n').length;
}

/** A `pathspec: <reason>` marker on the hit's line or the line above (where a formatter puts it). */
function marked(text: string, line: number, marker: RegExp): boolean {
  const lines = text.split('\n');
  return marker.test(lines[line - 1] ?? '') || marker.test(lines[line - 2] ?? '');
}

/** Index of the git subcommand: skips `-C <dir>`, `-c <k=v>` and any other leading flag. */
function subcommandIndex(words: string[]): number {
  let i = 0;
  while (i < words.length && words[i]!.startsWith('-'))
    i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
  return i;
}

function walk(node: JsonValue, visit: (node: JsonObject) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isJsonObject(node)) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

/** The unbash AST as plain JSON: the round-trip materialises its lazy `parts`/`script` getters. */
function shellAst(text: string): JsonValue {
  return parseJson(JSON.stringify(parse(text)));
}

function wordValue(word: JsonValue | undefined): string {
  return isJsonObject(word) && isJsonString(word.value) ? word.value : '';
}

function wordList(words: JsonValue | undefined): JsonObject[] {
  return Array.isArray(words) ? words.filter(isJsonObject) : [];
}

function wordValues(words: JsonValue | undefined): string[] {
  return wordList(words).map(wordValue);
}

function recordArray(arrays: Map<string, boolean[]>, name: string, literal: boolean): void {
  arrays.set(name, [...(arrays.get(name) ?? []), literal]);
}

/** Whether every element of a declared array body is `:(…literal…)`-prefixed; quotes are stripped. */
function declaredLiteral(body: string): boolean | null {
  const items = body.trim().split(/\s+/).filter(Boolean);
  if (items.length === 0) return null;
  return items.every((item) => LITERAL_MAGIC.test(item.replace(/^["']/, '')));
}

/** Every non-empty assignment to each shell array, across all files: `true` when literal-prefixed. */
export function collectShellArrays(texts: string[]): Map<string, boolean[]> {
  const arrays = new Map<string, boolean[]>();
  for (const text of texts) {
    walk(shellAst(text), (node) => {
      const elements = wordValues(node.array);
      if (node.type === 'Assignment' && isJsonString(node.name) && elements.length > 0) {
        recordArray(
          arrays,
          node.name,
          elements.every((v) => LITERAL_MAGIC.test(v)),
        );
      }
      if (node.type !== 'Command') return;
      const head = wordValue(node.name);
      const words = wordValues(node.suffix);
      if (DECLARERS.has(head)) {
        for (const word of words) {
          const match = DECLARED_ARRAY.exec(word);
          const literal = match ? declaredLiteral(match[2]!) : null;
          if (match && literal !== null) recordArray(arrays, match[1]!, literal);
        }
      }
      if (
        head === 'mapfile' ||
        head === 'readarray' ||
        (head === 'read' && words.some((w) => /^-\w*a/.test(w)))
      ) {
        for (const word of words.filter((w) => /^\w+$/.test(w))) recordArray(arrays, word, false);
      }
    });
  }
  return arrays;
}

function shellArgSafety(arg: string, arrays: Map<string, boolean[]>): Safety {
  if (arg.startsWith(':')) return 'magic';
  if (!arg.includes('$')) return 'const';
  const ref = ARRAY_REF.exec(arg);
  const assigned = ref ? arrays.get(ref[1] ?? ref[2]!) : undefined;
  return assigned?.length && assigned.every(Boolean) ? 'magic' : 'raw';
}

/** Hits in one shell file; `arrays` comes from collectShellArrays over every scanned shell file. */
export function scanShell(text: string, file: string, arrays: Map<string, boolean[]>): Hit[] {
  const hits: Hit[] = [];
  walk(shellAst(text), (node) => {
    if (node.type !== 'Command' || wordValue(node.name) !== 'git') return;
    const suffix = wordList(node.suffix);
    const words = suffix.map(wordValue);
    const at = subcommandIndex(words);
    const sub = words[at] ?? '';
    const dashes = words.indexOf('--', at);
    if (!PATHSPEC_SUBS.has(sub) || dashes < 0) return;
    const literalMode =
      words.slice(0, at).includes('--literal-pathspecs') ||
      wordList(node.prefix).some(
        (p) => p.name === 'GIT_LITERAL_PATHSPECS' && wordValue(p.value) === '1',
      );
    for (const word of suffix.slice(dashes + 1)) {
      const arg = wordValue(word);
      const line = lineAt(text, isJsonInteger(word.pos) ? word.pos : 0);
      const safety = shellArgSafety(arg, arrays);
      const kind = classify(safety, literalMode, marked(text, line, SHELL_MARKER));
      if (kind) hits.push({ file, line, sub, arg, kind });
    }
  });
  return hits;
}

function classify(safety: Safety, literalMode: boolean, marked: boolean): Hit['kind'] | null {
  if (literalMode) return safety === 'magic' ? 'mixed' : null;
  return safety === 'raw' && !marked ? 'raw' : null;
}

function worst(parts: Safety[]): Safety {
  if (parts.includes('raw')) return 'raw';
  return parts.includes('magic') ? 'magic' : 'const';
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
}

/** Every same-file declaration of `name`: a const initializer or a function body. */
function declarations(sf: ts.SourceFile, name: string): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found.push(node.initializer ?? node);
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
    else if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name)
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function returned(fn: ts.Node): ts.Expression[] {
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !ts.isBlock(fn.body))
    return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    if (!ts.isFunctionLike(node) || node === fn) ts.forEachChild(node, visit);
  };
  visit(fn);
  return out;
}

/** What a function-valued expression yields when called: its return expressions' worst safety. */
function mapperSafety(sf: ts.SourceFile, fn: ts.Expression, depth: number): Safety {
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    return worst(returned(fn).map((e) => tsSafety(sf, e, depth + 1)));
  }
  if (!ts.isIdentifier(fn) || depth > 4) return 'raw';
  const decls = declarations(sf, fn.text);
  if (decls.length === 0) return 'raw';
  return worst(
    decls.map((d) =>
      ts.isParameter(d) ? 'raw' : worst(returned(d).map((e) => tsSafety(sf, e, depth + 1))),
    ),
  );
}

/** How an argv element resolves within its own file; anything unresolved is `raw`. */
export function tsSafety(sf: ts.SourceFile, expr: ts.Expression, depth = 0): Safety {
  if (depth > 4) return 'raw';
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text.startsWith(':') ? 'magic' : 'const';
  }
  if (ts.isTemplateExpression(expr)) return expr.head.text.startsWith(':') ? 'magic' : 'raw';
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSpreadElement(expr)) {
    return tsSafety(sf, expr.expression, depth);
  }
  if (ts.isArrayLiteralExpression(expr))
    return worst(expr.elements.map((e) => tsSafety(sf, e, depth + 1)));
  if (ts.isConditionalExpression(expr)) {
    return worst([tsSafety(sf, expr.whenTrue, depth + 1), tsSafety(sf, expr.whenFalse, depth + 1)]);
  }
  if (ts.isIdentifier(expr)) {
    const decls = declarations(sf, expr.text);
    if (decls.length === 0) return 'raw';
    return worst(
      decls.map((d) =>
        ts.isParameter(d) || !ts.isExpression(d) ? 'raw' : tsSafety(sf, d, depth + 1),
      ),
    );
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      if (callee.name.text === 'map' && expr.arguments[0])
        return mapperSafety(sf, expr.arguments[0], depth);
      if (['filter', 'slice', 'sort', 'concat'].includes(callee.name.text)) {
        return worst(
          [
            callee.expression,
            ...expr.arguments.filter((a) => callee.name.text === 'concat' && a),
          ].map((e) => tsSafety(sf, e, depth + 1)),
        );
      }
      return 'raw';
    }
    return mapperSafety(sf, callee, depth);
  }
  return 'raw';
}

function literalModeText(text: string): boolean {
  return text.includes("'--literal-pathspecs'") || LITERAL_ENV.test(text);
}

/** The callee's own definition text: same file, else one relative-import hop. */
function wrapperText(
  sf: ts.SourceFile,
  file: string,
  name: string,
  load: (path: string) => string | undefined,
): string {
  const local = declarations(sf, name).filter((d) => !ts.isParameter(d));
  if (local.length > 0) return local.map((d) => d.getText(sf)).join('\n');
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const named = stmt.importClause?.namedBindings;
    if (!spec.startsWith('.') || !named || !ts.isNamedImports(named)) continue;
    const bound = named.elements.find((el) => el.name.text === name);
    if (!bound) continue;
    const target = resolve(dirname(file), spec);
    const source = load(target);
    if (source === undefined) return '';
    const other = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true);
    const original = bound.propertyName?.text ?? name;
    return declarations(other, original)
      .filter((d) => !ts.isParameter(d))
      .map((d) => d.getText(other))
      .join('\n');
  }
  return '';
}

/** Hits in one TS file; `load` reads an imported module so a literal-mode wrapper is recognised. */
export function scanTs(
  text: string,
  file: string,
  load: (path: string) => string | undefined,
): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    const first = node.arguments[0];
    const spawned =
      SPAWNERS.has(name) &&
      first !== undefined &&
      ts.isStringLiteral(first) &&
      first.text === 'git';
    if (!spawned && !/git/i.test(name)) return;
    const optionsLiteral = node.arguments
      .slice(1)
      .some((a) => !ts.isArrayLiteralExpression(a) && LITERAL_ENV.test(a.getText(sf)));
    const wrapperLiteral = !spawned && literalModeText(wrapperText(sf, file, name, load));
    for (const argv of node.arguments.filter(ts.isArrayLiteralExpression)) {
      const consts = argv.elements.map((e) => (ts.isStringLiteral(e) ? e.text : null));
      const at = subcommandIndex(consts.map((c) => c ?? ''));
      const sub = consts[at] ?? '';
      const dashes = consts.indexOf('--', at);
      if (!PATHSPEC_SUBS.has(sub) || dashes < 0) continue;
      const literalMode =
        optionsLiteral || wrapperLiteral || consts.slice(0, at).includes('--literal-pathspecs');
      for (const el of argv.elements.slice(dashes + 1)) {
        const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1;
        const kind = classify(tsSafety(sf, el), literalMode, marked(text, line, TS_MARKER));
        if (kind) hits.push({ file, line, sub, arg: el.getText(sf), kind });
      }
    }
  };
  visit(sf);
  return hits;
}

const ROOTS = ['cli', 'gate-engine', 'agents-hooks', 'scripts'];

function trackedSources(root: string): string[] {
  const listed = execFileSync(
    'git',
    // pathspec: deliberate globs over the scanned roots
    ['ls-files', '-z', '--', ...ROOTS.flatMap((r) => [`${r}/*.sh`, `${r}/*.mts`])],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return listed
    .split('\0')
    .filter((f) => f && !f.includes('__tests__/') && existsSync(resolve(root, f)));
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export function main(root = process.cwd()): number {
  const sources = trackedSources(root).map((file) => ({
    file,
    text: readFileSync(resolve(root, file), 'utf8'),
  }));
  const relevant = sources.filter((s) => s.text.includes('git'));
  const shell = relevant.filter((s) => s.file.endsWith('.sh'));
  const arrays = collectShellArrays(shell.map((s) => s.text));
  const hits = [
    ...shell.flatMap((s) => scanShell(s.text, s.file, arrays)),
    ...relevant
      .filter((s) => s.file.endsWith('.mts'))
      .flatMap((s) =>
        scanTs(s.text, resolve(root, s.file), readIfExists).map((h) => ({ ...h, file: s.file })),
      ),
  ];
  if (hits.length === 0) return 0;
  for (const h of hits)
    console.error(
      `${h.file}:${h.line}  ${h.kind === 'mixed' ? 'mixed literal mode' : 'raw pathspec'}  git ${h.sub} -- ${h.arg}`,
    );
  console.error(
    `git-pathspec: ${hits.length} site(s). raw: prefix the argument with ':(literal)' (':(top,literal)' if cwd may not be the repo root) or add a 'pathspec: <reason>' comment on that line or the line above.\n` +
      "mixed: the call already runs with --literal-pathspecs, which reads ':(literal)' as filename text — drop the prefix.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
