/** Is an edit runtime-neutral, so it can neither add executable lines nor change what a coverage run
 * measured? Parse-based and conservative: anything the parser cannot vouch for is NOT neutral. */
import { createRequire } from 'node:module';
import { JS_TS_SOURCE_RE } from '../../config-source-matchers.mjs';
import { git } from '../provenance.mjs';
// Comments that pick the JSX factory, remap coverage or tell it what to skip: editing one is not neutral.
const RUNTIME_COMMENT = /@jsx|source(Mapping)?URL|\b(istanbul|c8|v8)\s+ignore\b/;
const NULL_OID = /^0+$/;
let tsModule;
/** ts-morph takes seconds to load, so only a caller with a candidate file pays for it. */
function loadTs() {
    if (tsModule)
        return tsModule;
    const tsMorph = createRequire(import.meta.url)('ts-morph');
    tsModule = tsMorph.ts;
    return tsModule;
}
/** True when `runtimeNeutral` can judge this path at all. */
export const neutralEligible = (path) => JS_TS_SOURCE_RE.test(path);
/** The emitted JS without the residue an import-free module always gets; null on any diagnostic. */
function emitted(ts, path, text) {
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
    if (out.diagnostics?.length)
        return null;
    return out.outputText
        .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
        .replace(/^export \{\};$/gm, '')
        .replace(/^"use strict";$/gm, '')
        .trim();
}
function anchorComments(ts, walk, ranges) {
    for (const range of ranges ?? []) {
        const comment = walk.text.slice(range.pos, range.end);
        if (walk.seen.has(range.pos) || !RUNTIME_COMMENT.test(comment))
            continue;
        walk.seen.add(range.pos);
        walk.anchors.push(`${walk.tokens}:${comment.replace(/\s+/g, ' ')}`);
    }
}
/** Visit code tokens in order; JSDoc nodes are comments, read through the comment ranges. */
function walkTokens(ts, sf, node, walk) {
    if (ts.isJSDoc(node))
        return;
    const children = node.getChildren(sf);
    if (children.length > 0) {
        for (const child of children)
            walkTokens(ts, sf, child, walk);
        return;
    }
    anchorComments(ts, walk, ts.getLeadingCommentRanges(walk.text, node.getFullStart()));
    walk.tokens += 1;
    anchorComments(ts, walk, ts.getTrailingCommentRanges(walk.text, node.end));
}
/** Each runtime comment with the count of code tokens before it, so moving one is a change too. */
function runtimeCommentAnchors(ts, path, text) {
    if (!RUNTIME_COMMENT.test(text))
        return '';
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const walk = { text, tokens: 0, seen: new Set(), anchors: [] };
    walkTokens(ts, sf, sf, walk);
    return walk.anchors.join('\n');
}
/** The code with every comment and all formatting removed. */
const printed = (ts, sf) => ts.createPrinter({ removeComments: true }).printFile(sf);
/** A statement that can only ever erase to nothing; a cheap reject before the costly transpile. */
function erasesToNothing(ts, node) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
        return true;
    if (ts.isImportDeclaration(node))
        return node.importClause?.isTypeOnly === true;
    if (ts.isExportDeclaration(node))
        return node.isTypeOnly;
    if (ts.isEmptyStatement(node))
        return true;
    if (!ts.canHaveModifiers(node))
        return false;
    return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) === true;
}
/** `before` → `after` changes only comments or formatting, or both sides emit no runtime code at
 * all (types only). `before` null = the file is new. Every accepting path ends in a clean transpile. */
export function runtimeNeutral(path, before, after) {
    if (!neutralEligible(path))
        return false;
    const sides = before === null ? [after] : [before, after];
    const ts = loadTs();
    if (before !== null &&
        runtimeCommentAnchors(ts, path, before) !== runtimeCommentAnchors(ts, path, after)) {
        return false;
    }
    const parsed = sides.map((s) => ts.createSourceFile(path, s, ts.ScriptTarget.Latest, false));
    const [first, second] = parsed.map((sf) => printed(ts, sf));
    const sameCode = second !== undefined && first === second;
    if (!sameCode && !parsed.every((sf) => sf.statements.every((st) => erasesToNothing(ts, st)))) {
        return false;
    }
    const emits = sides.map((s) => emitted(ts, path, s));
    if (emits.some((e) => e === null))
        return false;
    return sameCode || emits.every((e) => e === '');
}
/** A blob's text, or null for a sentinel, an all-zero id or an object git does not have. */
export function blobText(top, oid) {
    if (!oid || NULL_OID.test(oid) || !/^[0-9a-f]+$/.test(oid))
        return null;
    try {
        return git(top, ['cat-file', 'blob', oid]);
    }
    catch {
        return null;
    }
}
/** The measured bytes and `after` differ only in runtime-neutral ways; unknown bytes never do. */
export function neutralDrift(top, path, measuredOid, after) {
    const measured = blobText(top, measuredOid);
    return measured !== null && after !== null && runtimeNeutral(path, measured, after);
}
