/**
 * Decides devkit move's import rewrites per file at write time, by resolving each live specifier.
 * Why resolution-driven and style-preserving: docs/decisions/move-rewrites-via-ts-file-rename.md.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, relative, sep } from 'node:path';
import {
  Node,
  type NoSubstitutionTemplateLiteral,
  Project,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
  ts,
} from 'ts-morph';
import { reviewPathWithin } from '../ship/review/runtime-paths.mts';

/** A wildcard tsconfig path alias: its specifier prefix and the absolute directory it maps to. */
export interface Alias {
  prefix: string;
  root: string;
}
/** One filesystem-level relocation; a directory is a single move covering its descendants. */
export interface PathMove {
  oldAbs: string;
  newAbs: string;
}
/** A specifier that must resolve to `expected` after the move. */
export interface ResolutionCheck {
  spec: string;
  expected: string;
}
/** Everything a rewrite needs: how paths resolve before the move and after it. */
export interface MoveContext {
  options: ts.CompilerOptions;
  aliases: Alias[];
  moves: PathMove[];
  before: ts.ModuleResolutionHost;
  after: ts.ModuleResolutionHost;
  scratch: Project;
}
/** One file's rewrite: new text (null when nothing changed) and what must resolve afterwards. */
export interface SourceRewrite {
  text: string | null;
  rewrites: number;
  /** Relative specifiers in a moved file that did not resolve before the move, left as written. */
  unresolved: number;
  checks: ResolutionCheck[];
}
interface SpecifierHandle {
  get: () => string;
  set: (v: string) => void;
}

const MODULE_CALLEES = new Set([
  'import',
  'require',
  'vi.mock',
  'vi.doMock',
  'vi.unmock',
  'vi.doUnmock',
  'vi.importActual',
  'vi.importMock',
  'jest.mock',
  'jest.doMock',
  'jest.unmock',
  'jest.requireActual',
  'jest.requireMock',
  'require.resolve',
]);
export const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MODULE_EXT_RE = /(\.d\.(ts|mts|cts)|\.(ts|tsx|mts|cts|js|jsx|mjs|cjs))$/;
const RELATIVE_RE = /^\.\.?(\/|$)/;
const WRITTEN_INDEX_RE = /(^|\/)index$/;

const toPosix = (p: string): string => p.replaceAll('\\', '/');

/** The callee as `vi.mock`, however it is spaced, commented or parenthesized; else null. */
function calleeName(expr: Node): string | null {
  let e = expr;
  while (Node.isParenthesizedExpression(e)) e = e.getExpression();
  if (Node.isIdentifier(e) || e.getKind() === SyntaxKind.ImportKeyword) return e.getText();
  if (!Node.isPropertyAccessExpression(e)) return null;
  let owner: Node = e.getExpression();
  while (Node.isParenthesizedExpression(owner)) owner = owner.getExpression();
  return Node.isIdentifier(owner) ? `${owner.getText()}.${e.getName()}` : null;
}

type Literal = StringLiteral | NoSubstitutionTemplateLiteral;
const handle = (lit: Literal): SpecifierHandle => ({
  get: () => lit.getLiteralValue(),
  set: (v: string) => lit.setLiteralValue(v),
});

/** The leftmost identifier of a callee: `require` for `require`, `(require).resolve` and kin. */
function rootIdentifier(expr: Node): Node {
  let e = expr;
  while (Node.isParenthesizedExpression(e) || Node.isPropertyAccessExpression(e))
    e = e.getExpression();
  return e;
}

/** A `require` that names a local binding (a parameter, say) rather than the module loader. */
function shadowed(callee: Node): boolean {
  const decls = callee.getSymbol()?.getDeclarations() ?? [];
  return decls.some((d) => d.getSourceFile() === callee.getSourceFile());
}

