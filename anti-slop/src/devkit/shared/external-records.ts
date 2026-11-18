import type { ESTree, Scope, SourceCode, Variable } from '@oxlint/plugins';

export type ExternalOrigin = 'json' | 'json-inherited' | 'json-reviver' | 'record-parameter';

type TransparentExpression =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSAsExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSSatisfiesExpression
  | ESTree.TSTypeAssertion;

export function isTransparentExpression(node: ESTree.Node): node is TransparentExpression {
  return (
    node.type === 'ChainExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion'
  );
}

export function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (isTransparentExpression(current)) current = current.expression;
  return current;
}

export function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

export function stableConstInitializer(variable: Variable): ESTree.Expression | null {
  if (variable.defs.length !== 1) return null;
  const definition = variable.defs[0];
  if (definition?.type !== 'Variable' || definition.node.type !== 'VariableDeclarator') return null;
  const declaration = definition.node.parent;
  if (
    declaration.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const' ||
    definition.node.init === null ||
    variable.references.some((reference) => !reference.init && reference.isWrite())
  ) {
    return null;
  }
  return definition.node.init;
}

export function isGlobalIdentifier(
  sourceCode: SourceCode,
  node: ESTree.Expression,
  name: string,
): node is ESTree.IdentifierReference {
  return (
    node.type === 'Identifier' &&
    node.name === name &&
    (sourceCode.isGlobalReference(node) || resolveVariable(sourceCode, node) === null)
  );
}

export function isGlobalMemberCall(
  sourceCode: SourceCode,
  node: ESTree.CallExpression,
  owner: string,
  member: string,
): boolean {
  const callee = unwrapExpression(node.callee);
  return (
    callee.type === 'MemberExpression' &&
    isGlobalIdentifier(sourceCode, callee.object, owner) &&
    (callee.computed
      ? callee.property.type === 'Literal' && callee.property.value === member
      : callee.property.type === 'Identifier' && callee.property.name === member)
  );
}

function jsonParseOrigin(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): ExternalOrigin | null {
  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped.type === 'CallExpression' &&
    isGlobalMemberCall(sourceCode, unwrapped, 'JSON', 'parse')
  ) {
    const text = unwrapped.arguments[0];
    const reviver = unwrapped.arguments[1];
    const ordinaryParse =
      text?.type !== 'SpreadElement' &&
      (unwrapped.arguments.length === 1 ||
        (unwrapped.arguments.length >= 2 &&
          reviver?.type !== 'SpreadElement' &&
          reviver !== undefined &&
          isDefinitelyNonCallable(sourceCode, reviver)));
    return ordinaryParse ? 'json' : 'json-reviver';
  }
  return null;
}

/** Expressions whose runtime result cannot have [[Call]], so JSON.parse ignores them as revivers. */
function isDefinitelyNonCallable(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const candidate = unwrapExpression(expression);
  switch (candidate.type) {
    case 'ArrayExpression':
    case 'BinaryExpression':
    case 'Literal':
    case 'ObjectExpression':
    case 'TemplateLiteral':
    case 'UnaryExpression':
    case 'UpdateExpression':
      return true;
    case 'ConditionalExpression':
      return (
        isDefinitelyNonCallable(sourceCode, candidate.consequent) &&
        isDefinitelyNonCallable(sourceCode, candidate.alternate)
      );
    case 'Identifier':
      return ['Infinity', 'NaN', 'undefined'].some((name) =>
        isGlobalIdentifier(sourceCode, candidate, name),
      );
    case 'LogicalExpression':
      return (
        isDefinitelyNonCallable(sourceCode, candidate.left) &&
        isDefinitelyNonCallable(sourceCode, candidate.right)
      );
    case 'SequenceExpression': {
      const last = candidate.expressions.at(-1);
      return last !== undefined && isDefinitelyNonCallable(sourceCode, last);
    }
    default:
      return false;
  }
}

