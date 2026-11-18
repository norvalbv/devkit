import { lexicalTypeParameterNames, nearestTypeParameterBinder, } from "./lexical-type-parameters.js";
const environmentsByProgram = new WeakMap();
function isNode(value) {
    return (typeof value === "object" &&
        value !== null &&
        "type" in value &&
        typeof value.type === "string");
}
function enclosingTypeScope(node) {
    // A named class expression binds its name only inside the expression.
    if (node.type === "ClassExpression")
        return node;
    let current = node.parent;
    while (current !== null) {
        if (current.type === "Program" ||
            current.type === "BlockStatement" ||
            current.type === "TSModuleBlock" ||
            current.type === "StaticBlock" ||
            current.type === "SwitchStatement") {
            return current;
        }
        current = current.parent;
    }
    return node;
}
function isTypeOnlyImport(node) {
    return ((node.type === "ImportSpecifier" && node.importKind === "type") ||
        (node.parent.type === "ImportDeclaration" && node.parent.importKind === "type"));
}
function mergesWithGlobal(node) {
    const statement = node.parent.type === "ExportNamedDeclaration" ? node.parent : node;
    return (statement.parent.type === "TSModuleBlock" &&
        statement.parent.parent.type === "TSModuleDeclaration" &&
        statement.parent.parent.kind === "global");
}
function declaredTypeBinding(node) {
    if (node.type === "TSTypeAliasDeclaration") {
        return { alias: node, typeMeaning: "type", name: node.id.name };
    }
    if (node.type === "TSInterfaceDeclaration") {
        return {
            alias: null,
            typeMeaning: mergesWithGlobal(node) ? "none" : "type",
            name: node.id.name,
        };
    }
    if (node.type === "TSEnumDeclaration" ||
        node.type === "ClassDeclaration" ||
        node.type === "ClassExpression") {
        return node.id === null
            ? null
            : { alias: null, typeMeaning: "type", name: node.id.name };
    }
    if (node.type === "TSModuleDeclaration" && node.kind === "namespace") {
        let root = node.id;
        while (root.type === "TSQualifiedName")
            root = root.left;
        return root.type === "Identifier" ? { alias: null, typeMeaning: "none", name: root.name } : null;
    }
    if (node.type === "ImportNamespaceSpecifier") {
        return { alias: null, typeMeaning: "none", name: node.local.name };
    }
    if (node.type === "ImportSpecifier" ||
        node.type === "ImportDefaultSpecifier") {
        return {
            alias: null,
            typeMeaning: isTypeOnlyImport(node) ? "type" : "maybe",
            name: node.local.name,
        };
    }
    return null;
}
function collectTypeBindings(node, visitorKeys, bindingsByName, aliases) {
    const declared = declaredTypeBinding(node);
    if (declared !== null) {
        const bindings = bindingsByName.get(declared.name) ?? [];
        bindings.push({ ...declared, scope: enclosingTypeScope(node) });
        bindingsByName.set(declared.name, bindings);
        if (declared.alias !== null)
            aliases.push(declared.alias);
    }
    // SAFETY: Oxlint's visitor keys identify only ESTree child-node properties.
    const fields = node;
    for (const key of visitorKeys[node.type] ?? []) {
        const value = fields[key];
        if (isNode(value)) {
            collectTypeBindings(value, visitorKeys, bindingsByName, aliases);
            continue;
        }
        if (!Array.isArray(value))
            continue;
        for (const child of value) {
            if (isNode(child)) {
                collectTypeBindings(child, visitorKeys, bindingsByName, aliases);
            }
        }
    }
}
/** Collect every lexical type alias and competing type binding in a program. */
export function createTypeAliasEnvironment(program, visitorKeys) {
    const cached = environmentsByProgram.get(program);
    if (cached !== undefined)
        return cached;
    const bindingsByName = new Map();
    const aliases = [];
    collectTypeBindings(program, visitorKeys, bindingsByName, aliases);
    const environment = { aliases, bindingsByName, visitorKeys };
    environmentsByProgram.set(program, environment);
    return environment;
}
function ancestorDistance(ancestor, node) {
    let current = node;
    let distance = 0;
    while (current !== null) {
        if (current === ancestor)
            return distance;
        current = current.parent;
        distance += 1;
    }
    return null;
}
function nearestBindings(candidates, use) {
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearest = [];
    for (const candidate of candidates) {
        const distance = ancestorDistance(candidate.scope, use);
        if (distance === null || distance > nearestDistance)
            continue;
        if (distance === nearestDistance) {
            nearest.push(candidate);
            continue;
        }
        nearestDistance = distance;
        nearest = [candidate];
    }
    return nearest;
}
/** The nearest bindings that may name a type; one that never does lets the name resolve further out. */
function nearestTypeBindings(name, use, environment) {
    const candidates = environment.bindingsByName.get(name) ?? [];
    return nearestBindings(candidates.filter((binding) => binding.typeMeaning !== "none"), use);
}
/** Resolve the nearest visible alias with this name, respecting lexical shadowing. */
export function visibleTypeAlias(name, use, environment) {
    if (lexicalTypeParameterNames(use, environment.visitorKeys).has(name))
        return null;
    const bindings = nearestTypeBindings(name, use, environment);
    return bindings.length === 1 ? (bindings[0]?.alias ?? null) : null;
}
/**
 * Return whether anything that may name a type shadows a built-in here. Use it where reading the
 * name as the built-in would report: an ambiguous value import then stays silent.
 */
