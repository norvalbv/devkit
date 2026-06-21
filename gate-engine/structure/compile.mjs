/**
 * compileToEslint — the OTHER half of declare-once. Translates one `structure.trees[]` grammar into an
 * `eslint-plugin-project-structure` `createFolderStructure(...)` config object. The generated
 * eslint.config shim feeds the result to the plugin, so the in-IDE squiggles + commit gate come from
 * the SAME spec that drives the baseline walk (walk.mjs). No hand-written per-tree eslint rule.
 *
 * Mapping (my grammar node → the plugin's Rule tree):
 *   node.files[]              → children `{ name: '<literal>' | '{token}' }`  (plugin resolves {token} via regexParameters)
 *   node.folders{n: sub}      → child `{ name: n, children: compile(sub) }`
 *   node.recurse: id          → child `{ ruleId: id }` (+ rules[id] in the rules map)
 *   node.domainGate: key      → child `{ name: '{<key>_domain}', children: <recurse rule's children> }`
 *   node.enforceExistence     → `enforceExistence` on that node
 *   __tests__                 → always allowed (the walker skips it; tests are wall-free)
 *
 * regexParameters = the canonical token table (tokenRegex, per the tree's exts) + one `<key>_domain`
 * alternation per libDomains key. ignorePatterns = ignoredDirs globs + the generated baseline + exempt.
 */

import { STRUCTURE_TOKENS, tokenRegex } from './grammar.mjs';

const NON_ALNUM = /[^a-z0-9]/gi;
// A libDomains key → a valid regexParameter token name: '@root' → 'root_domain', 'lib' → 'lib_domain'.
const domainParam = (key) => `${key.replace(NON_ALNUM, '')}_domain`;

/** Base token table + one closed-registry alternation per libDomains key. */
function buildRegexParameters(treeSpec, exts) {
  const params = {};
  for (const t of STRUCTURE_TOKENS) params[t] = tokenRegex(t, exts);
  for (const [key, names] of Object.entries(treeSpec.libDomains ?? {})) {
    // Empty registry → '^$' (matches nothing); existing folders are grandfathered via the baseline.
    params[domainParam(key)] = names.length ? `^(${names.join('|')})$` : '^$';
  }
  return params;
}

// The child entry for a node's UNnamed subfolders, or null when the node has none:
//  - domainGate → a registered-domain folder: NAME matches the closed registry, CONTENTS follow the
//    recurse rule (inline that rule's children, not a folder-matching {ruleId}).
//  - recurse    → a plain `{ ruleId }` reference into the rules map.
function recurseChild(node, grammar) {
  if (node.domainGate) {
    const rule = grammar.rules?.[node.recurse];
    const ruleChildren = rule ? compileNode(rule, grammar).children : [];
    return { name: `{${domainParam(node.domainGate)}}`, children: ruleChildren };
  }
  return node.recurse ? { ruleId: node.recurse } : null;
}

/** Compile a grammar node → the plugin's children[] (+ enforceExistence). `grammar` carries rules. */
function compileNode(node, grammar) {
  const children = (node.files ?? []).map((p) => ({ name: p }));
  for (const [fname, sub] of Object.entries(node.folders ?? {})) {
    children.push({ name: fname, ...compileNode(sub, grammar) });
  }
  const rc = recurseChild(node, grammar);
  if (rc) children.push(rc);
  const out = { children };
  if (node.enforceExistence) out.enforceExistence = node.enforceExistence;
  return out;
}

/** Compile grammar.rules → the plugin's `rules` map (one FolderRecursionRule per id). */
function compileRules(grammar) {
  const rules = {};
  for (const [id, rule] of Object.entries(grammar.rules ?? {})) {
    rules[id] = { name: rule.folderName ?? '{kebab_dir}', ...compileNode(rule, grammar) };
  }
  return rules;
}

/**
 * Build the `createFolderStructure(...)` config object for one tree.
 *
 * @param {object} treeSpec one structure.trees[] entry (grammar trees only — presets compile elsewhere)
 * @param {string[]} exts the tree's resolved source extensions
 * @param {{baseline?:string[], exempt?:string[]}} [opts] the generated grandfather list + permanent exempts
 * @returns {object} a createFolderStructure config
 */
export function compileToEslint(treeSpec, exts, opts = {}) {
  const grammar = treeSpec.grammar ?? {};
  const rootFiles = [...new Set([...(grammar.files ?? []), ...(treeSpec.entryAllowlist ?? [])])];
  const rootNode = { ...grammar, files: rootFiles };
  return {
    structureRoot: treeSpec.root,
    ignorePatterns: [
      // `__tests__` is wall-free (walk.mjs skips it) → ignore it here too, exactly, rather than
      // enumerate allowed test-file shapes (which would reject helpers/fixtures the walker permits).
      '**/__tests__/**',
      // `**/<dir>/**` matches at ANY depth — the walker ignores ignoredDirs by NAME (any depth), so
      // the emitted glob must too (a plain `<dir>/**` would only catch a top-level dir → drift).
      ...(treeSpec.ignoredDirs ?? []).map((d) => `**/${d}/**`),
      ...(opts.baseline ?? []),
      ...(opts.exempt ?? []),
    ],
    regexParameters: buildRegexParameters(treeSpec, exts),
    rules: compileRules(grammar),
    structure: { name: treeSpec.name, children: compileNode(rootNode, grammar).children },
  };
}
