import { defineRule } from "@oxlint/plugins";
import { classifyUnsafeDictionaryValue, classifyWideningTarget, createTypeEnvironment, isKnownEvidenceExpression, } from "../shared/dictionary-types.js";
import { containsUnknownType, functionParameterBindingName, functionParameterTypeAnnotation, } from "../shared/function-parameters.js";
import { resolveVariable } from "../shared/scope.js";
import { hasSameTypeBindings, hasVisibleTypeBinding, visibleTypeAlias, } from "../shared/type-alias-resolution.js";
function unwrapExpression(expression) {
    let current = expression;
    while (current.type === "ParenthesizedExpression" ||
        current.type === "TSAsExpression" ||
        current.type === "TSSatisfiesExpression" ||
        current.type === "TSTypeAssertion" ||
        current.type === "TSNonNullExpression") {
        current = current.expression;
    }
    return current;
}
function variableDeclarator(variable) {
    if (variable.defs.length !== 1)
        return null;
    const [definition] = variable.defs;
    return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
        ? definition.node
        : null;
}
const onlyInitializingWrites = new WeakMap();
function hasOnlyInitializingWrites(variable) {
    let result = onlyInitializingWrites.get(variable);
    if (result === undefined) {
        result = variable.references.every((reference) => reference.init || !reference.isWrite());
        onlyInitializingWrites.set(variable, result);
    }
    return result;
}
function isStableConstVariable(variable, declarator) {
    return (declarator.parent.type === "VariableDeclaration" &&
        declarator.parent.kind === "const" &&
        hasOnlyInitializingWrites(variable));
}
/**
 * Whether a binding's initializer asserts a broad type, as `{} as Record<string, T>` does. An
 * undecided assertion counts too: it stops evidence at the source, so it can never cause a report.
 */
