import { defineRule } from '#oxlint-plugins';
import { appendMutationEvidence, branchConditions, externalOrigin, hasPotentialMutationWithin, isGlobalMemberCall, isUnaryNot, precedingTerminatingGuards, sameExpression, unwrapExpression, } from '../shared/external-records.js';
function literalPropertyKey(expression) {
    const candidate = unwrapExpression(expression);
    if (candidate.type === 'TemplateLiteral' && candidate.expressions.length === 0) {
        return candidate.quasis[0]?.value.cooked ?? null;
    }
    if (candidate.type === 'UnaryExpression' &&
        (candidate.operator === '+' || candidate.operator === '-')) {
        const argument = unwrapExpression(candidate.argument);
        if (argument.type === 'Literal' && argument.value === Number(argument.value)) {
            const value = Number(argument.value);
            return String(candidate.operator === '-' ? -value : value);
        }
        if (candidate.operator === '-' &&
            argument.type === 'Literal' &&
            'bigint' in argument) {
            return String(-argument.value);
        }
    }
    if (candidate.type !== 'Literal')
        return null;
    if ('regex' in candidate)
        return null;
    return String(candidate.value);
}
const JSON_VALUE_PROTOTYPE_KEYS = new Set([
    ...[
        Object.prototype,
        Array.prototype,
        String.prototype,
        Number.prototype,
        Boolean.prototype,
    ].flatMap((prototype) => Object.getOwnPropertyNames(prototype)),
    // `prototype` is not inherited from these values, but allowing it beside `constructor` makes the
    // classic constructor/prototype pollution path too easy to split across fixed accesses.
    'prototype',
]);
function needsOwnPropertyProof(key, origin) {
    if (origin !== 'json')
        return true;
    const literal = literalPropertyKey(key);
    return literal === null || JSON_VALUE_PROTOTYPE_KEYS.has(literal);
}
function samePropertyKey(sourceCode, left, right) {
    if (sameExpression(sourceCode, left, right))
        return true;
    const a = literalPropertyKey(left);
    const b = literalPropertyKey(right);
    return a !== null && b !== null && a === b;
}
function isHasOwn(sourceCode, expression, object, key) {
    const candidate = unwrapExpression(expression);
    return (candidate.type === 'CallExpression' &&
        isGlobalMemberCall(sourceCode, candidate, 'Object', 'hasOwn') &&
        candidate.arguments.length >= 2 &&
        candidate.arguments[0]?.type !== 'SpreadElement' &&
        candidate.arguments[1]?.type !== 'SpreadElement' &&
        sameExpression(sourceCode, candidate.arguments[0], object) &&
        samePropertyKey(sourceCode, candidate.arguments[1], key));
}
function truthyHasOwnProof(sourceCode, expression, object, key) {
    const candidate = unwrapExpression(expression);
    if (isHasOwn(sourceCode, candidate, object, key)) {
        return candidate.type === 'CallExpression' ? candidate : null;
    }
    if (candidate.type !== 'LogicalExpression' || candidate.operator !== '&&')
        return null;
    return (truthyHasOwnProof(sourceCode, candidate.right, object, key) ??
        truthyHasOwnProof(sourceCode, candidate.left, object, key));
}
function falsyHasOwnProof(sourceCode, expression, object, key) {
    const candidate = unwrapExpression(expression);
    if (isUnaryNot(candidate)) {
        return truthyHasOwnProof(sourceCode, candidate.argument, object, key);
    }
    if (candidate.type !== 'LogicalExpression' || candidate.operator !== '||')
        return null;
    return (falsyHasOwnProof(sourceCode, candidate.right, object, key) ??
        falsyHasOwnProof(sourceCode, candidate.left, object, key));
}
function proofRemainsValid(sourceCode, mutations, proof, conditionEnd, continuationStart, accessStart, node) {
    const scope = sourceCode.getScope(node).variableScope;
    return (!hasPotentialMutationWithin(mutations, scope, proof.end, conditionEnd) &&
        !hasPotentialMutationWithin(mutations, scope, continuationStart, accessStart));
}
function guarded(sourceCode, mutations, node, object, key) {
    if (branchConditions(node).some(({ condition, truthy, branch }) => {
        const proof = truthy
            ? truthyHasOwnProof(sourceCode, condition, object, key)
            : falsyHasOwnProof(sourceCode, condition, object, key);
        return (proof !== null &&
            proofRemainsValid(sourceCode, mutations, proof, condition.end, branch.start, node.start, node));
    })) {
        return true;
    }
    return precedingTerminatingGuards(node).some(({ condition, boundary }) => {
        const proof = falsyHasOwnProof(sourceCode, condition, object, key);
        return (proof !== null &&
            proofRemainsValid(sourceCode, mutations, proof, condition.end, boundary, node.start, node));
    });
}
/** Require local own-property proof before dynamically indexing an externally sourced record. */
export const noUnsafeExternalRecordAccessRule = defineRule({
    meta: {
        type: 'problem',
        docs: {
            description: 'Require a locally provable Object.hasOwn guard before dynamic or prototype-sensitive computed access on JSON-derived records.',
        },
        messages: {
            unsafeAccess: 'Computed access on this {{origin}} record can read inherited Object.prototype members. Guard this exact object and key with Object.hasOwn, or use a Map/null-prototype record.',
        },
        schema: [
            {
                type: 'object',
                properties: { includeRecordParameters: { type: 'boolean' } },
                additionalProperties: false,
            },
        ],
        defaultOptions: [{ includeRecordParameters: false }],
    },
    createOnce(context) {
        const mutations = [];
        const recordMutation = (node) => {
            appendMutationEvidence(context.sourceCode, mutations, node);
        };
        return {
            Program() {
                mutations.length = 0;
            },
            AssignmentExpression: recordMutation,
            AwaitExpression: recordMutation,
            CallExpression: recordMutation,
            ImportExpression: recordMutation,
            MemberExpression(node) {
                if (node.computed) {
                    const includeRecordParameters = Object(context.options?.[0]).includeRecordParameters === true;
                    const origin = externalOrigin(context.sourceCode, node.object, includeRecordParameters);
                    if (origin !== null &&
                        needsOwnPropertyProof(node.property, origin) &&
                        !guarded(context.sourceCode, mutations, node, node.object, node.property)) {
                        context.report({
                            node,
                            messageId: 'unsafeAccess',
                            data: {
                                origin: origin === 'record-parameter' ? 'Record-parameter' : 'JSON-derived',
                            },
                        });
                    }
                }
                recordMutation(node);
            },
            NewExpression: recordMutation,
            SpreadElement: recordMutation,
            TaggedTemplateExpression: recordMutation,
            UnaryExpression(node) {
                if (node.operator === 'delete')
                    recordMutation(node);
            },
            UpdateExpression: recordMutation,
            YieldExpression: recordMutation,
        };
    },
});