/** Every editable module specifier in a file, in document order (stable across text edits). */
export function specifierHandles(sf: SourceFile): SpecifierHandle[] {
  const out: SpecifierHandle[] = [];
  for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
    const lit = d.getModuleSpecifier();
    if (lit) out.push(handle(lit));
  }
  for (const d of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = d.getModuleReference();
    const lit = Node.isExternalModuleReference(ref) ? ref.getExpression() : undefined;
    if (lit && Node.isStringLiteral(lit)) out.push(handle(lit));
  }
  for (const t of sf.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const arg = t.getArgument();
    const lit = Node.isLiteralTypeNode(arg) ? arg.getLiteral() : undefined;
    if (lit && Node.isStringLiteral(lit)) out.push(handle(lit));
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = calleeName(call.getExpression());
    if (!callee || !MODULE_CALLEES.has(callee)) continue;
    if (callee.split('.')[0] === 'require' && shadowed(rootIdentifier(call.getExpression())))
      continue;
    const arg = call.getArguments()[0];
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)))
      out.push(handle(arg));
  }
  return out;
}

/**
 * Module resolution over a view of the tree: the planned file set, backed by the real disk through
 * `disk`, which maps a path in this view to where it lives now (null: it cannot exist in the view).
 */
function viewHost(
  files: Iterable<string>,
  disk: (p: string) => string | null,
): ts.ModuleResolutionHost {
  const fileSet = new Set(files);
  const dirs = new Set<string>();
  for (const f of fileSet) {
    let d = dirname(f);
    while (!dirs.has(d)) {
      dirs.add(d);
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }
  const onDisk = (p: string, probe: (q: string) => boolean) => {
    const real = disk(p);
    return real != null && probe(real);
  };
  return {
    fileExists: (p) => fileSet.has(p) || onDisk(p, (q) => ts.sys.fileExists(q)),
    directoryExists: (d) => dirs.has(d) || onDisk(d, (q) => ts.sys.directoryExists(q)),
    readFile: (p) => {
      const real = disk(p);
      return real == null ? undefined : ts.sys.readFile(real);
    },
  };
}

function resolveWith(
  spec: string,
  file: string,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): string | null {
  const hit = ts.resolveModuleName(spec, file, options, host).resolvedModule;
  return hit && !hit.isExternalLibraryImport ? hit.resolvedFileName : null;
}

/** The inverse of mapPath: where a post-move path sat before the move. */
export function unmapPath(p: string, moves: PathMove[]): string {
  return mapPath(
    p,
    moves.map((m) => ({ oldAbs: m.newAbs, newAbs: m.oldAbs })),
  );
}

export function mapPath(p: string, moves: PathMove[]): string {
  for (const m of moves) {
    if (p === m.oldAbs) return m.newAbs;
    if (p.startsWith(m.oldAbs + sep)) return m.newAbs + p.slice(m.oldAbs.length);
  }
  return p;
}

export type SpecStyle = 'relative' | 'alias';

/** The style sc-3016's alias wall forces on a touched specifier (never `@/../`), or null to keep it. */
export function forcedStyle(
  orig: string,
  importer: string,
  before: string,
  after: string,
  aliases: Alias[],
): SpecStyle | null {
  if (!RELATIVE_RE.test(orig)) {
    const written = aliases.filter((a) => orig.startsWith(a.prefix));
    const reachable = written.some((a) => reviewPathWithin(a.root, importer));
    return written.length && !reachable ? 'relative' : null;
  }
  const inRoot = (p: string) => aliases.some((a) => reviewPathWithin(a.root, p));
  return inRoot(importer) && !inRoot(before) && inRoot(after) ? 'alias' : null;
}

/** Spell `target` from `importer` in `orig`'s style (relative / alias, index, extension), or `style`. */
export function respell(
  orig: string,
  importer: string,
  target: string,
  aliases: Alias[],
  style?: SpecStyle,
): string {
  const writtenExt = orig.match(MODULE_EXT_RE)?.[0] ?? '';
  let mod = target.replace(MODULE_EXT_RE, '');
  const writtenIndex = WRITTEN_INDEX_RE.test(orig.replace(MODULE_EXT_RE, ''));
  if (basename(mod) === 'index' && !writtenIndex) mod = dirname(mod);
  const relativeSpec = () => {
    const rel = toPosix(relative(dirname(importer), mod));
    if (rel === '') return '.';
    return (rel.startsWith('.') ? rel : `./${rel}`) + writtenExt;
  };
  if (style === 'relative' || (!style && RELATIVE_RE.test(orig))) return relativeSpec();
  const covers = (a: Alias) => reviewPathWithin(a.root, mod);
  // A written alias keeps its prefix or becomes relative; only a forced switch may pick one.
  const candidates = style === 'alias' ? aliases : aliases.filter((a) => orig.startsWith(a.prefix));
  // The longest written prefix is the one the author used: `@/x` is `@/`, not the bare `*` alias.
  const longest = Math.max(...candidates.map((a) => a.prefix.length), 0);
  const alias = candidates
    .filter((a) => style === 'alias' || a.prefix.length === longest)
    .find(covers);
  if (!alias) return relativeSpec();
  return alias.prefix + toPosix(relative(alias.root, mod)) + writtenExt;
}

export function moveContext(
  options: ts.CompilerOptions,
  aliases: Alias[],
  moves: PathMove[],
  files: string[],
  /** Moved non-source files (JSON, assets) that specifiers may still resolve to. */
  targets: string[] = [],
  /** Whether the disk already shows the post-move tree (a real run) or still the old one (dry run). */
  diskIsMoved = false,
): MoveContext {
  const all = [...files, ...targets];
  const under = (p: string, roots: string[]) => roots.some((r) => reviewPathWithin(r, p));
  const olds = moves.map((m) => m.oldAbs);
  const news = moves.map((m) => m.newAbs);
  // Before the move a destination did not exist (preflight refuses one that does), and after it a
  // source is vacated; everything else is the same file, wherever the disk currently keeps it.
  const beforeDisk = (p: string) =>
    !diskIsMoved ? p : under(p, news) && !under(p, olds) ? null : mapPath(p, moves);
  const afterDisk = (p: string) =>
    diskIsMoved ? p : under(p, olds) && !under(p, news) ? null : unmapPath(p, moves);
  return {
    options,
    aliases,
    moves,
    before: viewHost(all, beforeDisk),
    after: viewHost(
      all.map((f) => mapPath(f, moves)),
      afterDisk,
    ),
    scratch: new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true }),
  };
}

