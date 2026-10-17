import { defineRule } from '@oxlint/plugins';
import {
  isGlobalMemberCall,
  resolveVariable,
  stableConstInitializer,
  unwrapExpression,
} from '../shared/external-records.ts';

import type { ESTree, SourceCode } from '@oxlint/plugins';

const ORDERING_MATCHERS = new Set([
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
]);

/** The expression itself, or the initializer of the stable `const` it names (one hop only). */
function constValue(sourceCode: SourceCode, expression: ESTree.Expression): ESTree.Expression {
  const candidate = unwrapExpression(expression);
  if (candidate.type !== 'Identifier') return candidate;
  const variable = resolveVariable(sourceCode, candidate);
  const init = variable === null ? null : stableConstInitializer(variable);
  return init === null ? candidate : unwrapExpression(init);
}

const PERF_HOOKS_MODULES = new Set(['node:perf_hooks', 'perf_hooks']);

/** `performance` imported from Node's perf_hooks, under any local name. */
function isPerfHooksPerformance(sourceCode: SourceCode, node: ESTree.Expression): boolean {
  if (node.type !== 'Identifier') return false;
  const definition = resolveVariable(sourceCode, node)?.defs[0];
  if (definition?.type !== 'ImportBinding' || definition.node.type !== 'ImportSpecifier') {
    return false;
  }
  const { imported, parent } = definition.node;
  const name = imported.type === 'Identifier' ? imported.name : imported.value;
  return (
    name === 'performance' &&
    parent.type === 'ImportDeclaration' &&
    PERF_HOOKS_MODULES.has(parent.source.value)
  );
}

function isClockRead(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const value = constValue(sourceCode, expression);
  if (value.type !== 'CallExpression') return false;
  if (
    isGlobalMemberCall(sourceCode, value, 'Date', 'now') ||
    isGlobalMemberCall(sourceCode, value, 'performance', 'now')
  ) {
    return true;
  }
  const callee = unwrapExpression(value.callee);
  return isNamedProperty(callee, 'now') && isPerfHooksPerformance(sourceCode, callee.object);
}

/** A clock read minus anything (a start, a deadline, a parameter), or a const holding one. */
function isElapsedTime(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const value = constValue(sourceCode, expression);
  return (
    value.type === 'BinaryExpression' &&
    value.operator === '-' &&
    isClockRead(sourceCode, value.left)
  );
}

function isNamedProperty(node: ESTree.Expression, name: string): node is ESTree.MemberExpression {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === name
  );
}

function isExpectCallee(callee: ESTree.Expression): boolean {
  if (callee.type === 'Identifier') return callee.name === 'expect';
  return (
    isNamedProperty(callee, 'soft') &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect'
  );
}

/** The subject of `expect(subject)` or `expect.soft(subject)` behind an ordering matcher. */
function orderedAssertionSubject(callee: ESTree.Expression): ESTree.Expression | null {
  const matcher = unwrapExpression(callee);
  if (
    matcher.type !== 'MemberExpression' ||
    matcher.computed ||
    matcher.property.type !== 'Identifier' ||
    !ORDERING_MATCHERS.has(matcher.property.name)
  ) {
    return null;
  }
  let assertion = unwrapExpression(matcher.object);
  if (isNamedProperty(assertion, 'not')) assertion = unwrapExpression(assertion.object);
  if (assertion.type !== 'CallExpression' || !isExpectCallee(unwrapExpression(assertion.callee))) {
    return null;
  }
  const subject = assertion.arguments[0];
  return subject === undefined || subject.type === 'SpreadElement' ? null : subject;
}

export const noElapsedTimeAssertionsRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reject test assertions that compare elapsed wall-clock time against a budget or a floor.',
    },
    messages: {
      elapsedTimeAssertion:
        'This asserts elapsed wall-clock time. An upper bound fails on a loaded machine with nothing wrong, and raising a lower bound only makes it flakier. Assert the observable outcome (exit status, error text, reaped process, file written); the per-test timeout already catches a hang.',
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const subject = orderedAssertionSubject(node.callee);
        if (subject !== null && isElapsedTime(context.sourceCode, subject)) {
          context.report({ node, messageId: 'elapsedTimeAssertion' });
        }
      },
    };
  },
});
