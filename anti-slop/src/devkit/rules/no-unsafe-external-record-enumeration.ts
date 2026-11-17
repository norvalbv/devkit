import { defineRule } from '@oxlint/plugins';
import {
  branchConditions,
  externalOrigin,
  isGlobalIdentifier,
  isGlobalMemberCall,
  isUnaryNot,
  precedingTerminatingGuards,
  sameExpression,
  unwrapExpression,
} from '../shared/external-records.ts';

import type { ESTree, SourceCode } from '@oxlint/plugins';
import type { ExternalOrigin } from '../shared/external-records.ts';

function isGlobalObjectCall(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  value: ESTree.Expression,
): boolean {
  const candidate = unwrapExpression(expression);
  const callee = candidate.type === 'CallExpression' ? unwrapExpression(candidate.callee) : null;
  return (
    candidate.type === 'CallExpression' &&
    callee?.type === 'Identifier' &&
    isGlobalIdentifier(sourceCode, callee, 'Object') &&
    candidate.arguments.length === 1 &&
    candidate.arguments[0]?.type !== 'SpreadElement' &&
    sameExpression(sourceCode, candidate.arguments[0]!, value)
  );
}

function objectComparison(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  value: ESTree.Expression,
  equal: boolean,
): boolean {
  const candidate = unwrapExpression(expression);
  if (candidate.type !== 'BinaryExpression') return false;
  if (candidate.operator !== (equal ? '===' : '!==')) return false;
  return (
    (isGlobalObjectCall(sourceCode, candidate.left, value) &&
      sameExpression(sourceCode, candidate.right, value)) ||
    (sameExpression(sourceCode, candidate.left, value) &&
      isGlobalObjectCall(sourceCode, candidate.right, value))
  );
}

function typeofObjectComparison(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  value: ESTree.Expression,
  equal: boolean,
): boolean {
  const candidate = unwrapExpression(expression);
  if (candidate.type !== 'BinaryExpression' || candidate.operator !== (equal ? '===' : '!==')) {
    return false;
  }
  const matches = (left: ESTree.Expression, right: ESTree.Expression) =>
    left.type === 'UnaryExpression' &&
    left.operator === 'typeof' &&
    sameExpression(sourceCode, left.argument, value) &&
    right.type === 'Literal' &&
    right.value === 'object';
  return matches(candidate.left, candidate.right) || matches(candidate.right, candidate.left);
}

function nullComparison(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  value: ESTree.Expression,
  equal: boolean,
): boolean {
  const candidate = unwrapExpression(expression);
  if (candidate.type !== 'BinaryExpression' || candidate.operator !== (equal ? '===' : '!==')) {
    return false;
  }
  const matches = (left: ESTree.Expression, right: ESTree.Expression) =>
    sameExpression(sourceCode, left, value) && right.type === 'Literal' && right.value === null;
  return matches(candidate.left, candidate.right) || matches(candidate.right, candidate.left);
}

function arrayCheck(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  value: ESTree.Expression,
  expected: boolean,
): boolean {
  const candidate = unwrapExpression(expression);
  if (!expected && isUnaryNot(candidate)) {
    return arrayCheck(sourceCode, candidate.argument, value, true);
  }
  return (
    expected &&
    candidate.type === 'CallExpression' &&
    isGlobalMemberCall(sourceCode, candidate, 'Array', 'isArray') &&
    candidate.arguments.length === 1 &&
    candidate.arguments[0]?.type !== 'SpreadElement' &&
    sameExpression(sourceCode, candidate.arguments[0]!, value)
  );
}

function findClause(
  expression: ESTree.Expression,
  operator: '&&' | '||',
  predicate: (clause: ESTree.Expression) => boolean,
): ESTree.Expression | null {
  const candidate = unwrapExpression(expression);
  if (predicate(candidate)) return candidate;
  if (candidate.type !== 'LogicalExpression' || candidate.operator !== operator) return null;
  return (
    findClause(candidate.right, operator, predicate) ??
    findClause(candidate.left, operator, predicate)
  );
}

