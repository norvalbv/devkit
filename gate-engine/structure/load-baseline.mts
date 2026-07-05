/**
 * Baseline-loader factory shared by the structure eslint configs (devkit's own dogfood
 * `eslint.config.mjs` AND the shipped universal shim `templates/_shared/eslint.config.mjs`). Both need
 * the same two async loaders; extracting them here keeps the rule's grandfather/exempt sourcing in ONE
 * place so the dogfood and the shipped shim can't drift.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} root repo root (where eslint/baselines/ lives)
 * @returns {{loadBaseline:(name:string)=>Promise<string[]>, loadExempt:(name:string)=>Promise<string[]>}}
 */
export function makeBaselineLoaders(root: string) {
  // A tree's generated grandfather list = the single array exported by eslint/baselines/<name>.mjs.
  const loadBaseline = async (name: string): Promise<string[]> => {
    const f = join(root, 'eslint', 'baselines', `${name}.mjs`);
    if (!existsSync(f)) return [];
    const mod = await import(pathToFileURL(f).href);
    // A baseline module exports one string[] (the grandfather list); read it at the dynamic-import boundary.
    return (Object.values(mod)[0] ?? []) as string[];
  };
  // Permanent hand-edited exemptions keyed by tree name (eslint/baselines/exempt.mjs → structureExempt).
  const loadExempt = async (name: string): Promise<string[]> => {
    const f = join(root, 'eslint', 'baselines', 'exempt.mjs');
    if (!existsSync(f)) return [];
    const mod = await import(pathToFileURL(f).href);
    return (mod.structureExempt?.[name] ?? []) as string[];
  };
  return { loadBaseline, loadExempt };
}
