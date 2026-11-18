import { defineRule } from "#oxlint-plugins";
const FORBIDDEN_SYMBOL_NAME = "shape";
function containsForbiddenSymbolName(name) {
    return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}
function outermostQualifiedName(name) {
    let outermost = name;
    while (outermost.parent?.type === "TSQualifiedName")
        outermost = outermost.parent;
    return outermost;
}
/** Return whether a qualified name is part of a dotted namespace declaration such as `namespace A.B {}`. */
function isNamespaceDeclarationName(name) {
    return outermostQualifiedName(name).parent?.type === "TSModuleDeclaration";
}
/** Return whether a qualified name is the member path of an import type such as `import("m").A.B`. */
function isImportTypeQualifierName(name) {
    const outermost = outermostQualifiedName(name);
    const owner = outermost.parent;
    return owner?.type === "TSImportType" && owner.qualifier === outermost;
}
/** Return whether an identifier names a statically accessed member owned by another value or namespace. */
function isBorrowedMemberName(node) {
    const parent = node.parent;
    if (parent === null)
        return false;
    if (parent.type === "MemberExpression")
        return parent.property === node && parent.computed === false;
    if (parent.type === "TSQualifiedName") {
        if (parent.right === node)
            return !isNamespaceDeclarationName(parent);
        return isImportTypeQualifierName(parent);
    }
    if (parent.type === "TSImportType")
        return parent.qualifier === node;
    return parent.type === "JSXMemberExpression" && parent.property === node;
}
/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description: 'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
        },
        messages: {
            forbiddenSymbolName: 'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
        },
    },
    createOnce(context) {
        const reportForbiddenSymbolName = (node) => {
            if (!containsForbiddenSymbolName(node.name) || isBorrowedMemberName(node))
                return;
            context.report({
                node,
                messageId: "forbiddenSymbolName",
                data: { name: node.name },
            });
        };
        return {
            Identifier: reportForbiddenSymbolName,
            PrivateIdentifier: reportForbiddenSymbolName,
            JSXIdentifier: reportForbiddenSymbolName,
        };
    },
});
