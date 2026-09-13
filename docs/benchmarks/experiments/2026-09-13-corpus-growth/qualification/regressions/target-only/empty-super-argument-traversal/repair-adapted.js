"use strict";
function isSingleSuperCall(body) {
    return (body.length === 1 &&
        body[0].type === "ExpressionStatement" &&
        body[0].expression.type === "CallExpression" &&
        body[0].expression.callee.type === "Super");
}
function isSimple(node) {
    return node.type === "Identifier" || node.type === "RestElement";
}
function isSpreadArguments(superArgs) {
    return (superArgs.length === 1 &&
        superArgs[0].type === "SpreadElement" &&
        superArgs[0].argument.type === "Identifier" &&
        superArgs[0].argument.name === "arguments");
}
function isValidIdentifierPair(ctorParam, superArg) {
    return (ctorParam.type === "Identifier" &&
        superArg.type === "Identifier" &&
        ctorParam.name === superArg.name);
}
function isValidRestSpreadPair(ctorParam, superArg) {
    return (ctorParam.type === "RestElement" &&
        superArg.type === "SpreadElement" &&
        isValidIdentifierPair(ctorParam.argument, superArg.argument));
}
function isValidPair(ctorParam, superArg) {
    return (isValidIdentifierPair(ctorParam, superArg) ||
        isValidRestSpreadPair(ctorParam, superArg));
}
function isPassingThrough(ctorParams, superArgs) {
    if (ctorParams.length !== superArgs.length) {
        return false;
    }
    for (var i = 0; i < ctorParams.length; ++i) {
        if (!isValidPair(ctorParams[i], superArgs[i])) {
            return false;
        }
    }
    return true;
}
function isRedundantSuperCall(body, ctorParams) {
    return (isSingleSuperCall(body) &&
        ctorParams.every(isSimple) &&
        (isSpreadArguments(body[0].expression.arguments) ||
            isPassingThrough(ctorParams, body[0].expression.arguments)));
}
module.exports = function (context) {
    function checkForConstructor(node) {
        if (node.kind !== "constructor") {
            return;
        }
        var body = node.value.body.body;
        var ctorParams = node.value.params;
        var superClass = node.parent.parent.superClass;
        if (superClass ? isRedundantSuperCall(body, ctorParams) : (body.length === 0)) {
            context.report({
                node: node,
                message: "Useless constructor."
            });
        }
    }
    return {
        "MethodDefinition": checkForConstructor
    };
};
module.exports.schema = [];