export function hasVisibleTypeBinding(name, use, environment) {
    return (lexicalTypeParameterNames(use, environment.visitorKeys).has(name) ||
        nearestTypeBindings(name, use, environment).length > 0);
}
/**
 * Return whether a declaration that definitely names a type shadows a built-in here. Use it where
 * reading the name as the built-in spares the code: an ambiguous value import then stays silent.
 */
export function hasVisibleTypeDeclaration(name, use, environment) {
    return (lexicalTypeParameterNames(use, environment.visitorKeys).has(name) ||
        nearestTypeBindings(name, use, environment).some((binding) => binding.typeMeaning === "type"));
}
/** Whether a name here resolves to a top-level declaration, not a nearer type or type parameter. */
export function isTopLevelTypeBinding(name, use, environment) {
    return (!lexicalTypeParameterNames(use, environment.visitorKeys).has(name) &&
        nearestTypeBindings(name, use, environment)[0]?.scope.type === "Program");
}
/** The type parameter or the alias bindings a name resolves to at a use, whichever is nearer. */
function nearestTypeBinder(name, use, environment) {
    // Namespaces count here: they root qualified names such as `Models.Item`.
    const bindings = nearestBindings(environment.bindingsByName.get(name) ?? [], use);
    const parameter = nearestTypeParameterBinder(name, use, environment.visitorKeys);
    const bindingScope = bindings[0]?.scope;
    if (parameter !== null &&
        (bindingScope === undefined ||
            (ancestorDistance(bindingScope, use) ?? Number.POSITIVE_INFINITY) >= parameter.distance)) {
        return parameter.binder;
    }
    return bindings;
}
function hasSameTypeBinding(first, second, environment) {
    if (second.name !== first.name)
        return false;
    const firstBinder = nearestTypeBinder(first.name, first, environment);
    const secondBinder = nearestTypeBinder(first.name, second, environment);
    if (!Array.isArray(firstBinder) || !Array.isArray(secondBinder)) {
        return firstBinder === secondBinder;
    }
    return (firstBinder.length === secondBinder.length &&
        firstBinder.every((binding, index) => binding === secondBinder[index]));
}
/** Collect each type reference's root name; false when a `typeof` query names a value it cannot compare. */
function collectTypeReferenceRoots(node, visitorKeys, roots) {
    if (node.type === "TSTypeQuery")
        return false;
    if (node.type === "TSTypeReference") {
        let name = node.typeName;
        while (name.type === "TSQualifiedName")
            name = name.left;
        if (name.type === "Identifier")
            roots.push(name);
    }
    // SAFETY: Oxlint's visitor keys identify only ESTree child-node properties.
    const fields = node;
    for (const key of visitorKeys[node.type] ?? []) {
        const value = fields[key];
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) {
            if (isNode(child) && !collectTypeReferenceRoots(child, visitorKeys, roots))
                return false;
        }
    }
    return true;
}
/** Whether two textually equal types name the same declarations, type parameters included; a `typeof` query never does. */
export function hasSameTypeBindings(first, second, environment) {
    const firstRoots = [];
    const secondRoots = [];
    return (collectTypeReferenceRoots(first, environment.visitorKeys, firstRoots) &&
        collectTypeReferenceRoots(second, environment.visitorKeys, secondRoots) &&
        firstRoots.length === secondRoots.length &&
        firstRoots.every((root, index) => {
            const other = secondRoots[index];
            return other !== undefined && hasSameTypeBinding(root, other, environment);
        }));
}
function typeReferenceName(type) {
    return type.typeName.type === "Identifier" ? type.typeName.name : null;
}
function aliasSubstitutions(alias, reference, base, baseResolving, aliasResolving) {
    const parameters = alias.typeParameters?.params ?? [];
    const arguments_ = reference.typeArguments?.params ?? [];
    const next = new Map();
    for (const [index, parameter] of parameters.entries()) {
        const explicitArgument = arguments_[index];
        const argument = explicitArgument ?? parameter.default;
        if (argument === null || argument === undefined)
            return null;
        // Explicit arguments were written at the reference; defaults inside the alias.
        const isDefault = explicitArgument === undefined;
        next.set(parameter.name.name, {
            type: argument,
            substitutions: new Map(isDefault ? next : base),
            resolvingAliases: isDefault ? aliasResolving : baseResolving,
        });
    }
    return next;
}
/** Alias expansions one resolution may perform before it leaves further aliases unexpanded. */
const EXPANSION_BUDGET = 1_000;
export function createExpansionBudget() {
    return { remaining: EXPANSION_BUDGET };
}
/** Count one alias expansion; false once the budget is spent, so the alias stays unexpanded. */
export function spendExpansion(budget) {
    budget.remaining -= 1;
    return budget.remaining >= 0;
}
/** Whether a resolution left some alias unexpanded, so a negative answer is only partial. */
export function isExpansionBudgetSpent(budget) {
    return budget.remaining < 0;
}
function evaluateResolved(resolution, current, substitutions, resolvingAliases) {
    if (current.type === "TSTypeReference") {
        const name = typeReferenceName(current);
        if (name !== null) {
            const substitution = substitutions.get(name);
            if (substitution !== undefined && !current.typeArguments?.params.length) {
                // Resume in the argument's own context so a separate, finite instantiation of an
                // alias that is still being expanded (`Maybe<Maybe<unknown>>`) is not mistaken for
                // recursion.
                const cached = resolution.resumed.get(substitution);
                if (cached !== undefined)
                    return cached;
                const result = evaluateResolved(resolution, substitution.type, substitution.substitutions, substitution.resolvingAliases);
                resolution.resumed.set(substitution, result);
                return result;
            }
            const alias = visibleTypeAlias(name, current, resolution.environment);
            if (alias !== null &&
                !resolvingAliases.has(alias) &&
                spendExpansion(resolution.budget)) {
                const nextResolving = new Set(resolvingAliases);
                nextResolving.add(alias);
                const nextSubstitutions = aliasSubstitutions(alias, current, substitutions, resolvingAliases, nextResolving);
                if (nextSubstitutions !== null) {
                    return evaluateResolved(resolution, alias.typeAnnotation, nextSubstitutions, nextResolving);
                }
            }
        }
    }
    return resolution.matcher(current, (child) => evaluateResolved(resolution, child, substitutions, resolvingAliases));
}
/**
 * Match a type after resolving visible aliases and substituting their type parameters.
 * Past the expansion budget an alias stays unexpanded, as a recursive one does, so a matcher
 * that answers true only for a finding loses findings there but never gains one.
 */
export function resolvedTypeMatches(type, environment, matcher) {
    return evaluateResolved({ budget: createExpansionBudget(), environment, matcher, resumed: new Map() }, type, new Map(), new Set());
}
