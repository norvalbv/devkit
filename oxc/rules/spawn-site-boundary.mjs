import { definePlugin, defineRule } from '@oxlint/plugins';

/** @import { ESTree, SourceCode, Variable } from '@oxlint/plugins' */

// Only a blocked SYNC spawn starves vitest's testTimeout; an async child leaves the worker free.
const RAW_SYNC_SPAWNS = new Set(['spawnSync', 'execFileSync', 'execSync']);
const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);
const DEVKIT_ENTRY_RE = /\.sh\b|\b(?:index|cli)\.m[tj]s\b/;
const CARVE_OUT_RE = /\b(?:124-)?sentinel carve-out\b|\bsupervisor-subject carve-out\b/i;
// A lone git command: a shell operator could chain a script after it.
const GIT_PROGRAM_RE = /^git(?: [^;&|`$()<>\n]*)?$/;
const STATEMENT_KINDS = new Set([
  'ExpressionStatement',
  'ReturnStatement',
  'ThrowStatement',
  'VariableDeclaration',
]);
const FUNCTION_KINDS = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @returns {Variable | null}
 */
function resolveVariable(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * The module and exported name an identifier was imported as, or null for a local binding.
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @returns {{ source: string, name: string } | null}
 */
function importOf(sourceCode, identifier) {
  const definition = resolveVariable(sourceCode, identifier)?.defs.find(
    (def) => def.type === 'ImportBinding' && def.node.type === 'ImportSpecifier',
  );
  if (definition === undefined || definition.parent?.type !== 'ImportDeclaration') return null;
  const { imported } = definition.node;
  return {
    source: definition.parent.source.value,
    name: imported.type === 'Identifier' ? imported.name : imported.value,
  };
}

/**
 * Whether an argument names devkit's CLI binding, a shell script or a CLI entry module. A local
 * const is followed one level, so `const script = join(dir, 'x.sh')` still counts.
 * @param {SourceCode} sourceCode
 * @param {ESTree.Node | null} node
 * @param {number} depth
 * @returns {boolean}
 */
function namesDevkitEntry(sourceCode, node, depth) {
  if (node === null) return false;
  const recurse = (/** @type {ESTree.Node | null} */ child) =>
    namesDevkitEntry(sourceCode, child, depth);
  switch (node.type) {
    case 'Literal':
      return DEVKIT_ENTRY_RE.test(String(node.value));
    case 'TemplateLiteral':
      return (
        node.quasis.some((quasi) => DEVKIT_ENTRY_RE.test(quasi.value.cooked ?? quasi.value.raw)) ||
        node.expressions.some(recurse)
      );
    case 'ArrayExpression':
      return node.elements.some(recurse);
    case 'SpreadElement':
      return recurse(node.argument);
    case 'CallExpression':
      return node.arguments.some(recurse);
    case 'BinaryExpression':
      return recurse(node.left) || recurse(node.right);
    case 'Identifier':
      return identifierNamesDevkitEntry(sourceCode, node, depth);
    default:
      return false;
  }
}

/**
 * @param {SourceCode} sourceCode
 * @param {ESTree.IdentifierReference} identifier
 * @param {number} depth
 * @returns {boolean}
 */
function identifierNamesDevkitEntry(sourceCode, identifier, depth) {
  const imported = importOf(sourceCode, identifier);
  if (imported !== null) return imported.name === 'CLI' && imported.source.endsWith('_helpers.mts');
  if (depth > 0) return false;
  const definition = resolveVariable(sourceCode, identifier)?.defs.find(
    (def) => def.type === 'Variable' && def.parent?.kind === 'const',
  );
  const init = definition?.node.type === 'VariableDeclarator' ? definition.node.init : null;
  return namesDevkitEntry(sourceCode, init ?? null, depth + 1);
}

/**
 * git is a leaf verb even when a path it stages ends in .sh; a hook-dispatching commit is beyond
 * what a syntax rule can see.
 * @param {ESTree.Node | undefined} program
 * @returns {boolean}
 */
function runsGit(program) {
  return program?.type === 'Literal' && GIT_PROGRAM_RE.test(String(program.value));
}

/**
 * A carve-out names itself inside the call or in a comment leading its statement — never on an
 * enclosing function or `it()` docblock.
 * @param {SourceCode} sourceCode
 * @param {ESTree.CallExpression} call
 * @returns {boolean}
 */
function namesCarveOut(sourceCode, call) {
  const matches = (/** @type {{ value: string }} */ comment) => CARVE_OUT_RE.test(comment.value);
  if (sourceCode.getCommentsInside(call).some(matches)) return true;
  /** @type {ESTree.Node} */
  let current = call;
  while (!FUNCTION_KINDS.has(current.type)) {
    if (sourceCode.getCommentsBefore(current).some(matches)) return true;
    if (STATEMENT_KINDS.has(current.type) || current.parent.type === 'Program') return false;
    current = current.parent;
  }
  return false;
}

/** devkit's CLI, gates and shipped scripts run through the supervised test helpers. */
export const spawnSiteBoundaryRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        "Require supervised test helpers for sync spawns of devkit's CLI, a gate or a shipped script.",
    },
    messages: {
      rawSpawn:
        'Run this through testSpawnSync/testExecFileSync from cli/__tests__/_helpers.mts. Only a ' +
        '124-sentinel or supervisor-subject carve-out stays raw, named in a comment at the call.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        const imported = importOf(sourceCode, node.callee);
        if (imported === null || !CHILD_PROCESS.has(imported.source)) return;
        if (!RAW_SYNC_SPAWNS.has(imported.name) || runsGit(node.arguments[0])) return;
        if (!node.arguments.some((arg) => namesDevkitEntry(sourceCode, arg, 0))) return;
        if (namesCarveOut(sourceCode, node)) return;
        context.report({ node, messageId: 'rawSpawn' });
      },
    };
  },
});

export default definePlugin({
  meta: { name: 'devkit' },
  rules: { 'spawn-site-boundary': spawnSiteBoundaryRule },
});
