import type { ESTree, Scope, SourceCode, Variable } from '#oxlint-plugins';

export type ExternalOrigin = 'json' | 'json-reviver' | 'record-parameter';

type TransparentExpression =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSAsExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSSatisfiesExpression
  | ESTree.TSTypeAssertion;

function isTransparentExpression(node: ESTree.Expression): node is TransparentExpression {
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

function resolveVariable(
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

function stableConstInitializer(variable: Variable): ESTree.Expression | null {
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
    return externalOrigin(sourceCode, unwrapped.object, includeRecordParameters, visited);
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
  scope: Scope;
}

export function appendMutationEvidence(
  sourceCode: SourceCode,
  mutations: MutationEvidence[],
  node: ESTree.Node,
): void {
  mutations.push({
    start: node.start,
    end: node.end,
    scope: sourceCode.getScope(node).variableScope,
  });
}

export function hasPotentialMutationWithin(
  mutations: readonly MutationEvidence[],
  scope: Scope,
  start: number,
  end: number,
): boolean {
  return mutations.some(
    (mutation) => mutation.scope === scope && mutation.start >= start && mutation.end <= end,
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

function isFunctionBoundary(node: ESTree.Node): boolean {
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
