import { defineRule } from '#oxlint-plugins';
import { branchConditions, externalOrigin, isGlobalIdentifier, isGlobalMemberCall, isUnaryNot, precedingTerminatingGuards, sameExpression, unwrapExpression, } from '../shared/external-records.js';
function isGlobalObjectCall(sourceCode, expression, value) {
    const candidate = unwrapExpression(expression);
    const callee = candidate.type === 'CallExpression' ? unwrapExpression(candidate.callee) : null;
    return (candidate.type === 'CallExpression' &&
        callee?.type === 'Identifier' &&
        isGlobalIdentifier(sourceCode, callee, 'Object') &&
        candidate.arguments.length === 1 &&
        candidate.arguments[0]?.type !== 'SpreadElement' &&
        sameExpression(sourceCode, candidate.arguments[0], value));
}
function objectComparison(sourceCode, expression, value, equal) {
    const candidate = unwrapExpression(expression);
    if (candidate.type !== 'BinaryExpression')
        return false;
    if (candidate.operator !== (equal ? '===' : '!=='))
        return false;
    return ((isGlobalObjectCall(sourceCode, candidate.left, value) &&
        sameExpression(sourceCode, candidate.right, value)) ||
        (sameExpression(sourceCode, candidate.left, value) &&
            isGlobalObjectCall(sourceCode, candidate.right, value)));
}
function typeofObjectComparison(sourceCode, expression, value, equal) {
    const candidate = unwrapExpression(expression);
    if (candidate.type !== 'BinaryExpression' || candidate.operator !== (equal ? '===' : '!==')) {
        return false;
    }
    const matches = (left, right) => left.type === 'UnaryExpression' &&
        left.operator === 'typeof' &&
        sameExpression(sourceCode, left.argument, value) &&
        right.type === 'Literal' &&
        right.value === 'object';
    return matches(candidate.left, candidate.right) || matches(candidate.right, candidate.left);
}
function nullComparison(sourceCode, expression, value, equal) {
    const candidate = unwrapExpression(expression);
    if (candidate.type !== 'BinaryExpression' || candidate.operator !== (equal ? '===' : '!==')) {
        return false;
    }
    const matches = (left, right) => sameExpression(sourceCode, left, value) && right.type === 'Literal' && right.value === null;
    return matches(candidate.left, candidate.right) || matches(candidate.right, candidate.left);
}
function arrayCheck(sourceCode, expression, value, expected) {
    const candidate = unwrapExpression(expression);
    if (!expected && isUnaryNot(candidate)) {
        return arrayCheck(sourceCode, candidate.argument, value, true);
    }
    return (expected &&
        candidate.type === 'CallExpression' &&
        isGlobalMemberCall(sourceCode, candidate, 'Array', 'isArray') &&
        candidate.arguments.length === 1 &&
        candidate.arguments[0]?.type !== 'SpreadElement' &&
        sameExpression(sourceCode, candidate.arguments[0], value));
}
function findClause(expression, operator, predicate) {
    const candidate = unwrapExpression(expression);
    if (predicate(candidate))
        return candidate;
    if (candidate.type !== 'LogicalExpression' || candidate.operator !== operator)
        return null;
    return (findClause(candidate.right, operator, predicate) ??
        findClause(candidate.left, operator, predicate));
}
/** What a condition proves when it is `truthy`: each `&&` clause, or each `||` clause negated. */
function recordFacts(sourceCode, condition, value, truthy) {
    const holds = (predicate) => findClause(condition, truthy ? '&&' : '||', predicate) !== null;
    return {
        identity: holds((clause) => objectComparison(sourceCode, clause, value, truthy)),
        object: holds((clause) => typeofObjectComparison(sourceCode, clause, value, truthy)),
        nonNull: holds((clause) => nullComparison(sourceCode, clause, value, !truthy)),
        notArray: holds((clause) => arrayCheck(sourceCode, clause, value, !truthy)),
    };
}
/** Every enclosing branch and preceding terminating guard holds on the path to `node`, and calls
 * cannot change a const binding's typeof, null-ness or array-ness, so the facts combine. */
function guarded(sourceCode, node, value, origin) {
    const facts = [
        ...branchConditions(node).map(({ condition, truthy }) => recordFacts(sourceCode, condition, value, truthy)),
        ...precedingTerminatingGuards(node).map(({ condition }) => recordFacts(sourceCode, condition, value, false)),
    ];
    const known = (fact) => facts.some((established) => established[fact]);
    return (known('notArray') &&
        ((origin === 'json' && known('identity')) || (known('object') && known('nonNull'))));
}
/** Require local positive record-shape proof before enumerating a JSON-derived value. */
export const noUnsafeExternalRecordEnumerationRule = defineRule({
    meta: {
        type: 'problem',
        docs: {
            description: 'Require JSON-derived values to be proven non-primitive and non-array before object enumeration.',
        },
        messages: {
            unsafeEnumeration: 'Object.{{method}} on an unproven JSON-derived value admits primitives as empty records. Prove a non-null object and reject arrays before enumeration.',
        },
    },
    createOnce(context) {
        return {
            CallExpression(node) {
                const method = isGlobalMemberCall(context.sourceCode, node, 'Object', 'entries')
                    ? 'entries'
                    : isGlobalMemberCall(context.sourceCode, node, 'Object', 'keys')
                        ? 'keys'
                        : null;
                if (method !== null &&
                    node.arguments.length > 0 &&
                    node.arguments[0]?.type !== 'SpreadElement') {
                    const value = node.arguments[0];
                    const origin = externalOrigin(context.sourceCode, value);
                    if (origin !== null &&
                        origin !== 'record-parameter' &&
                        !guarded(context.sourceCode, node, value, origin)) {
                        context.report({ node, messageId: 'unsafeEnumeration', data: { method } });
                    }
                }
            },
        };
    },
});