export function literalPropertyKey(expression: ESTree.Expression): string | null {
  const candidate = unwrapExpression(expression);
  if (candidate.type === 'TemplateLiteral' && candidate.expressions.length === 0) {
    return candidate.quasis[0]?.value.cooked ?? null;
  }
  if (
    candidate.type === 'UnaryExpression' &&
    (candidate.operator === '+' || candidate.operator === '-')
  ) {
    const argument = unwrapExpression(candidate.argument);
    if (argument.type === 'Literal' && argument.value === Number(argument.value)) {
      const value = Number(argument.value);
      return String(candidate.operator === '-' ? -value : value);
    }
    if (candidate.operator === '-' && argument.type === 'Literal' && 'bigint' in argument) {
      return String(-argument.value);
    }
  }
  if (candidate.type !== 'Literal') return null;
  if ('regex' in candidate) return null;
  return String(candidate.value);
}

export function memberKey(node: ESTree.MemberExpression): string | null {
  if (node.computed) return literalPropertyKey(node.property);
  return node.property.type === 'Identifier' ? node.property.name : null;
}

export const JSON_VALUE_PROTOTYPE_KEYS = new Set([
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

function isRecordType(type: ESTree.TSType): boolean {
  if (type.type === 'TSParenthesizedType') return isRecordType(type.typeAnnotation);
  if (type.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') return false;
  if (type.typeName.name === 'Record') return true;
  return (
    type.typeName.name === 'Readonly' &&
    type.typeArguments?.params.length === 1 &&
    isRecordType(type.typeArguments.params[0]!)
  );
}

function isRecordParameter(variable: Variable): boolean {
  if (variable.defs.length !== 1) return false;
  const definition = variable.defs[0];
  if (definition?.type !== 'Parameter' || definition.name.type !== 'Identifier') return false;
  const annotation = definition.name.typeAnnotation?.typeAnnotation;
  return annotation !== undefined && isRecordType(annotation);
}

/** Classify only provenance that a syntax/scope rule can establish in the current file. */
export function externalOrigin(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  includeRecordParameters = false,
  visited = new Set<Variable>(),
): ExternalOrigin | null {
  const unwrapped = unwrapExpression(expression);
  const jsonOrigin = jsonParseOrigin(sourceCode, unwrapped);
  if (jsonOrigin !== null) return jsonOrigin;
  if (unwrapped.type === 'MemberExpression') {
    const origin = externalOrigin(sourceCode, unwrapped.object, includeRecordParameters, visited);
    const key = memberKey(unwrapped);
    // A member that may be inherited (`parsed.toString`) is a function, not an ordinary JSON value.
    return origin === 'json' && key !== null && JSON_VALUE_PROTOTYPE_KEYS.has(key)
      ? 'json-inherited'
      : origin;
  }
  if (unwrapped.type !== 'Identifier') return null;
  const variable = resolveVariable(sourceCode, unwrapped);
  if (variable === null || visited.has(variable)) return null;
  if (includeRecordParameters && isRecordParameter(variable)) return 'record-parameter';
  const initializer = stableConstInitializer(variable);
  if (initializer === null) return null;
  visited.add(variable);
  return externalOrigin(sourceCode, initializer, includeRecordParameters, visited);
}

export function sameExpression(
  sourceCode: SourceCode,
  left: ESTree.Expression,
  right: ESTree.Expression,
): boolean {
  const a = unwrapExpression(left);
  const b = unwrapExpression(right);
  if (a.type === 'Identifier' && b.type === 'Identifier') {
    const leftVariable = resolveVariable(sourceCode, a);
    const rightVariable = resolveVariable(sourceCode, b);
    return (
      leftVariable !== null &&
      leftVariable === rightVariable &&
      leftVariable.references.every((reference) => reference.init || !reference.isWrite())
    );
  }
  if (a.type === 'Literal' && b.type === 'Literal') return a.value === b.value;
  if (a.type === 'ThisExpression' && b.type === 'ThisExpression') return true;
  return false;
}

export interface MutationEvidence {
  start: number;
  end: number;
  scopes: Scope[];
}

function runsDuringClassEvaluation(scope: Scope): boolean {
  const field = scope.block.parent;
  return (
    scope.type === 'class-static-block' ||
    (scope.type === 'class-field-initializer' &&
      (field?.type === 'PropertyDefinition' || field?.type === 'AccessorProperty') &&
      field.static)
  );
}

/** A static block or static field value runs while its class is evaluated, so it also mutates there. */
export function appendMutationEvidence(
  sourceCode: SourceCode,
  mutations: MutationEvidence[],
  node: ESTree.Node,
): void {
  const scopes = [sourceCode.getScope(node).variableScope];
  let scope = scopes[0]!;
  while (scope.upper !== null && runsDuringClassEvaluation(scope)) {
    scope = scope.upper.variableScope;
    scopes.push(scope);
  }
  mutations.push({ start: node.start, end: node.end, scopes });
}

export function hasPotentialMutationWithin(
  mutations: readonly MutationEvidence[],
  scope: Scope,
  start: number,
  end: number,
): boolean {
  return mutations.some(
    (mutation) => mutation.scopes.includes(scope) && mutation.start >= start && mutation.end <= end,
  );
}

function isTerminating(statement: ESTree.Statement): boolean {
  if (
    statement.type === 'ReturnStatement' ||
    statement.type === 'ThrowStatement' ||
    statement.type === 'ContinueStatement' ||
    statement.type === 'BreakStatement'
  ) {
    return true;
  }
  if (statement.type !== 'BlockStatement') return false;
  const last = statement.body.at(-1);
  return last !== undefined && isTerminating(last);
}

export function isFunctionBoundary(node: ESTree.Node): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  );
}

export interface TerminatingGuard {
  condition: ESTree.Expression;
  boundary: number;
}

export function precedingTerminatingGuards(node: ESTree.Node): TerminatingGuard[] {
  const guards: TerminatingGuard[] = [];
  let current: ESTree.Node = node;
  while (current.parent !== null) {
    if (isFunctionBoundary(current)) break;
    const parent = current.parent;
    if (parent.type === 'BlockStatement') {
      // SAFETY: A BlockStatement body contains statements, so its direct child is a Statement.
      const index = parent.body.indexOf(current as ESTree.Statement);
      if (index >= 0) {
        guards.push(
          ...parent.body
            .slice(0, index)
            .flatMap((statement) =>
              statement.type === 'IfStatement' &&
              statement.alternate === null &&
              isTerminating(statement.consequent)
                ? [{ condition: statement.test, boundary: statement.end }]
                : [],
            ),
        );
      }
    }
    current = parent;
  }
  return guards;
}

export interface BranchCondition {
  condition: ESTree.Expression;
  truthy: boolean;
  branch: ESTree.Node;
}

export function branchConditions(node: ESTree.Node): BranchCondition[] {
  const conditions: BranchCondition[] = [];
  let current: ESTree.Node = node;
  while (current.parent !== null) {
    if (isFunctionBoundary(current)) break;
    const parent = current.parent;
    if (
      parent.type === 'LogicalExpression' &&
      parent.operator === '&&' &&
      parent.right === current
    ) {
      conditions.push({ condition: parent.left, truthy: true, branch: current });
    } else if (parent.type === 'IfStatement') {
      if (parent.consequent === current) {
        conditions.push({ condition: parent.test, truthy: true, branch: current });
      }
      if (parent.alternate === current) {
        conditions.push({ condition: parent.test, truthy: false, branch: current });
      }
    } else if (parent.type === 'ConditionalExpression') {
      if (parent.consequent === current) {
        conditions.push({ condition: parent.test, truthy: true, branch: current });
      }
      if (parent.alternate === current) {
        conditions.push({ condition: parent.test, truthy: false, branch: current });
      }
    } else if (parent.type === 'WhileStatement' && parent.body === current) {
      conditions.push({ condition: parent.test, truthy: true, branch: current });
    } else if (parent.type === 'ForStatement' && parent.body === current && parent.test !== null) {
      conditions.push({ condition: parent.test, truthy: true, branch: current });
    }
    current = parent;
  }
  return conditions;
}

export function isUnaryNot(expression: ESTree.Expression): expression is ESTree.UnaryExpression {
  const unwrapped = unwrapExpression(expression);
  return unwrapped.type === 'UnaryExpression' && unwrapped.operator === '!';
}
