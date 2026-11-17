/** Comment tokens in one source file, read with the TypeScript scanner so strings and JSX text never count. */
import { ts } from 'ts-morph';
const TRAILING_STRUCTURAL_PUNCTUATION = /^(?:[)\]};,.:]+|<\/(?:[A-Za-z][\w:.-]*|)>)+$/;
function lineStarts(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++)
        if (source.charCodeAt(i) === 10)
            starts.push(i + 1);
    return starts;
}
function lineAt(starts, position) {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
        const mid = (low + high) >>> 1;
        if ((starts[mid] ?? 0) <= position)
            low = mid;
        else
            high = mid;
    }
    return low + 1;
}
export function scanCommentTokens(source, extension) {
    const scriptKind = extension === 'jsx'
        ? ts.ScriptKind.JSX
        : extension === 'tsx'
            ? ts.ScriptKind.TSX
            : extension === 'js' || extension === 'mjs' || extension === 'cjs'
                ? ts.ScriptKind.JS
                : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(`staged.${extension}`, source, ts.ScriptTarget.Latest, true, scriptKind);
    const starts = lineStarts(source);
    const ranges = new Map();
    const collect = (items) => {
        for (const item of items ?? [])
            ranges.set(`${item.pos}:${item.end}`, item);
    };
    // Closed JSX text is not trivia; text an unclosed tag swallows to EOF is still scanned.
    const jsxText = [];
    const visit = (node) => {
        if (ts.isJsxText(node) && node.parent.end > node.end)
            jsxText.push([node.pos, node.end]);
        collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
        collect(ts.getTrailingCommentRanges(source, node.end));
        for (const child of node.getChildren(sourceFile))
            visit(child);
    };
    visit(sourceFile);
    return [...ranges.values()]
        .filter((range) => !jsxText.some(([pos, end]) => range.pos >= pos && range.pos < end))
        .sort((left, right) => left.pos - right.pos)
        .map((range) => {
        const start = range.pos;
        const end = range.end;
        const kind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? 'line' : 'block';
        const startLine = lineAt(starts, start);
        const endLine = lineAt(starts, Math.max(start, end - 1));
        const before = source.slice(starts[startLine - 1], start).trim();
        const after = source.slice(end, starts[endLine] ?? source.length).trim();
        const clearAfter = after.length === 0 || TRAILING_STRUCTURAL_PUNCTUATION.test(after);
        return {
            kind,
            startLine,
            endLine,
            text: source.slice(start, end),
            standalone: clearAfter && (before.length === 0 || (kind === 'block' && startLine < endLine)),
        };
    });
}
