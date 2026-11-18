function isNode(value) {
    return (typeof value === "object" &&
        value !== null &&
        "type" in value &&
        typeof value.type === "string");
}
function collectInferTypeParameterNames(node, visitorKeys, names) {
    // Only a nested conditional's extendsType binds `infer` names to that inner conditional.
    if (node.type === "TSConditionalType") {
        for (const arm of [node.checkType, node.trueType, node.falseType]) {
            collectInferTypeParameterNames(arm, visitorKeys, names);
        }
        return;
    }
    if (node.type === "TSInferType")
        names.add(node.typeParameter.name.name);
    const record = node;
    for (const key of visitorKeys[node.type] ?? []) {
        const value = record[key];
        if (isNode(value)) {
            collectInferTypeParameterNames(value, visitorKeys, names);
            continue;
        }
        if (!Array.isArray(value))
            continue;
        for (const child of value) {
            if (isNode(child))
                collectInferTypeParameterNames(child, visitorKeys, names);
        }
    }
}
/** Add the type names `current` binds for its child `descendant`. */
function addTypeParametersBoundAt(current, descendant, visitorKeys, names) {
    if ("typeParameters" in current) {
        for (const parameter of current.typeParameters?.params ?? []) {
            names.add(parameter.name.name);
        }
    }
    if (current.type === "TSMappedType" &&
        (descendant === current.nameType || descendant === current.typeAnnotation)) {
        names.add(current.key.name);
    }
    if (current.type === "TSConditionalType" && descendant === current.trueType) {
        collectInferTypeParameterNames(current.extendsType, visitorKeys, names);
    }
}
/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function lexicalTypeParameterNames(node, visitorKeys) {
    const names = new Set();
    let descendant = node;
    let current = node;
    while (current !== null && current.type !== "Program") {
        addTypeParametersBoundAt(current, descendant, visitorKeys, names);
        descendant = current;
        current = current.parent;
    }
    return names;
}
/** The nearest ancestor that binds `name` as a type parameter, with its distance from `node`. */
export function nearestTypeParameterBinder(name, node, visitorKeys) {
    let descendant = node;
    let current = node;
    let distance = 0;
    while (current !== null && current.type !== "Program") {
        const names = new Set();
        addTypeParametersBoundAt(current, descendant, visitorKeys, names);
        if (names.has(name))
            return { binder: current, distance };
        descendant = current;
        current = current.parent;
        distance += 1;
    }
    return null;
}
