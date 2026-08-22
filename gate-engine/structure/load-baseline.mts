/**
 * Baseline-loader factory shared by the structure eslint configs (devkit's own dogfood
 * `eslint.config.mjs` AND the shipped universal shim `templates/_shared/eslint.config.mjs`). Both need
 * the same two async loaders; extracting them here keeps the rule's grandfather/exempt sourcing in ONE
 * place so the dogfood and the shipped shim can't drift.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LEGACY_STRUCTURE_BASELINE_DIR,
  LEGACY_STRUCTURE_EXEMPT,
  STRUCTURE_BASELINE_DIR,
  STRUCTURE_EXEMPT,
} from '../ratchets/baseline-paths.mts';

interface ImportWallExempt {
  pattern: string;
}

interface BaselineModule {
  [exportName: string]: string[] | Record<string, string[]> | ImportWallExempt[] | undefined;
  structureExempt?: Record<string, string[]>;
  importWallExempt?: ImportWallExempt[];
}

async function importAcrossMigration(
  root: string,
  canonical: string,
  legacy: string,
): Promise<BaselineModule | null> {
  const canonicalFile = join(root, canonical);
  const legacyFile = join(root, legacy);
  for (const file of [canonicalFile, legacyFile, canonicalFile]) {
    if (!existsSync(file)) continue;
    try {
      // SAFETY: baseline modules are Devkit-generated or match the documented exemption template;
      // consumers are validated at the string-array read sites below.
      return (await import(pathToFileURL(file).href)) as BaselineModule;
    } catch (error) {
      // A migration may remove the selected legacy name between existsSync and import(). Retry the
      // canonical name; a stable syntax/load error still belongs to the consumer and must fail loud.
      if (existsSync(file)) throw error;
    }
  }
  return null;
}

/** Load permanent import-wall exception patterns across the storage migration. */
export async function loadImportWallExempt(root: string): Promise<Set<string>> {
  try {
    const mod = await importAcrossMigration(root, STRUCTURE_EXEMPT, LEGACY_STRUCTURE_EXEMPT);
    const entries = mod?.importWallExempt ?? [];
    return new Set(entries.map(({ pattern }) => pattern));
  } catch {
    return new Set();
  }
}

/**
 * @param {string} root repo root (where .devkit baseline state lives)
 * @returns {{loadBaseline:(name:string)=>Promise<string[]>, loadExempt:(name:string)=>Promise<string[]>}}
 */
export function makeBaselineLoaders(root: string) {
  // Canonical Devkit-owned debt first; legacy ESLint storage remains readable through migration.
  const loadBaseline = async (name: string): Promise<string[]> => {
    const mod = await importAcrossMigration(
      root,
      `${STRUCTURE_BASELINE_DIR}/${name}.mjs`,
      `${LEGACY_STRUCTURE_BASELINE_DIR}/${name}.mjs`,
    );
    if (!mod) return [];
    // A baseline module exports one string[] (the grandfather list); read it at the dynamic-import boundary.
    // SAFETY: generated tree baseline modules export exactly one string[] grandfather list.
    return (Object.values(mod)[0] ?? []) as string[];
  };
  // Permanent hand-edited exemptions are policy, separate from generated debt.
  const loadExempt = async (name: string): Promise<string[]> => {
    const mod = await importAcrossMigration(root, STRUCTURE_EXEMPT, LEGACY_STRUCTURE_EXEMPT);
    if (!mod) return [];
    return mod.structureExempt?.[name] ?? [];
  };
  return { loadBaseline, loadExempt };
}
