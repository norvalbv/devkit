import { defineRule } from '@oxlint/plugins';
import {
  appendMutationEvidence,
  branchConditions,
  externalOrigin,
  hasPotentialMutationWithin,
  isFunctionBoundary,
  isGlobalMemberCall,
  isTransparentExpression,
  isUnaryNot,
  JSON_VALUE_PROTOTYPE_KEYS,
  literalPropertyKey,
  memberKey,
  precedingTerminatingGuards,
  resolveVariable,
  sameExpression,
  stableConstInitializer,
  unwrapExpression,
} from '../shared/external-records.ts';

import type { ESTree, SourceCode, Variable } from '@oxlint/plugins';
import type { ExternalOrigin, MutationEvidence } from '../shared/external-records.ts';

function rootIdentifier(expression: ESTree.Expression): ESTree.IdentifierReference | null {
  let current = unwrapExpression(expression);
  while (current.type === 'MemberExpression') current = unwrapExpression(current.object);
  return current.type === 'Identifier' ? current : null;
}

/** The outermost expression reached from `node` through member objects and transparent wrappers. */
function chainTop(node: ESTree.Node): ESTree.Node {
  let current = node;
  while (
    current.parent !== null &&
    ((current.parent.type === 'MemberExpression' && current.parent.object === current) ||
      isTransparentExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/** Whether a reference to the record is a setPrototypeOf target or a `__proto__` write or Reflect.set. */
function setsPrototype(sourceCode: SourceCode, identifier: ESTree.Node): boolean {
  const top = chainTop(identifier);
  const parent = top.parent;
  return (
    (top.type === 'MemberExpression' &&
      memberKey(top) === '__proto__' &&
      parent?.type === 'AssignmentExpression' &&
      parent.left === top) ||
    (parent?.type === 'CallExpression' &&
      parent.arguments[0] === top &&
      (isGlobalMemberCall(sourceCode, parent, 'Object', 'setPrototypeOf') ||
        isGlobalMemberCall(sourceCode, parent, 'Reflect', 'setPrototypeOf') ||
        (isGlobalMemberCall(sourceCode, parent, 'Reflect', 'set') &&
          parent.arguments[1]?.type !== 'SpreadElement' &&
          parent.arguments[1] !== undefined &&
          literalPropertyKey(parent.arguments[1]) === '__proto__')))
  );
}

/** The variable `object` is rooted at, followed back through const aliases such as `const a = parsed`. */
function aliasOrigin(sourceCode: SourceCode, object: ESTree.Expression): Variable | null {
  const seen = new Set<Variable>();
  let root = rootIdentifier(object);
  while (root !== null) {
    const variable = resolveVariable(sourceCode, root);
    if (variable === null || seen.has(variable)) break;
    seen.add(variable);
    const initializer = stableConstInitializer(variable);
    root = initializer === null ? null : rootIdentifier(initializer);
  }
  return [...seen].at(-1) ?? null;
}

/** Whether `object`'s origin, or any variable declared from it or its members, has its prototype set. */
function prototypeMayChange(sourceCode: SourceCode, object: ESTree.Expression): boolean {
  const origin = aliasOrigin(sourceCode, object);
  const family = origin === null ? [] : [origin];
  for (const variable of family) {
    for (const { identifier } of variable.references) {
      const top = chainTop(identifier);
      if (top.parent?.type === 'VariableDeclarator' && top.parent.init === top) {
        const aliases = sourceCode.getDeclaredVariables(top.parent);
        family.push(...aliases.filter((alias) => !family.includes(alias)));
      }
    }
  }
  return family.some((variable) =>
    variable.references.some((reference) => setsPrototype(sourceCode, reference.identifier)),
  );
}

const FUNCTION_PROTOTYPE_KEYS = new Set(Object.getOwnPropertyNames(Function.prototype));

function needsOwnPropertyProof(
  sourceCode: SourceCode,
  object: ESTree.Expression,
  key: ESTree.Expression,
  origin: ExternalOrigin,
): boolean {
  if (origin !== 'json' && origin !== 'json-inherited') return true;
  const literal = literalPropertyKey(key);
  return (
    literal === null ||
    JSON_VALUE_PROTOTYPE_KEYS.has(literal) ||
    (origin === 'json-inherited' && FUNCTION_PROTOTYPE_KEYS.has(literal)) ||
    prototypeMayChange(sourceCode, object)
  );
}

/** `child` runs again, or later, after code that follows it: a loop body or an instance field value. */
function rerunsChild(loop: ESTree.Node, child: ESTree.Node): boolean {
  switch (loop.type) {
    case 'PropertyDefinition':
    case 'AccessorProperty':
      return child === loop.value && !loop.static;
    case 'ForStatement':
      return child !== loop.init;
    case 'ForInStatement':
    case 'ForOfStatement':
      return child !== loop.right;
    case 'WhileStatement':
    case 'DoWhileStatement':
      return true;
    default:
      return false;
  }
}

function rerunScope(node: ESTree.Node): ESTree.Node | null {
  let current = node;
  while (current.parent !== null && !isFunctionBoundary(current)) {
    if (rerunsChild(current.parent, current)) return current.parent;
    current = current.parent;
  }
  return null;
}

function samePropertyKey(
  sourceCode: SourceCode,
  left: ESTree.Expression,
  right: ESTree.Expression,
): boolean {
  if (sameExpression(sourceCode, left, right)) return true;
  const a = literalPropertyKey(left);
  const b = literalPropertyKey(right);
  return a !== null && b !== null && a === b;
}

function isHasOwn(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  object: ESTree.Expression,
  key: ESTree.Expression,
): boolean {
  const candidate = unwrapExpression(expression);
  return (
    candidate.type === 'CallExpression' &&
    isGlobalMemberCall(sourceCode, candidate, 'Object', 'hasOwn') &&
    candidate.arguments.length >= 2 &&
    candidate.arguments[0]?.type !== 'SpreadElement' &&
    candidate.arguments[1]?.type !== 'SpreadElement' &&
    sameExpression(sourceCode, candidate.arguments[0]!, object) &&
    samePropertyKey(sourceCode, candidate.arguments[1]!, key)
  );
}

function truthyHasOwnProof(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  object: ESTree.Expression,
  key: ESTree.Expression,
): ESTree.CallExpression | null {
  const candidate = unwrapExpression(expression);
  if (isHasOwn(sourceCode, candidate, object, key)) {
    return candidate.type === 'CallExpression' ? candidate : null;
  }
  if (candidate.type !== 'LogicalExpression' || candidate.operator !== '&&') return null;
  return (
    truthyHasOwnProof(sourceCode, candidate.right, object, key) ??
    truthyHasOwnProof(sourceCode, candidate.left, object, key)
  );
}

function falsyHasOwnProof(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  object: ESTree.Expression,
  key: ESTree.Expression,
): ESTree.CallExpression | null {
  const candidate = unwrapExpression(expression);
  if (isUnaryNot(candidate)) {
    return truthyHasOwnProof(sourceCode, candidate.argument, object, key);
  }
  if (candidate.type !== 'LogicalExpression' || candidate.operator !== '||') return null;
  return (
    falsyHasOwnProof(sourceCode, candidate.right, object, key) ??
    falsyHasOwnProof(sourceCode, candidate.left, object, key)
  );
}

function proofRemainsValid(
  sourceCode: SourceCode,
  mutations: readonly MutationEvidence[],
  proof: ESTree.CallExpression,
  conditionEnd: number,
  continuationStart: number,
  accessStart: number,
  node: ESTree.Node,
): boolean {
  const scope = sourceCode.getScope(node).variableScope;
  return (
    !hasPotentialMutationWithin(mutations, scope, proof.end, conditionEnd) &&
    !hasPotentialMutationWithin(mutations, scope, continuationStart, accessStart)
  );
}

function guarded(
  sourceCode: SourceCode,
  mutations: readonly MutationEvidence[],
  node: ESTree.MemberExpression,
  object: ESTree.Expression,
  key: ESTree.Expression,
): boolean {
  // A proof made outside a loop or field initializer can be stale when the access runs again or later.
  const rerunStart = rerunScope(node)?.start ?? -1;
  if (
    branchConditions(node).some(({ condition, truthy, branch }) => {
      if (condition.start < rerunStart) return false;
      const proof = truthy
        ? truthyHasOwnProof(sourceCode, condition, object, key)
        : falsyHasOwnProof(sourceCode, condition, object, key);
      return (
        proof !== null &&
        proofRemainsValid(
          sourceCode,
          mutations,
          proof,
          condition.end,
          branch.start,
          node.start,
          node,
        )
      );
    })
  ) {
    return true;
  }
  return precedingTerminatingGuards(node).some(({ condition, boundary }) => {
    if (condition.start < rerunStart) return false;
    const proof = falsyHasOwnProof(sourceCode, condition, object, key);
    return (
      proof !== null &&
      proofRemainsValid(sourceCode, mutations, proof, condition.end, boundary, node.start, node)
    );
  });
}

/** Require local own-property proof before dynamically indexing an externally sourced record. */
export const noUnsafeExternalRecordAccessRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a locally provable Object.hasOwn guard before dynamic or prototype-sensitive computed access on JSON-derived records.',
    },
    messages: {
      unsafeAccess:
        'Computed access on this {{origin}} record can read inherited Object.prototype members. Guard this exact object and key with Object.hasOwn, or use a Map/null-prototype record.',
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
    const mutations: MutationEvidence[] = [];
    const recordMutation = (node: ESTree.Node) => {
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
          const includeRecordParameters =
            Object(context.options?.[0]).includeRecordParameters === true;
          const origin = externalOrigin(context.sourceCode, node.object, includeRecordParameters);
          if (
            origin !== null &&
            needsOwnPropertyProof(context.sourceCode, node.object, node.property, origin) &&
            !guarded(context.sourceCode, mutations, node, node.object, node.property)
          ) {
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
        if (node.operator === 'delete') recordMutation(node);
      },
      UpdateExpression: recordMutation,
      YieldExpression: recordMutation,
    };
  },
});