interface RecordProof {
  identity: ESTree.Expression | null;
  objectType: ESTree.Expression | null;
  nonNull: ESTree.Expression | null;
  array: ESTree.Expression | null;
}

function recordParts(
  sourceCode: SourceCode,
  condition: ESTree.Expression,
  value: ESTree.Expression,
): RecordProof {
  return {
    identity: findClause(condition, '&&', (clause) =>
      objectComparison(sourceCode, clause, value, true),
    ),
    objectType: findClause(condition, '&&', (clause) =>
      typeofObjectComparison(sourceCode, clause, value, true),
    ),
    nonNull: findClause(condition, '&&', (clause) =>
      nullComparison(sourceCode, clause, value, false),
    ),
    array: findClause(condition, '&&', (clause) => arrayCheck(sourceCode, clause, value, false)),
  };
}

interface RejectionProof {
  identity: ESTree.Expression | null;
  nonObjectType: ESTree.Expression | null;
  nullValue: ESTree.Expression | null;
  array: ESTree.Expression | null;
}

function rejectionParts(
  sourceCode: SourceCode,
  condition: ESTree.Expression,
  value: ESTree.Expression,
): RejectionProof {
  return {
    identity: findClause(condition, '||', (clause) =>
      objectComparison(sourceCode, clause, value, false),
    ),
    nonObjectType: findClause(condition, '||', (clause) =>
      typeofObjectComparison(sourceCode, clause, value, false),
    ),
    nullValue: findClause(condition, '||', (clause) =>
      nullComparison(sourceCode, clause, value, true),
    ),
    array: findClause(condition, '||', (clause) => arrayCheck(sourceCode, clause, value, true)),
  };
}

function proven(required: readonly (ESTree.Expression | null)[]): boolean {
  return required.every((proof) => proof !== null);
}

/** Calls cannot change a const binding's typeof, null-ness or array-ness, so proofs never expire. */
function guarded(
  sourceCode: SourceCode,
  node: ESTree.CallExpression,
  value: ESTree.Expression,
  origin: Exclude<ExternalOrigin, 'record-parameter'>,
): boolean {
  if (
    branchConditions(node).some(({ condition, truthy }) => {
      if (truthy) {
        const proof = recordParts(sourceCode, condition, value);
        return (
          (origin === 'json' && proven([proof.identity, proof.array])) ||
          proven([proof.objectType, proof.nonNull, proof.array])
        );
      }
      const proof = rejectionParts(sourceCode, condition, value);
      return (
        (origin === 'json' && proven([proof.identity, proof.array])) ||
        proven([proof.nonObjectType, proof.nullValue, proof.array])
      );
    })
  ) {
    return true;
  }
  const combined = precedingTerminatingGuards(node).reduce<RejectionProof>(
    (known, { condition }) => {
      const next = rejectionParts(sourceCode, condition, value);
      return {
        identity: next.identity ?? known.identity,
        nonObjectType: next.nonObjectType ?? known.nonObjectType,
        nullValue: next.nullValue ?? known.nullValue,
        array: next.array ?? known.array,
      };
    },
    { identity: null, nonObjectType: null, nullValue: null, array: null },
  );
  return (
    (origin === 'json' && proven([combined.identity, combined.array])) ||
    proven([combined.nonObjectType, combined.nullValue, combined.array])
  );
}

/** Require local positive record-shape proof before enumerating a JSON-derived value. */
export const noUnsafeExternalRecordEnumerationRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require JSON-derived values to be proven non-primitive and non-array before object enumeration.',
    },
    messages: {
      unsafeEnumeration:
        'Object.{{method}} on an unproven JSON-derived value admits primitives as empty records. Prove a non-null object and reject arrays before enumeration.',
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
        if (
          method !== null &&
          node.arguments.length > 0 &&
          node.arguments[0]?.type !== 'SpreadElement'
        ) {
          const value = node.arguments[0]!;
          const origin = externalOrigin(context.sourceCode, value);
          if (
            origin !== null &&
            origin !== 'record-parameter' &&
            !guarded(context.sourceCode, node, value, origin)
          ) {
            context.report({ node, messageId: 'unsafeEnumeration', data: { method } });
          }
        }
      },
    };
  },
});
