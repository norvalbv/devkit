"use strict";
module.exports = {
    meta: {
        docs: {
            description: "enforce camelcase naming convention",
            category: "Stylistic Issues",
            recommended: false
        },
        schema: [
            {
                type: "object",
                properties: {
                    properties: {
                        enum: ["always", "never"]
                    }
                },
                additionalProperties: false
            }
        ]
    },
    create(context) {
        const reported = [];
        const ALLOWED_PARENT_TYPES = new Set(["CallExpression", "NewExpression"]);
        function isUnderscored(name) {
            return name.indexOf("_") > -1 && name !== name.toUpperCase();
        }
        function report(node) {
            if (reported.indexOf(node) < 0) {
                reported.push(node);
                context.report({ node, message: "Identifier '{{name}}' is not in camel case.", data: { name: node.name } });
            }
        }
        const options = context.options[0] || {};
        let properties = options.properties || "";
        if (properties !== "always" && properties !== "never") {
            properties = "always";
        }
        return {
            Identifier(node) {
                const name = node.name.replace(/^_+|_+$/g, ""), effectiveParent = (node.parent.type === "MemberExpression") ? node.parent.parent : node.parent;
                if (node.parent.type === "MemberExpression") {
                    if (properties === "never") {
                        return;
                    }
                    if (node.parent.object.type === "Identifier" && node.parent.object.name === node.name && isUnderscored(name)) {
                        report(node);
                    }
                    else if (effectiveParent.type === "AssignmentExpression" && isUnderscored(name) && (effectiveParent.right.type !== "MemberExpression" || effectiveParent.left.type === "MemberExpression" && effectiveParent.left.property.name === node.name)) {
                        report(node);
                    }
                }
                else if (node.parent.type === "Property" || node.parent.type === "AssignmentPattern") {
                    if (node.parent.parent && node.parent.parent.type === "ObjectPattern") {
                        if (node.parent.shorthand && node.parent.value.left && isUnderscored(name)) {
                            report(node);
                        }
                        if (node.parent.key === node && node.parent.value !== node) {
                            return;
                        }
                        if (node.parent.value.name && isUnderscored(name)) {
                            report(node);
                        }
                    }
                    if (properties === "never") {
                        return;
                    }
                    if (isUnderscored(name) && !ALLOWED_PARENT_TYPES.has(effectiveParent.type) && !(node.parent.right === node)) {
                        report(node);
                    }
                }
                else if (["ImportSpecifier", "ImportNamespaceSpecifier", "ImportDefaultSpecifier"].indexOf(node.parent.type) >= 0) {
                    if (node.parent.local && node.parent.local.name === node.name && isUnderscored(name)) {
                        report(node);
                    }
                }
                else if (isUnderscored(name) && !ALLOWED_PARENT_TYPES.has(effectiveParent.type)) {
                    report(node);
                }
            }
        };
    }
};