/** Rewrite the live `text` of the file at pre-move `virtualPath`: respell each specifier whose
 * importer or target moved, only if it no longer reaches that target. */
export function rewriteSource(text: string, virtualPath: string, ctx: MoveContext): SourceRewrite {
  const { options, aliases, moves } = ctx;
  const finalPath = mapPath(virtualPath, moves);
  const moved = finalPath !== virtualPath;
  const sf = ctx.scratch.createSourceFile(finalPath, text, { overwrite: true });
  const out: SourceRewrite = { text: null, rewrites: 0, unresolved: 0, checks: [] };
  for (const h of specifierHandles(sf)) {
    const spec = h.get();
    const before = resolveWith(spec, virtualPath, options, ctx.before);
    if (before == null) {
      if (moved && RELATIVE_RE.test(spec)) out.unresolved++;
      continue;
    }
    const expected = mapPath(before, moves);
    if (!moved && expected === before) continue; // neither end moved: the move cannot break it
    const style = forcedStyle(spec, finalPath, before, expected, aliases);
    let next = spec;
    if (style) next = respell(spec, finalPath, expected, aliases, style);
    else if (resolveWith(spec, finalPath, options, ctx.after) !== expected)
      next = respell(spec, finalPath, expected, aliases);
    // An alias can land on an earlier fallback target; relative always names the file itself.
    if (next !== spec && resolveWith(next, finalPath, options, ctx.after) !== expected)
      next = respell(spec, finalPath, expected, aliases, 'relative');
    if (next !== spec) {
      h.set(next);
      out.rewrites++;
    }
    out.checks.push({ spec: next, expected });
  }
  if (out.rewrites) out.text = sf.getFullText();
  ctx.scratch.removeSourceFile(sf);
  return out;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // gone or unreadable: compare lexically, which reports it as dangling
  }
}

/** Specifiers that, on disk after the move, do not resolve where the plan says they should. */
export function findDangling(
  checks: Map<string, ResolutionCheck[]>,
  optionsOf: (file: string) => ts.CompilerOptions,
): { file: string; spec: string }[] {
  const out: { file: string; spec: string }[] = [];
  for (const [file, list] of checks) {
    for (const c of list) {
      const hit = ts.resolveModuleName(c.spec, file, optionsOf(file), ts.sys).resolvedModule;
      const actual = hit?.resolvedFileName;
      const ok = actual != null && canonical(actual) === canonical(c.expected);
      if (!ok) out.push({ file, spec: c.spec });
    }
  }
  return out;
}
