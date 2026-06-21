/**
 * The ONE generic folder-structure walker. Drives the grandfather baseline from a declared `grammar`
 * (guard.config.json `structure.trees[].grammar`) instead of a hand-written per-tree walker. Covers the
 * kebab-module / flat-component-lib / domain-gated shapes (devkit's own `cli/`+`gate-engine/`,
 * frink-primitives, node-backend, most nextjs `lib/`). The intricate frink electron renderer/main
 * trees stay as the `electron` PRESET (generate-structure-baseline.mjs) — see 01-generalize-engine.md.
 *
 * Returns a sorted string[] of tree-relative violator paths (the grandfather set). Like the preset
 * walkers it ONLY seeds the baseline — the ratchet (eslint ignorePatterns / freeze-gate) is the gate.
 * Verbatim semantics preserved: capture EVERY file in a broken folder (not just one); an empty domain
 * registry grandfathers existing folders; folder-level entries are skipped (grandfather files only).
 *
 * A grammar NODE describes the rules for one directory's contents:
 *   { files?, folders?, recurse?, domainGate?, enforceExistence? }
 *   - files: allowed file patterns (literals + {token}s, resolved per the tree's sourceExtensions)
 *   - folders: named child folders → each maps to a child node
 *   - recurse: rule id (in grammar.rules) for UNnamed child folders
 *   - domainGate: a libDomains key; this node's child FOLDERS must be registered there (else broken)
 *   - enforceExistence: this directory must contain this file (else the directory is broken)
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { matchesFolderName, resolvePatterns } from './grammar.mjs';

/**
 * @param {object} treeSpec one entry of structure.trees: { root, grammar, libDomains?, frozenDirs?, ignoredDirs?, entryAllowlist? }
 * @param {string} absRoot absolute path to the tree root (cwd + treeSpec.root)
 * @param {string[]} exts the tree's resolved source extensions
 * @returns {string[]} sorted tree-relative violator paths
 */
export function walkTree(treeSpec, absRoot, exts) {
  const out = new Set();
  const ignored = new Set(treeSpec.ignoredDirs ?? []);
  const frozen = new Set(treeSpec.frozenDirs ?? []);
  const libDomains = treeSpec.libDomains ?? {};
  const rules = treeSpec.grammar?.rules ?? {};

  // Grandfather files only — never folder-level entries (new files under a legacy folder must fail).
  const add = (p) => {
    if (!p.endsWith('/')) out.add(p);
  };

  // Every file under a broken/frozen/unexpected dir is grandfathered debt.
  const allFiles = (rel) => {
    for (const e of readdirSync(join(absRoot, rel), { withFileTypes: true })) {
      const c = `${rel}/${e.name}`;
      if (e.isFile()) add(c);
      else allFiles(c);
    }
  };

  // Resolve the child grammar node for a directory: a named folder mapping, or the node's `recurse`
  // rule, or — when domain-gated — the recurse rule with a broken flag from registry membership.
  // Reason: the branches ARE the folder-structure rule reproduced as a walk — one arm per entry kind
  // (file ok/violator, ignored/tests/frozen dir, named folder, domain-gated, recurse, unexpected);
  // each arm is trivial and nesting is shallow, but the COUNT is high. Splitting scatters one traversal.
  // fallow-ignore-next-line complexity
  function walk(rel, node, broken) {
    if (!node) {
      allFiles(rel); // no grammar for this dir → grandfather it all
      return;
    }
    const abs = rel ? join(absRoot, rel) : absRoot;
    const entries = readdirSync(abs, { withFileTypes: true });
    const fileOK = resolvePatterns(node.files, exts);
    const nodeBroken =
      broken ||
      (node.enforceExistence &&
        !entries.some((e) => e.isFile() && e.name === node.enforceExistence));

    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) {
        if (nodeBroken || !fileOK(e.name)) add(childRel);
        continue;
      }
      // directory
      if (ignored.has(e.name)) continue;
      if (e.name === '__tests__') {
        if (nodeBroken) allFiles(childRel); // tests are wall-free unless the parent is already broken
        continue;
      }
      if (frozen.has(e.name)) {
        allFiles(childRel); // one-way door: every descendant grandfathered
        continue;
      }
      const named = node.folders?.[e.name];
      if (named) {
        walk(childRel, named, nodeBroken);
      } else if (node.domainGate) {
        const registered = (libDomains[node.domainGate] ?? []).includes(e.name);
        walk(childRel, rules[node.recurse], nodeBroken || !registered);
      } else if (node.recurse) {
        const rule = rules[node.recurse];
        const cb = nodeBroken || !matchesFolderName(e.name, rule?.folderName, exts);
        walk(childRel, rule, cb);
      } else {
        add(`${childRel}/`); // unexpected folder in a flat/leaf tree
        allFiles(childRel);
      }
    }
  }

  // Root node = the tree's grammar, with entryAllowlist merged into its allowed root files.
  const rootNode = {
    ...treeSpec.grammar,
    files: [...(treeSpec.grammar?.files ?? []), ...(treeSpec.entryAllowlist ?? [])],
  };
  walk('', rootNode, false);
  return [...out].sort();
}
