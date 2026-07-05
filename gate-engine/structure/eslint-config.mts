/**
 * The eslint-integration layer of the structure engine — the SINGLE place that turns a repo's
 * `guard.config.json` `structure` block into eslint flat-config entries. Both devkit's own dogfood
 * `eslint.config.mjs` AND the shipped universal shim (`templates/_shared/eslint.config.mjs`) are now
 * one line over this, so there's exactly one copy of the assembly logic (no dogfood↔shim drift).
 *
 * This module (and only this one) imports `eslint-plugin-project-structure` — a peer/consumer dep
 * (every consumer installs it; devkit devDeps it for the dogfood). compile.mjs stays plugin-free
 * (returns a plain config object); the plugin wrapping happens here.
 */

import {
  createFolderStructure,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';
import { resolveGuardConfig, resolveTreeExtensions } from '../config.mts';
import { compileToEslint } from './compile.mts';
import { makeBaselineLoaders } from './load-baseline.mts';

/**
 * Build the eslint flat-config array governing a repo's declared structure trees.
 * @param {string} root repo root (holds guard.config.json + eslint/baselines/)
 * @returns {Promise<object[]>} flat-config entries (one folder-structure rule per grammar tree)
 */
export async function buildStructureConfigs(root) {
  const cfg = resolveGuardConfig(root);
  const { loadBaseline, loadExempt } = makeBaselineLoaders(root);
  const configs = [];
  for (const tree of cfg.structure?.trees ?? []) {
    if (!tree.grammar) continue; // a `preset` tree (if any) compiles via its own path, not here
    const exts = resolveTreeExtensions(cfg, tree);
    const rule = compileToEslint(tree, exts, {
      baseline: await loadBaseline(tree.name),
      exempt: await loadExempt(tree.name),
    });
    configs.push({
      files: [`${tree.root}/**/*.{${exts.join(',')}}`],
      languageOptions: { parser: projectStructureParser },
      plugins: { 'project-structure': projectStructurePlugin },
      // compile.mts stays plugin-free and returns a plain (runtime-valid) config object; cast it to
      // the plugin's own input type at this — the single — plugin-wrapping seam.
      rules: {
        'project-structure/folder-structure': [
          'error',
          createFolderStructure(rule as Parameters<typeof createFolderStructure>[0]),
        ],
      },
    });
  }
  return configs;
}
