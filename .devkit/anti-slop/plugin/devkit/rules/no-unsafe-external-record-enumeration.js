import { defineRule } from '#oxlint-plugins';
import { appendMutationEvidence, branchConditions, externalOrigin, isGlobalIdentifier, isGlobalMemberCall, isUnaryNot, precedingTerminatingGuards, sameExpression, unwrapExpression, } from '../shared/external-records.js';
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
function recordParts(sourceCode, condition, value) {
    return {
        identity: findClause(condition, '&&', (clause) => objectComparison(sourceCode, clause, value, true)),
        objectType: findClause(condition, '&&', (clause) => typeofObjectComparison(sourceCode, clause, value, true)),
        nonNull: findClause(condition, '&&', (clause) => nullComparison(sourceCode, clause, value, false)),
        array: findClause(condition, '&&', (clause) => arrayCheck(sourceCode, clause, value, false)),
    };
}
function rejectionParts(sourceCode, condition, value) {
    return {
        identity: findClause(condition, '||', (clause) => objectComparison(sourceCode, clause, value, false)),
        nonObjectType: findClause(condition, '||', (clause) => typeofObjectComparison(sourceCode, clause, value, false)),
        nullValue: findClause(condition, '||', (clause) => nullComparison(sourceCode, clause, value, true)),
        array: findClause(condition, '||', (clause) => arrayCheck(sourceCode, clause, value, true)),
    };
}
function recordProofExpressions(proof) {
    return [proof.identity, proof.objectType, proof.nonNull, proof.array].filter((expression) => expression !== null);
}
function rejectionProofExpressions(proof) {
    return [proof.identity, proof.nonObjectType, proof.nullValue, proof.array].filter((expression) => expression !== null);
}
function proofCandidateRemainsValid(mutations, scope, required, trustedProofs, mutationRanges, ignoredRanges = []) {
    return required.every((proof) => proof !== null &&
        !mutations.some((mutation) => mutation.scope === scope &&
            mutationRanges(proof).some((range) => mutation.start >= range.start && mutation.end <= range.end) &&
            !trustedProofs.some((trusted) => mutation.start >= trusted.start && mutation.end <= trusted.end) &&
            !ignoredRanges.some((range) => mutation.start >= range.start && mutation.end <= range.end)));
}
function guarded(sourceCode, mutations, node, value, origin) {
    if (branchConditions(node).some(({ condition, truthy, branch }) => {
        const scope = sourceCode.getScope(node).variableScope;
        const mutationRanges = (proof) => [
            { start: proof.end, end: condition.end },
            { start: branch.start, end: node.start },
        ];
        if (truthy) {
            const proof = recordParts(sourceCode, condition, value);
            const trustedProofs = recordProofExpressions(proof);
            return ((origin === 'json' &&
                proofCandidateRemainsValid(mutations, scope, [proof.identity, proof.array], trustedProofs, mutationRanges)) ||
                proofCandidateRemainsValid(mutations, scope, [proof.objectType, proof.nonNull, proof.array], trustedProofs, mutationRanges));
        }
        const proof = rejectionParts(sourceCode, condition, value);
        const trustedProofs = rejectionProofExpressions(proof);
        return ((origin === 'json' &&
            proofCandidateRemainsValid(mutations, scope, [proof.identity, proof.array], trustedProofs, mutationRanges)) ||
            proofCandidateRemainsValid(mutations, scope, [proof.nonObjectType, proof.nullValue, proof.array], trustedProofs, mutationRanges));
    })) {
        return true;
    }
    const guards = precedingTerminatingGuards(node)
        .sort((left, right) => left.condition.start - right.condition.start)
        .map(({ condition, boundary }) => ({
        condition,
        boundary,
        proof: rejectionParts(sourceCode, condition, value),
    }));
    const combined = guards.reduce((known, { proof: next }) => {
        return {
            identity: next.identity ?? known.identity,
            nonObjectType: next.nonObjectType ?? known.nonObjectType,
            nullValue: next.nullValue ?? known.nullValue,
            array: next.array ?? known.array,
        };
    }, { identity: null, nonObjectType: null, nullValue: null, array: null });
    const scope = sourceCode.getScope(node).variableScope;
    const trustedProofs = guards.flatMap(({ proof }) => rejectionProofExpressions(proof));
    const mutationRanges = (proof) => [{ start: proof.end, end: node.start }];
    const ignoredRanges = guards.map(({ condition, boundary }) => ({
        start: condition.end,
        end: boundary,
    }));
    return ((origin === 'json' &&
        proofCandidateRemainsValid(mutations, scope, [combined.identity, combined.array], trustedProofs, mutationRanges, ignoredRanges)) ||
        proofCandidateRemainsValid(mutations, scope, [combined.nonObjectType, combined.nullValue, combined.array], trustedProofs, mutationRanges, ignoredRanges));
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
                    if ((origin === 'json' || origin === 'json-reviver') &&
                        !guarded(context.sourceCode, mutations, node, value, origin)) {
                        context.report({ node, messageId: 'unsafeEnumeration', data: { method } });
                    }
                }
                recordMutation(node);
            },
            ImportExpression: recordMutation,
            MemberExpression(node) {
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
