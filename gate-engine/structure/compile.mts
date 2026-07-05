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

import { STRUCTURE_TOKENS, tokenRegex } from './grammar.mts';

// One grammar node (also the shape of a rule body and the tree root). Every field is optional:
// a node may declare literal files, named subfolders, a recurse dispatch, a domain gate, an
// existence assertion, and (for rules) a folderName constraint. Exported (with Grammar/TreeSpec)
// as the single grammar-shape source the sibling walker (walk.mts) + eslint layer (eslint-config.mts)
// reuse — one declaration, no drift.
export interface GrammarNode {
  files?: string[];
  folders?: Record<string, GrammarNode>;
  recurse?: string | string[];
  domainGate?: string;
  enforceExistence?: unknown;
  folderName?: string;
}

// A tree's grammar root: a node that also carries the named `rules` map recurse ids resolve against.
export interface Grammar extends GrammarNode {
  rules?: Record<string, GrammarNode>;
}

// One structure.trees[] entry. compileToEslint reads root/grammar/entryAllowlist/ignoredDirs; the
// remaining fields (libDomains/frozenDirs/sourceExtensions) are optional so the same interface serves
// the walker + eslint layer, which need them. `name`/`root` are always present (the guard.config
// tree contract) — the eslint layer keys per-tree baselines by `name`.
export interface TreeSpec {
  name: string;
  root: string;
  grammar?: Grammar;
  libDomains?: Record<string, string[]>;
  entryAllowlist?: string[];
  ignoredDirs?: string[];
  frozenDirs?: string[];
  sourceExtensions?: string[];
}

// A child entry in the plugin's Rule tree: a named folder/file, a {ruleId} dispatch, nested children,
// and/or an enforceExistence flag. Shapes are partial by node kind, so all fields are optional.
interface CompiledChild {
  name?: string;
  ruleId?: string;
  children?: CompiledChild[];
  enforceExistence?: unknown;
}

// The compiled form of one node: its children[] plus an optional passed-through enforceExistence.
interface CompiledNode {
  children: CompiledChild[];
  enforceExistence?: unknown;
}

// The generated grandfather list + permanent exempts fed into ignorePatterns.
interface CompileOpts {
  baseline?: string[];
  exempt?: string[];
}

// The plugin matches a file's path RELATIVE to structureRoot, and the structure ROOT node's `name`
// must be the structureRoot's last path segment (NOT the tree's logical name) — else nothing matches
// and the rule silently passes everything. `src` → `src`; `src/renderer` → `renderer`.
const rootName = (root: string): string => root.split('/').filter(Boolean).pop() ?? root;

const NON_ALNUM = /[^a-z0-9]/gi;
// A libDomains key → a valid regexParameter token name: '@root' → 'root_domain', 'lib' → 'lib_domain'.
const domainParam = (key: string): string => `${key.replace(NON_ALNUM, '')}_domain`;

/** Base token table + one closed-registry alternation per libDomains key. */
function buildRegexParameters(treeSpec: TreeSpec, exts: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const t of STRUCTURE_TOKENS) params[t] = tokenRegex(t, exts);
  for (const [key, names] of Object.entries(treeSpec.libDomains ?? {})) {
    // Empty registry → '^$' (matches nothing); existing folders are grandfathered via the baseline.
    params[domainParam(key)] = names.length ? `^(${names.join('|')})$` : '^$';
  }
  return params;
}

// The child entries for a node's UNnamed subfolders (an array, possibly empty):
//  - domainGate → a registered-domain folder: NAME matches the closed registry, CONTENTS follow the
//    recurse rule (inline that rule's children, not a folder-matching {ruleId}).
//  - recurse: id | id[] → one `{ ruleId }` per id (the plugin dispatches first-match across siblings,
//    e.g. react-app pages → pageFolder OR componentFolder).
function recurseChildren(node: GrammarNode, grammar: Grammar): CompiledChild[] {
  if (node.domainGate) {
    const id = Array.isArray(node.recurse) ? node.recurse[0] : node.recurse;
    const rule = id != null ? grammar.rules?.[id] : undefined;
    const ruleChildren = rule ? compileNode(rule, grammar).children : [];
    return [{ name: `{${domainParam(node.domainGate)}}`, children: ruleChildren }];
  }
  if (!node.recurse) return [];
  const ids = Array.isArray(node.recurse) ? node.recurse : [node.recurse];
  return ids.map((id) => ({ ruleId: id }));
}

/** Compile a grammar node → the plugin's children[] (+ enforceExistence). `grammar` carries rules. */
function compileNode(node: GrammarNode, grammar: Grammar): CompiledNode {
  const children: CompiledChild[] = (node.files ?? []).map((p) => ({ name: p }));
  for (const [fname, sub] of Object.entries(node.folders ?? {})) {
    children.push({ name: fname, ...compileNode(sub, grammar) });
  }
  children.push(...recurseChildren(node, grammar));
  const out: CompiledNode = { children };
  if (node.enforceExistence) out.enforceExistence = node.enforceExistence;
  return out;
}

/** Compile grammar.rules → the plugin's `rules` map (one FolderRecursionRule per id). */
function compileRules(grammar: Grammar) {
  const rules: Record<string, CompiledChild> = {};
  for (const [id, rule] of Object.entries(grammar.rules ?? {})) {
    rules[id] = { name: rule.folderName ?? '{kebab_dir}', ...compileNode(rule, grammar) };
  }
  return rules;
}

/**
 * Build the `createFolderStructure(...)` config object for one tree. `treeSpec` is one
 * structure.trees[] entry (grammar trees only — presets compile elsewhere), `exts` the tree's
 * resolved source extensions, `opts` the generated grandfather list + permanent exempts.
 */
export function compileToEslint(treeSpec: TreeSpec, exts: string[], opts: CompileOpts = {}) {
  const grammar: Grammar = treeSpec.grammar ?? {};
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
    structure: { name: rootName(treeSpec.root), children: compileNode(rootNode, grammar).children },
  };
}
