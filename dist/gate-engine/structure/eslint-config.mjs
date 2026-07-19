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
import { createFolderStructure, projectStructureParser, projectStructurePlugin, } from 'eslint-plugin-project-structure';
import { resolveGuardConfig, resolveTreeExtensions } from '../config.mjs';
import { compileToEslint } from './compile.mjs';
import { makeBaselineLoaders } from './load-baseline.mjs';
/**
 * Build the eslint flat-config array governing a repo's declared structure trees (one
 * folder-structure rule per grammar tree). `root` is the repo root (holds guard.config.json +
 * eslint/baselines/).
 */
export async function buildStructureConfigs(root) {
    const cfg = resolveGuardConfig(root);
    const { loadBaseline, loadExempt } = makeBaselineLoaders(root);
    const configs = [];
    // cfg.structure.trees is object[] generically; at this config-read boundary they ARE tree specs.
    const trees = (cfg.structure?.trees ?? []);
    for (const tree of trees) {
        if (!tree.grammar)
            continue; // a `preset` tree (if any) compiles via its own path, not here
        const exts = resolveTreeExtensions(cfg, tree);
        const rule = compileToEslint(tree, exts, {
            baseline: await loadBaseline(tree.name),
            exempt: await loadExempt(tree.name),
        });
        configs.push({
            // A single extension must NOT use a brace: minimatch does not expand a 1-element `{mts}`, so
            // `*.{mts}` would match nothing (ESLint reports every file ignored). Brace only for 2+ exts.
            files: [
                exts.length === 1
                    ? `${tree.root}/**/*.${exts[0]}`
                    : `${tree.root}/**/*.{${exts.join(',')}}`,
            ],
            languageOptions: { parser: projectStructureParser },
            plugins: { 'project-structure': projectStructurePlugin },
            // compile.mts stays plugin-free and returns a plain (runtime-valid) config object; cast it to
            // the plugin's own input type at this — the single — plugin-wrapping seam.
            rules: {
                'project-structure/folder-structure': [
                    'error',
                    createFolderStructure(rule),
                ],
            },
        });
    }
    return configs;
}