function hasBroadAssertionInitializer(initializer, environment) {
    let current = initializer;
    while (current.type === "ParenthesizedExpression" ||
        current.type === "TSNonNullExpression" ||
        current.type === "TSSatisfiesExpression") {
        current = current.expression;
    }
    return ((current.type === "TSAsExpression" || current.type === "TSTypeAssertion") &&
        classifyWideningTarget(current.typeAnnotation, environment) !== null);
}
function hasKnownEvidence(sourceCode, expression, environment, visitedVariables = new Set()) {
    if (isKnownEvidenceExpression(expression))
        return true;
    const unwrapped = unwrapExpression(expression);
    if (unwrapped.type !== "Identifier")
        return false;
    const variable = resolveVariable(sourceCode, unwrapped);
    if (variable === null || visitedVariables.has(variable))
        return false;
    const declarator = variableDeclarator(variable);
    if (declarator === null ||
        declarator.init === null ||
        !isStableConstVariable(variable, declarator)) {
        return false;
    }
    // A broad or undecided annotation or assertion on the source is judged at its own declaration.
    if (annotationTarget(variableTypeAnnotation(sourceCode, variable), environment) !== null ||
        hasBroadAssertionInitializer(declarator.init, environment)) {
        return false;
    }
    visitedVariables.add(variable);
    return hasKnownEvidence(sourceCode, declarator.init, environment, visitedVariables);
}
function isFunctionExpression(node) {
    return (node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "TSDeclareFunction" ||
        node.type === "TSEmptyBodyFunctionExpression");
}
function definedFunction(variable) {
    if (variable.defs.length !== 1)
        return null;
    const [definition] = variable.defs;
    if (definition === undefined)
        return null;
    if (definition.type === "FunctionName" && isFunctionExpression(definition.node)) {
        return definition.node;
    }
    if (definition.type !== "Variable" || definition.node.type !== "VariableDeclarator") {
        return null;
    }
    const initializer = definition.node.init;
    if (initializer === null)
        return null;
    const unwrappedInitializer = unwrapExpression(initializer);
    return isFunctionExpression(unwrappedInitializer) ? unwrappedInitializer : null;
}
/** The local function a call runs, if `accepts` it; the reassignment scan runs only after that check. */
function localFunctionForCall(sourceCode, callee, accepts) {
    const unwrapped = unwrapExpression(callee);
    if (isFunctionExpression(unwrapped))
        return accepts(unwrapped) ? unwrapped : null;
    if (unwrapped.type !== "Identifier")
        return null;
    const variable = resolveVariable(sourceCode, unwrapped);
    if (variable === null)
        return null;
    const owner = definedFunction(variable);
    return owner !== null && accepts(owner) && hasOnlyInitializingWrites(variable) ? owner : null;
}
function hasReturnType(owner) {
    return owner.returnType !== undefined && owner.returnType !== null;
}
function variableTypeAnnotation(sourceCode, variable) {
    if (variable.defs.length !== 1)
        return null;
    const [definition] = variable.defs;
    if (definition === undefined)
        return null;
    if (definition.type === "Variable" &&
        definition.node.type === "VariableDeclarator" &&
        definition.node.id.type === "Identifier") {
        return definition.node.id.typeAnnotation ?? null;
    }
    if (definition.type !== "Parameter" || !isFunctionExpression(definition.node)) {
        return null;
    }
    const parameter = definition.node.params.find((candidate) => functionParameterBindingName(candidate, sourceCode) === variable.name);
    return parameter === undefined ? null : (functionParameterTypeAnnotation(parameter) ?? null);
}
function hasInformativeType(type, environment) {
    // An undecided type is not known to be informative.
    return classifyUnsafeDictionaryValue(type, environment) === null;
}
function unwrapParenthesizedType(type) {
    let current = type;
    while (current.type === "TSParenthesizedType")
        current = current.typeAnnotation;
    return current;
}
function typeText(sourceCode, type) {
    // Drop whitespace between tokens but keep it inside string literal types, where it is the value.
    return sourceCode
        .getText(unwrapParenthesizedType(type))
        .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\s+/g, (_, literal) => literal ?? "");
}
const literalTypeKeywords = {
    bigint: "TSBigIntKeyword",
    boolean: "TSBooleanKeyword",
    number: "TSNumberKeyword",
    string: "TSStringKeyword",
};
function literalTypeKeyword(type) {
    if (type.type === "TSTemplateLiteralType")
        return "TSStringKeyword";
    if (type.type !== "TSLiteralType")
        return null;
    const literal = type.literal.type === "UnaryExpression" ? type.literal.argument : type.literal;
    if (literal.type === "TemplateLiteral")
        return "TSStringKeyword";
    return literal.type === "Literal" ? (literalTypeKeywords[typeof literal.value] ?? null) : null;
}
function isNullishType(type) {
    return type.type === "TSNullKeyword" || type.type === "TSUndefinedKeyword";
}
/** Deeper alias chains count as narrowable: a missed report, never a false one. */
const maxPredicateAliasDepth = 64;
/** Whether every value of a declared type already satisfies the guard's predicate type. */
function typeSatisfiesPredicate(check, type, resolvingAliases) {
    const current = unwrapParenthesizedType(type);
    if (typeText(check.sourceCode, current) === check.predicateText &&
        hasSameTypeBindings(current, check.predicate, check.environment.typeAliases)) {
        return true;
    }
    if (current.type === "TSUnionType") {
        return current.types.every((member) => (check.nonNull && isNullishType(member)) ||
            typeSatisfiesPredicate(check, member, resolvingAliases));
    }
    const literalKeyword = literalTypeKeyword(current);
    if (literalKeyword !== null)
        return literalKeyword === unwrapParenthesizedType(check.predicate).type;
    if (current.type !== "TSTypeReference" ||
        current.typeName.type !== "Identifier" ||
        current.typeArguments) {
        return false;
    }
    const alias = visibleTypeAlias(current.typeName.name, current, check.environment.typeAliases);
    if (alias === null ||
        alias.typeParameters ||
        resolvingAliases.has(alias) ||
        resolvingAliases.size >= maxPredicateAliasDepth) {
        return false;
    }
    let satisfies = check.resolvedAliases.get(alias);
    if (satisfies === undefined) {
        satisfies = typeSatisfiesPredicate(check, alias.typeAnnotation, new Set(resolvingAliases).add(alias));
        check.resolvedAliases.set(alias, satisfies);
    }
    return satisfies;
}
function declaredTypeMatchesPredicate(sourceCode, type, predicate, environment, nonNull) {
    if (predicate === null)
        return false;
    const check = {
        environment,
        nonNull,
        predicate,
        predicateText: typeText(sourceCode, predicate),
        resolvedAliases: new Map(),
        sourceCode,
    };
    return typeSatisfiesPredicate(check, type, new Set()) && hasInformativeType(type, environment);
}
function isTopType(type) {
    const unwrapped = type === undefined ? null : unwrapParenthesizedType(type);
    return unwrapped?.type === "TSUnknownKeyword" || unwrapped?.type === "TSAnyKeyword";
}
/** The type arguments of a reference to the built-in `name`; null when the name is not it. */
function builtInTypeArguments(type, name, environment) {
    return type.type === "TSTypeReference" &&
        type.typeName.type === "Identifier" &&
        type.typeName.name === name &&
        !hasVisibleTypeBinding(name, type, environment.typeAliases)
        ? (type.typeArguments?.params ?? [])
        : null;
}
/** `Record<string, unknown>` or `{ [key: string]: unknown }`: a type every object literal satisfies. */
function isOpenDictionaryPredicate(type, environment) {
    const [key, value] = builtInTypeArguments(type, "Record", environment) ?? [];
    if (key !== undefined) {
        const keyType = unwrapParenthesizedType(key);
        return (isTopType(value) &&
            (keyType.type === "TSStringKeyword" ||
                builtInTypeArguments(keyType, "PropertyKey", environment) !== null));
    }
    return (type.type === "TSTypeLiteral" &&
        type.members.length > 0 &&
        type.members.every((member) => member.type === "TSIndexSignature" &&
            member.parameters[0]?.typeAnnotation.typeAnnotation.type === "TSStringKeyword" &&
            isTopType(member.typeAnnotation.typeAnnotation)));
}
/** The array literals a predicate accepts whatever their elements: `unknown[]` takes mutable ones only. */
function acceptedArrayLiteral(type, environment) {
    if (type.type === "TSArrayType")
        return isTopType(type.elementType) ? "array" : null;
    if (type.type === "TSTypeOperator" && type.operator === "readonly") {
        const operand = unwrapParenthesizedType(type.typeAnnotation);
        return operand.type === "TSArrayType" && isTopType(operand.elementType) ? "readonly array" : null;
    }
    if (isTopType(builtInTypeArguments(type, "Array", environment)?.[0]))
        return "array";
    return isTopType(builtInTypeArguments(type, "ReadonlyArray", environment)?.[0])
        ? "readonly array"
        : null;
}
/** Whether every literal of this kind satisfies the predicate; a structural comparison is never tried. */
function literalSatisfiesPredicate(kind, predicate, environment) {
    if (predicate === null)
        return false;
    const target = classifyWideningTarget(predicate, environment);
    if (target === "undecided")
        return false;
    if (target?.kind === "unknown" || target?.kind === "object")
        return true;
    const type = unwrapParenthesizedType(predicate);
    if (kind === "object")
        return isOpenDictionaryPredicate(type, environment);
    const accepted = acceptedArrayLiteral(type, environment);
    return accepted === "readonly array" || accepted === kind;
}
function isOptionalParameterAnnotation(annotation) {
    // Oxlint types `Identifier.optional` as `false`, but an optional parameter (`value?: T`) sets it.
    return annotation.parent.type === "Identifier" && Boolean(annotation.parent.optional);
}
/** `as const` keeps the asserted expression's own type, so the expression stays the evidence. */
function isConstType(type) {
    return type.type === "TSTypeReference" && type.typeName.type === "Identifier" && type.typeName.name === "const";
}
/** Whether a guard call cannot narrow its argument: a known value, or a declared type the predicate already holds. */
function isRedundantGuardArgument(sourceCode, expression, predicate, environment, nonNull = false, visitedVariables = new Set()) {
    const constAssertion = (expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") &&
        isConstType(expression.typeAnnotation);
    // `as const` makes an array literal a readonly tuple, which `unknown[]` does not accept.
    if (constAssertion && unwrapExpression(expression.expression).type === "ArrayExpression") {
        return literalSatisfiesPredicate("readonly array", predicate, environment);
    }
    if (expression.type === "ParenthesizedExpression" ||
        expression.type === "TSSatisfiesExpression" ||
        constAssertion) {
        return isRedundantGuardArgument(sourceCode, expression.expression, predicate, environment, nonNull, visitedVariables);
    }
    if (expression.type === "TSNonNullExpression") {
        return isRedundantGuardArgument(sourceCode, expression.expression, predicate, environment, true, visitedVariables);
    }
    if (expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") {
        return declaredTypeMatchesPredicate(sourceCode, expression.typeAnnotation, predicate, environment, nonNull);
    }
    if (expression.type === "CallExpression") {
        const returnType = localFunctionForCall(sourceCode, expression.callee, hasReturnType)?.returnType
            ?.typeAnnotation;
        return (returnType !== undefined &&
            declaredTypeMatchesPredicate(sourceCode, returnType, predicate, environment, nonNull));
    }
    if (expression.type === "ArrayExpression" || expression.type === "ObjectExpression") {
        const kind = expression.type === "ArrayExpression" ? "array" : "object";
        return literalSatisfiesPredicate(kind, predicate, environment);
    }
    if (expression.type !== "Identifier")
        return isKnownEvidenceExpression(expression);
    const variable = resolveVariable(sourceCode, expression);
    if (variable === null || visitedVariables.has(variable))
        return false;
    const annotation = variableTypeAnnotation(sourceCode, variable);
    if (annotation !== null) {
        return ((nonNull || !isOptionalParameterAnnotation(annotation)) &&
            declaredTypeMatchesPredicate(sourceCode, annotation.typeAnnotation, predicate, environment, nonNull));
    }
    const declarator = variableDeclarator(variable);
    if (declarator === null ||
        declarator.init === null ||
        !isStableConstVariable(variable, declarator)) {
        return false;
    }
    visitedVariables.add(variable);
    return isRedundantGuardArgument(sourceCode, declarator.init, predicate, environment, nonNull, visitedVariables);
}
/** The predicate type of a non-generic guard; a generic guard's predicate names its own type parameters. */
function guardPredicateType(owner) {
    const predicate = owner.returnType?.typeAnnotation;
    if (predicate?.type !== "TSTypePredicate" || (owner.typeParameters?.params.length ?? 0) > 0) {
        return null;
    }
    return predicate.typeAnnotation?.typeAnnotation ?? null;
}
function isTypePredicateFunction(owner) {
    return owner.returnType?.typeAnnotation.type === "TSTypePredicate";
}
function typePredicateSubjectIndex(sourceCode, owner) {
    const predicate = owner.returnType?.typeAnnotation;
    if (predicate?.type !== "TSTypePredicate" || predicate.parameterName.type !== "Identifier") {
        return null;
    }
    const predicateParameterName = predicate.parameterName.name;
    const index = owner.params.findIndex((parameter) => functionParameterBindingName(parameter, sourceCode) === predicateParameterName);
    return index === -1 ? null : index;
}
function annotationTarget(annotation, environment) {
    return annotation === null || annotation === undefined
        ? null
        : classifyWideningTarget(annotation.typeAnnotation, environment);
}
function enclosingFunction(node) {
    let current = node.parent;
    while (current !== null && current.type !== "Program") {
        if (current.type === "ArrowFunctionExpression" ||
            current.type === "FunctionDeclaration" ||
            current.type === "FunctionExpression") {
            return current;
        }
        current = current.parent;
    }
    return null;
}
function sourceKeyName(sourceCode, key) {
    if (key.type === "Identifier" || key.type === "PrivateIdentifier")
        return key.name;
    if (key.type === "Literal")
        return String(key.value);
    return sourceCode.getText(key);
}
function functionName(sourceCode, owner) {
    if (owner === null)
        return "anonymous function";
    if (owner.id !== null)
        return owner.id.name;
    const parent = owner.parent;
    if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier")
        return parent.id.name;
    if (parent.type === "MethodDefinition")
        return sourceKeyName(sourceCode, parent.key);
    return "anonymous function";
}
function isEmptyObjectExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    return unwrapped.type === "ObjectExpression" && unwrapped.properties.length === 0;
}
function isDictionaryAccumulatorTarget(destination) {
    return destination.kind === "open dictionary" || destination.kind === "generic container";
}
function hasParentAssertion(node) {
    return node.parent?.type === "TSAsExpression" || node.parent?.type === "TSTypeAssertion";
}
/** Detect sound syntactic cases where a known value is explicitly widened and loses evidence. */
export const noKnownValueWideningRule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description: "Disallow syntactically established values from flowing into explicitly broad or anonymous target types that discard useful evidence.",
        },
        messages: {
            widening: "The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
        },
    },
    createOnce(context) {
        let environment = null;
        const reportFlow = (expression, destination, subject) => {
            if (destination === null || destination === "undecided" || environment === null)
                return;
            if (isDictionaryAccumulatorTarget(destination) &&
                isEmptyObjectExpression(expression)) {
                return;
            }
            if (!hasKnownEvidence(context.sourceCode, expression, environment))
                return;
            context.report({
                node: expression,
                messageId: "widening",
                data: { subject, target: destination.kind },
            });
        };
        const targetFromAnnotation = (annotation) => environment === null ? null : annotationTarget(annotation, environment);
        return {
            Program(node) {
                environment = createTypeEnvironment(node, context.sourceCode.visitorKeys);
            },
            VariableDeclarator(node) {
                if (node.init === null || node.id.type !== "Identifier")
                    return;
                reportFlow(node.init, targetFromAnnotation(node.id.typeAnnotation), `binding \`${node.id.name}\``);
            },
            PropertyDefinition(node) {
                if (node.value === null)
                    return;
                reportFlow(node.value, targetFromAnnotation(node.typeAnnotation), `property \`${sourceKeyName(context.sourceCode, node.key)}\``);
            },
            AccessorProperty(node) {
                if (node.value === null)
                    return;
                reportFlow(node.value, targetFromAnnotation(node.typeAnnotation), `property \`${sourceKeyName(context.sourceCode, node.key)}\``);
            },
            AssignmentExpression(node) {
                if (node.operator !== "=" || node.left.type !== "Identifier")
                    return;
                const variable = resolveVariable(context.sourceCode, node.left);
                if (variable === null)
                    return;
                const declarator = variableDeclarator(variable);
                if (declarator === null || declarator.id.type !== "Identifier")
                    return;
                reportFlow(node.right, targetFromAnnotation(declarator.id.typeAnnotation), `binding \`${declarator.id.name}\``);
            },
            CallExpression(node) {
                if (environment === null)
                    return;
                const owner = localFunctionForCall(context.sourceCode, node.callee, isTypePredicateFunction);
                if (owner === null)
                    return;
                const parameterIndex = typePredicateSubjectIndex(context.sourceCode, owner);
                if (parameterIndex === null)
                    return;
                const parameter = owner.params[parameterIndex];
                const argument = node.arguments[parameterIndex];
                if (parameter === undefined || argument === undefined || argument.type === "SpreadElement") {
                    return;
                }
                const parameterAnnotation = functionParameterTypeAnnotation(parameter);
                if (parameterAnnotation === null ||
                    parameterAnnotation === undefined ||
                    !containsUnknownType(parameterAnnotation.typeAnnotation)) {
                    return;
                }
                if (!isRedundantGuardArgument(context.sourceCode, argument, guardPredicateType(owner), environment)) {
                    return;
                }
                context.report({
                    node: argument,
                    messageId: "widening",
                    data: {
                        subject: `argument for parameter \`${functionParameterBindingName(parameter, context.sourceCode)}\` of \`${functionName(context.sourceCode, owner)}\``,
                        target: "unknown",
                    },
                });
            },
            ReturnStatement(node) {
                if (node.argument === null)
                    return;
                const owner = enclosingFunction(node);
                reportFlow(node.argument, targetFromAnnotation(owner?.returnType), `return value of \`${functionName(context.sourceCode, owner)}\``);
            },
            ArrowFunctionExpression(node) {
                if (node.body.type === "BlockStatement")
                    return;
                reportFlow(node.body, targetFromAnnotation(node.returnType), `return value of \`${functionName(context.sourceCode, node)}\``);
            },
            TSAsExpression(node) {
                if (environment === null || hasParentAssertion(node))
                    return;
                reportFlow(node.expression, classifyWideningTarget(node.typeAnnotation, environment), "assertion");
            },
            TSTypeAssertion(node) {
                if (environment === null || hasParentAssertion(node))
                    return;
                reportFlow(node.expression, classifyWideningTarget(node.typeAnnotation, environment), "assertion");
            },
        };
    },
});
