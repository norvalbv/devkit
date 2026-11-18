import { createExpansionBudget, createTypeAliasEnvironment, hasVisibleTypeBinding, isExpansionBudgetSpent, isTopLevelTypeBinding, spendExpansion, visibleTypeAlias, } from "./type-alias-resolution.js";
const BUILT_INS = new Set([
    "Record",
    "Readonly",
    "Partial",
    "Required",
    "Pick",
    "Omit",
    "PropertyKey",
    "NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);
const aliasMemos = new WeakMap();
function declaredStatement(statement) {
    return statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration"
        ? (statement.declaration ?? null)
        : statement;
}
export function createTypeEnvironment(program, visitorKeys) {
    const interfaces = new Map();
    for (const statement of program.body) {
        const declaration = declaredStatement(statement);
        if (declaration?.type !== "TSInterfaceDeclaration")
            continue;
        const declarations = interfaces.get(declaration.id.name) ?? [];
        declarations.push(declaration);
        interfaces.set(declaration.id.name, declarations);
    }
    return {
        interfaces,
        typeAliases: createTypeAliasEnvironment(program, visitorKeys),
    };
}
function typeReferenceName(type) {
    return type.typeName.type === "Identifier" ? type.typeName.name : null;
}
function isBuiltIn(name, use, environment) {
    return (BUILT_INS.has(name) &&
        !hasVisibleTypeBinding(name, use, environment.typeAliases));
}
function unwrapTransparentType(type) {
    let current = type;
    while (current.type === "TSParenthesizedType" ||
        (current.type === "TSTypeOperator" && current.operator === "readonly")) {
        current = current.typeAnnotation;
    }
    return current;
}
function isNeverType(type) {
    return unwrapTransparentType(type).type === "TSNeverKeyword";
}
function isEffectivelyEmptyMember(member) {
    return (member.type === "TSPropertySignature" &&
        member.optional === true &&
        member.typeAnnotation !== null &&
        member.typeAnnotation !== undefined &&
        isNeverType(member.typeAnnotation.typeAnnotation));
}
function isEffectivelyEmptyTypeLiteral(type) {
    return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}
function isEffectivelyEmptyInterface(declarations) {
    if (declarations.length !== 1)
        return false;
    const [type] = declarations;
    return (type !== undefined &&
        type.extends.length === 0 &&
        (type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember)));
}
function fileAliasMemo(environment) {
    const cached = aliasMemos.get(environment);
    if (cached !== undefined)
        return cached;
    const memo = { dictionaryValues: new Map(), unsafeValues: new Map() };
    aliasMemos.set(environment, memo);
    return memo;
}
function createWalk(environment) {
    return {
        budget: createExpansionBudget(),
        environment,
        aliases: fileAliasMemo(environment),
        broadKeys: new Map(),
        unsafeValues: new Map(),
        cutAliases: 0,
    };
}
function isResolving(resolvingAliases, alias) {
    for (let current = resolvingAliases; current !== null; current = current.outer) {
        if (current.alias === alias)
            return true;
    }
    return false;
}
/** A negative answer from a walk that left aliases unexpanded is undecided, not safe. */
function decided(walk, result) {
    return result === null && isExpansionBudgetSpent(walk.budget) ? "undecided" : result;
}
/** A resumed binding's result depends only on the binding, so each resolves once per walk. */
function resumeOnce(memo, binding, resolve) {
    const cached = memo.get(binding);
    if (cached !== undefined)
        return cached;
    const result = resolve();
    memo.set(binding, result);
    return result;
}
/** Bind an alias argument in the context where it was written; a bare parameter reuses its binding. */
function boundArgument(type, written, resolvingAliases) {
    const unwrapped = unwrapTransparentType(type);
    const name = unwrapped.type === "TSTypeReference" ? typeReferenceName(unwrapped) : null;
    return ((name === null ? undefined : written.get(name)) ?? {
        type,
        substitutions: written,
        resolvingAliases,
    });
}
function aliasSubstitution(alias, type, base, baseResolving, aliasResolving) {
    const parameters = alias.typeParameters?.params ?? [];
    const arguments_ = type.typeArguments?.params ?? [];
    const next = new Map();
    for (const [index, parameter] of parameters.entries()) {
        const explicitArgument = arguments_[index];
        const argument = explicitArgument ?? parameter.default;
        if (argument === null || argument === undefined)
            return null;
        // A default sees only the parameters declared before it, so `<T = T>` cannot bind to itself.
        next.set(parameter.name.name, explicitArgument === undefined
            ? boundArgument(argument, new Map(next), aliasResolving)
            : boundArgument(argument, base, baseResolving));
    }
    return next;
}
/** Expand an alias that is not already being expanded, binding its arguments. */
function expandVisibleAlias(walk, alias, reference, substitutions, resolvingAliases) {
    if (isResolving(resolvingAliases, alias) || !spendExpansion(walk.budget)) {
        walk.cutAliases += 1;
        return null;
    }
    const nextResolving = { alias, outer: resolvingAliases };
    const nextSubstitutions = aliasSubstitution(alias, reference, substitutions, resolvingAliases, nextResolving);
    return nextSubstitutions === null
        ? null
        : { type: alias.typeAnnotation, substitutions: nextSubstitutions, resolvingAliases: nextResolving };
}
function expandAlias(walk, reference, name, substitutions, resolvingAliases) {
    const alias = visibleTypeAlias(name, reference, walk.environment.typeAliases);
    return alias === null
        ? null
        : expandVisibleAlias(walk, alias, reference, substitutions, resolvingAliases);
}
/** A parameterless alias binds nothing, so its body classifies the same at every bare reference. */
function sharedAlias(alias, reference, resolvingAliases) {
    return alias.typeParameters?.params.length ||
        reference.typeArguments?.params.length ||
        isResolving(resolvingAliases, alias)
        ? null
        : alias;
}
/** Keep a shared alias's result for the file only when its walk left no alias unexpanded. */
function remember(walk, memo, alias, cutAliases, result) {
    if (alias !== null && walk.cutAliases === cutAliases)
        memo.set(alias, result);
    return result;
}
function unsafeDirectValue(walk, type, substitutions, resolvingAliases) {
    const unwrapped = unwrapTransparentType(type);
    if (unwrapped.type === "TSUnknownKeyword")
        return "unknown";
    if (unwrapped.type === "TSAnyKeyword")
        return "any";
    if (unwrapped.type === "TSObjectKeyword")
        return "object";
    if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped))
        return "empty-object";
    if (unwrapped.type === "TSUnionType") {
        return unwrapped.types.some((member) => unsafeDirectValue(walk, member, substitutions, resolvingAliases) !== null)
            ? "union"
            : null;
    }
    if (unwrapped.type === "TSIntersectionType") {
        const unsafeMembers = unwrapped.types.map((member) => unsafeDirectValue(walk, member, substitutions, resolvingAliases));
        if (unsafeMembers.includes("any"))
            return "any";
        return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
            ? unsafeMembers[0]
            : null;
    }
    if (unwrapped.type !== "TSTypeReference")
        return null;
    const name = typeReferenceName(unwrapped);
    if (name === null)
        return null;
    if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
        const wrapped = unwrapped.typeArguments?.params[0];
        return wrapped === undefined
            ? null
            : unsafeDirectValue(walk, wrapped, substitutions, resolvingAliases);
    }
    const substitution = substitutions.get(name);
    if (substitution !== undefined) {
        return resumeOnce(walk.unsafeValues, substitution, () => unsafeDirectValue(walk, substitution.type, substitution.substitutions, substitution.resolvingAliases));
    }
    const interfaceDeclarations = walk.environment.interfaces.get(name);
    if (interfaceDeclarations !== undefined &&
        isTopLevelTypeBinding(name, unwrapped, walk.environment.typeAliases)) {
        return isEffectivelyEmptyInterface(interfaceDeclarations) ? "empty-object" : null;
    }
    const alias = visibleTypeAlias(name, unwrapped, walk.environment.typeAliases);
    if (alias === null)
        return null;
    const shared = sharedAlias(alias, unwrapped, resolvingAliases);
    const cached = shared === null ? undefined : walk.aliases.unsafeValues.get(shared);
    if (cached !== undefined)
        return cached;
    const cutAliases = walk.cutAliases;
    const body = expandVisibleAlias(walk, alias, unwrapped, substitutions, resolvingAliases);
    if (body === null)
        return null;
    const result = unsafeDirectValue(walk, body.type, body.substitutions, body.resolvingAliases);
    return remember(walk, walk.aliases.unsafeValues, shared, cutAliases, result);
}
/** A mapped type's key binder shadows any outer binding of its name inside the value type. */
function withoutBinding(substitutions, name) {
    if (!substitutions.has(name))
        return substitutions;
    const next = new Map(substitutions);
    next.delete(name);
    return next;
}
function dictionaryValueTypes(walk, type, substitutions, resolvingAliases) {
    const unwrapped = unwrapTransparentType(type);
    if (unwrapped.type === "TSTypeLiteral") {
        return unwrapped.members.flatMap((member) => member.type === "TSIndexSignature" && member.typeAnnotation !== null
            ? [{ type: member.typeAnnotation.typeAnnotation, substitutions, resolvingAliases }]
            : []);
    }
    if (unwrapped.type === "TSMappedType") {
        return unwrapped.typeAnnotation === null
            ? []
            : [
                {
                    type: unwrapped.typeAnnotation,
                    substitutions: withoutBinding(substitutions, unwrapped.key.name),
                    resolvingAliases,
                },
            ];
    }
    if (unwrapped.type !== "TSTypeReference")
        return [];
    const name = typeReferenceName(unwrapped);
    if (name === null)
        return [];
    const substitution = substitutions.get(name);
    if (substitution !== undefined) {
        return dictionaryValueTypes(walk, substitution.type, substitution.substitutions, substitution.resolvingAliases);
    }
    if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
        const wrapped = unwrapped.typeArguments?.params[0];
        return wrapped === undefined
            ? []
            : dictionaryValueTypes(walk, wrapped, substitutions, resolvingAliases);
    }
    if (name === "Record" && isBuiltIn(name, unwrapped, walk.environment)) {
        const value = unwrapped.typeArguments?.params[1] ?? null;
        return value === null ? [] : [{ type: value, substitutions, resolvingAliases }];
    }
    if ((name === "Pick" || name === "Omit") &&
        isBuiltIn(name, unwrapped, walk.environment)) {
        const source = unwrapped.typeArguments?.params[0];
        return source === undefined
            ? []
            : dictionaryValueTypes(walk, source, substitutions, resolvingAliases);
    }
    const alias = visibleTypeAlias(name, unwrapped, walk.environment.typeAliases);
    if (alias === null)
        return [];
    const shared = sharedAlias(alias, unwrapped, resolvingAliases);
    const cached = shared === null ? undefined : walk.aliases.dictionaryValues.get(shared);
    if (cached !== undefined)
        return cached;
    const cutAliases = walk.cutAliases;
    const body = expandVisibleAlias(walk, alias, unwrapped, substitutions, resolvingAliases);
    if (body === null)
        return [];
    const result = dictionaryValueTypes(walk, body.type, body.substitutions, body.resolvingAliases);
    return remember(walk, walk.aliases.dictionaryValues, shared, cutAliases, result);
}
function unsafeDictionary(walk, type) {
    for (const value of dictionaryValueTypes(walk, type, new Map(), null)) {
        const unsafeValue = unsafeDirectValue(walk, value.type, value.substitutions, value.resolvingAliases);
        if (unsafeValue !== null)
            return { kind: "unsafe-dictionary", unsafeValue };
    }
    return null;
}
export function classifyUnsafeDictionaryValue(valueType, environment) {
    const walk = createWalk(environment);
    const unsafeValue = unsafeDirectValue(walk, valueType, new Map(), null);
    return decided(walk, unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue });
}
/** Classify a dictionary type; an alias past the expansion budget stays unexpanded and adds no finding. */
export function classifyUnsafeDictionary(type, environment) {
    return unsafeDictionary(createWalk(environment), type);
}
function wideningTarget(walk, type) {
    const unwrapped = unwrapTransparentType(type);
    if (unwrapped.type === "TSUnknownKeyword")
        return { kind: "unknown" };
    if (unwrapped.type === "TSObjectKeyword")
        return { kind: "object" };
    if (unwrapped.type === "TSTypeLiteral") {
        return unwrapped.members.some((member) => member.type === "TSIndexSignature")
            ? { kind: "open dictionary" }
            : unwrapped.members.length > 0
                ? { kind: "anonymous object" }
                : null;
    }
    if (unwrapped.type === "TSMappedType")
        return { kind: "open dictionary" };
    if (unwrapped.type !== "TSTypeReference")
        return null;
    const name = typeReferenceName(unwrapped);
    if (name === null)
        return null;
    if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
        const wrapped = unwrapped.typeArguments?.params[0];
        return wrapped === undefined ? null : wideningTarget(walk, wrapped);
    }
    if (name === "Record" && isBuiltIn(name, unwrapped, walk.environment)) {
        return hasBroadRecordKey(walk, unwrapped, new Map(), null)
            ? { kind: "open dictionary" }
            : null;
    }
    const expanded = expandAlias(walk, unwrapped, name, new Map(), null);
    if (expanded === null)
        return null;
    const resolved = classifyAliasBroadTarget(walk, expanded.type, expanded.substitutions, expanded.resolvingAliases);
    // Only a generic alias binds parameters; it reads as a container of whatever it is given.
    if (expanded.substitutions.size === 0)
        return resolved;
    return resolved?.kind === "open dictionary" ? { kind: "generic container" } : null;
}
export function classifyWideningTarget(type, environment) {
    const walk = createWalk(environment);
    return decided(walk, wideningTarget(walk, type));
}
function hasBroadRecordKey(walk, type, substitutions, resolvingAliases) {
    const key = type.typeArguments?.params[0];
    return key === undefined || isBroadMappedKey(walk, key, substitutions, resolvingAliases);
}
function isBroadMappedKey(walk, type, substitutions, resolvingAliases) {
    const unwrapped = unwrapTransparentType(type);
    if (unwrapped.type === "TSStringKeyword" ||
        unwrapped.type === "TSNumberKeyword" ||
        unwrapped.type === "TSSymbolKeyword" ||
        unwrapped.type === "TSAnyKeyword") {
        return true;
    }
    if (unwrapped.type === "TSUnionType") {
        return unwrapped.types.some((member) => isBroadMappedKey(walk, member, substitutions, resolvingAliases));
    }
    if (unwrapped.type !== "TSTypeReference")
        return false;
    const name = typeReferenceName(unwrapped);
    if (name === null)
        return false;
    const substitution = substitutions.get(name);
    if (substitution !== undefined) {
        return resumeOnce(walk.broadKeys, substitution, () => isBroadMappedKey(walk, substitution.type, substitution.substitutions, substitution.resolvingAliases));
    }
    if (name === "PropertyKey" && isBuiltIn(name, unwrapped, walk.environment))
        return true;
    const expanded = expandAlias(walk, unwrapped, name, substitutions, resolvingAliases);
    return (expanded !== null &&
        isBroadMappedKey(walk, expanded.type, expanded.substitutions, expanded.resolvingAliases));
}
function classifyAliasBroadTarget(walk, type, substitutions, resolvingAliases) {
    const unwrapped = unwrapTransparentType(type);
    if (unwrapped.type === "TSUnknownKeyword")
        return { kind: "unknown" };
    if (unwrapped.type === "TSObjectKeyword")
        return { kind: "object" };
    if (unwrapped.type === "TSTypeLiteral") {
        return unwrapped.members.some((member) => member.type === "TSIndexSignature")
            ? { kind: "open dictionary" }
            : null;
    }
    if (unwrapped.type === "TSMappedType") {
        return isBroadMappedKey(walk, unwrapped.constraint, substitutions, resolvingAliases)
            ? { kind: "open dictionary" }
            : null;
    }
    if (unwrapped.type !== "TSTypeReference")
        return null;
    const name = typeReferenceName(unwrapped);
    if (name === null)
        return null;
    const substitution = substitutions.get(name);
    if (substitution !== undefined) {
        return classifyAliasBroadTarget(walk, substitution.type, substitution.substitutions, substitution.resolvingAliases);
    }
    if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
        const wrapped = unwrapped.typeArguments?.params[0];
        return wrapped === undefined
            ? null
            : classifyAliasBroadTarget(walk, wrapped, substitutions, resolvingAliases);
    }
    if (name === "Record" && isBuiltIn(name, unwrapped, walk.environment)) {
        return hasBroadRecordKey(walk, unwrapped, substitutions, resolvingAliases)
            ? { kind: "open dictionary" }
            : null;
    }
    const expanded = expandAlias(walk, unwrapped, name, substitutions, resolvingAliases);
    return expanded === null
        ? null
        : classifyAliasBroadTarget(walk, expanded.type, expanded.substitutions, expanded.resolvingAliases);
}
export function isPopulatedObjectExpression(expression) {
    let current = expression;
    while (current.type === "ParenthesizedExpression" ||
        current.type === "TSAsExpression" ||
        current.type === "TSTypeAssertion" ||
        current.type === "TSNonNullExpression") {
        current = current.expression;
    }
    return current.type === "ObjectExpression" && current.properties.length > 0;
}
export function isKnownEvidenceExpression(expression) {
    let current = expression;
    while (current.type === "ParenthesizedExpression" ||
        current.type === "TSAsExpression" ||
        current.type === "TSTypeAssertion" ||
        current.type === "TSNonNullExpression" ||
        current.type === "TSSatisfiesExpression") {
        current = current.expression;
    }
    if (current.type === "ObjectExpression")
        return true;
    return (current.type === "ArrayExpression" ||
        current.type === "ArrowFunctionExpression" ||
        current.type === "ClassExpression" ||
        current.type === "FunctionExpression" ||
        current.type === "NewExpression" ||
        current.type === "Literal" ||
        current.type === "TemplateLiteral" ||
        current.type === "UnaryExpression");
}
