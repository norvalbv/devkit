/**
 * GENERATED SHIM — do not encode topology here. The folder-structure rules are compiled from the
 * `structure` block of guard.config.json by gate-engine/structure/compile.mjs (the same spec that
 * drives the baseline walk), so the in-IDE squiggles + commit gate can't drift from the baseline.
 * To change the structure, edit guard.config.json `structure`, then regenerate baselines (`devkit init`).
 *
 * This is devkit dogfooding its own headline feature: it governs its own `.mjs` `cli/`+`gate-engine/`
 * layout — exactly what the old frink-hardcoded engine could not do.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFolderStructure,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';
import { resolveGuardConfig, resolveTreeExtensions } from './gate-engine/config.mjs';
import { compileToEslint } from './gate-engine/structure/compile.mjs';

const cwd = process.cwd();
const cfg = resolveGuardConfig(cwd);

// A tree's generated grandfather baseline = the single array exported by eslint/baselines/<name>.mjs.
async function loadBaseline(name) {
  const f = join(cwd, 'eslint', 'baselines', `${name}.mjs`);
  if (!existsSync(f)) return [];
  const mod = await import(pathToFileURL(f).href);
  return Object.values(mod)[0] ?? [];
}

// Permanent, hand-edited exemptions keyed by tree name (eslint/baselines/exempt.mjs → structureExempt).
async function loadExempt(name) {
  const f = join(cwd, 'eslint', 'baselines', 'exempt.mjs');
  if (!existsSync(f)) return [];
  const mod = await import(pathToFileURL(f).href);
  return mod.structureExempt?.[name] ?? [];
}

const configs = [];
for (const tree of cfg.structure?.trees ?? []) {
  if (!tree.grammar) continue; // preset trees (electron) compile via their own path, not this shim
  const exts = resolveTreeExtensions(cfg, tree);
  const rule = compileToEslint(tree, exts, {
    baseline: await loadBaseline(tree.name),
    exempt: await loadExempt(tree.name),
  });
  configs.push({
    files: [`${tree.root}/**/*.{${exts.join(',')}}`],
    languageOptions: { parser: projectStructureParser },
    plugins: { 'project-structure': projectStructurePlugin },
    rules: { 'project-structure/folder-structure': ['error', createFolderStructure(rule)] },
  });
}

export default configs;
