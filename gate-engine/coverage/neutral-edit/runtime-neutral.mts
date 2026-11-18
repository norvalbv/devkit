/** Is an edit runtime-neutral, so it can neither add executable lines nor change what a coverage run
 * measured? Parse-based and conservative: anything the parser cannot vouch for is NOT neutral. */
import { createRequire } from 'node:module';
import { git, JS_TS_SOURCE } from '../provenance.mts';

type Ts = typeof import('ts-morph').ts;

// Comments that pick the JSX factory or remap coverage: editing one changes runtime or mapping.
const RUNTIME_COMMENT = /@jsx|source(Mapping)?URL/;
const NULL_OID = /^0+$/;

let tsModule: Ts | undefined;
/** ts-morph takes seconds to load, so only a caller with a candidate file pays for it. */
function loadTs(): Ts {
  if (tsModule) return tsModule;
  const tsMorph: typeof import('ts-morph') = createRequire(import.meta.url)('ts-morph');
  tsModule = tsMorph.ts;
  return tsModule;
}

/** True when `runtimeNeutral` can judge this path at all. */
export const neutralEligible = (path: string): boolean => JS_TS_SOURCE.test(path);

/** The emitted JS without the residue an import-free module always gets; null on any diagnostic. */
function emitted(ts: Ts, path: string, text: string): string | null {
  const out = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      jsx: ts.JsxEmit.Preserve,
    },
  });
  if (out.diagnostics?.length) return null;
  return out.outputText
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    .replace(/^export \{\};$/gm, '')
    .replace(/^"use strict";$/gm, '')
    .trim();
}

/** Every line that could carry a runtime comment, so a pragma edit is never read as neutral. */
const runtimeCommentLines = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((l) => RUNTIME_COMMENT.test(l))
    .join('\n');

/** The code with every comment and all formatting removed. */
const printed = (ts: Ts, sf: import('ts-morph').ts.SourceFile): string =>
  ts.createPrinter({ removeComments: true }).printFile(sf);

/** A statement that can only ever erase to nothing; a cheap reject before the costly transpile. */
function erasesToNothing(ts: Ts, node: import('ts-morph').ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
  if (ts.isImportDeclaration(node)) return node.importClause?.isTypeOnly === true;
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  if (ts.isEmptyStatement(node)) return true;
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) === true;
}

/** `before` → `after` changes only comments or formatting, or both sides emit no runtime code at
 * all (types only). `before` null = the file is new. Every accepting path ends in a clean transpile. */
export function runtimeNeutral(path: string, before: string | null, after: string): boolean {
  if (!neutralEligible(path)) return false;
  const sides = before === null ? [after] : [before, after];
  if (before !== null && runtimeCommentLines(before) !== runtimeCommentLines(after)) return false;
  const ts = loadTs();
  const parsed = sides.map((s) => ts.createSourceFile(path, s, ts.ScriptTarget.Latest, false));
  const [first, second] = parsed.map((sf) => printed(ts, sf));
  const sameCode = second !== undefined && first === second;
  if (!sameCode && !parsed.every((sf) => sf.statements.every((st) => erasesToNothing(ts, st)))) {
    return false;
  }
  const emits = sides.map((s) => emitted(ts, path, s));
  if (emits.some((e) => e === null)) return false;
  return sameCode || emits.every((e) => e === '');
}

/** A blob's text, or null for a sentinel, an all-zero id or an object git does not have. */
export function blobText(top: string, oid: string | undefined): string | null {
  if (!oid || NULL_OID.test(oid) || !/^[0-9a-f]+$/.test(oid)) return null;
  try {
    return git(top, ['cat-file', 'blob', oid]);
  } catch {
    return null;
  }
}

/** The measured bytes and `after` differ only in runtime-neutral ways; unknown bytes never do. */
export function neutralDrift(
  top: string,
  path: string,
  measuredOid: string,
  after: string | null,
): boolean {
  const measured = blobText(top, measuredOid);
  return measured !== null && after !== null && runtimeNeutral(path, measured, after);
}
