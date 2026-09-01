/**
 * Baseline-loader factory shared by the structure eslint configs (devkit's own dogfood
 * `eslint.config.mjs` AND the shipped universal shim `templates/_shared/eslint.config.mjs`). Both need
 * the same two async loaders; extracting them here keeps the rule's grandfather/exempt sourcing in ONE
 * place so the dogfood and the shipped shim can't drift.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STRUCTURE_BASELINE_DIR, STRUCTURE_EXEMPT } from '../ratchets/baseline-paths.mts';

interface ImportWallExempt {
  pattern: string;
}

interface BaselineModule {
  [exportName: string]: string[] | Record<string, string[]> | ImportWallExempt[] | undefined;
  structureExempt?: Record<string, string[]>;
  importWallExempt?: ImportWallExempt[];
}

async function importBaselineModule(
  root: string,
  relative: string,
): Promise<BaselineModule | null> {
  // Absolute from the start: Node reports load failures by absolute pathname, and the transient-
  // absence classifier compares against this value, so a relative root must not reach it.
  const file = resolve(root, relative);
  // A concurrent regeneration rewrites this module as unlink→write. Probe across that window —
  // wherever the unlink lands relative to the existence check and import() — so a mid-rewrite read
  // cannot transiently report debt as empty. Failures are classified by KIND, not by re-probing:
  // this module's own absence is the transient the loop absorbs, while any other load error (a
  // syntax error, a missing import inside the module) belongs to the consumer and fails loud.
  // Every terminal outcome is decided by the FINAL attempt's own observation: a module still
  // present but unloadable after the window fails loud, and stable absence means no debt.
  for (let attempt = 0; ; attempt += 1) {
    const finalAttempt = attempt === 2;
    if (existsSync(file)) {
      try {
        // SAFETY: baseline modules are Devkit-generated or match the documented exemption template;
        // consumers are validated at the string-array read sites below.
        return (await import(pathToFileURL(file).href)) as BaselineModule;
      } catch (error) {
        if (!(error instanceof Error) || !isTransientModuleAbsence(error, file)) throw error;
        if (finalAttempt) throw error;
      }
    } else if (finalAttempt) {
      return null;
    }
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

/** True only when the load failure IS this module's own absence (the unlink of a rewrite). */
export function isTransientModuleAbsence(error: Error, file: string): boolean {
  // SAFETY: Node module-load failures carry ErrnoException.code/path; absent fields fail the check.
  const { code, path } = error as NodeJS.ErrnoException;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ENOENT') return false;
  // A file that is absent RIGHT NOW is mid-rewrite regardless of what the message names —
  // retrying is correct even if the not-found module was a nested import, because the next probe
  // re-observes this file directly.
  if (!existsSync(file)) return true;
  // Node reports the real path, so a symlinked segment in `file` must not defeat the comparison.
  // The MISSING module opens the message; "imported from" later may name this file when a
  // consumer's own import inside the module is broken — that stays loud. Literal prefix
  // comparison keeps paths with quotes or regex metacharacters exact.
  for (const candidate of moduleNameCandidates(file)) {
    if (path === candidate) return true;
    if (error.message.startsWith(`Cannot find module '${candidate}'`)) return true;
  }
  return false;
}

function moduleNameCandidates(file: string): string[] {
  try {
    return [file, realpathSync(file)];
  } catch {
    return [file];
  }
}

/** Load permanent import-wall exception patterns. */
export async function loadImportWallExempt(root: string): Promise<Set<string>> {
  const mod = await importBaselineModule(root, STRUCTURE_EXEMPT);
  const entries = mod?.importWallExempt ?? [];
  return new Set(entries.map(({ pattern }) => pattern));
}

/**
 * @param {string} root repo root (where .devkit baseline state lives)
 * @returns {{loadBaseline:(name:string)=>Promise<string[]>, loadExempt:(name:string)=>Promise<string[]>}}
 */
export function makeBaselineLoaders(root: string) {
  const loadBaseline = async (name: string): Promise<string[]> => {
    const mod = await importBaselineModule(root, `${STRUCTURE_BASELINE_DIR}/${name}.mjs`);
    if (!mod) return [];
    // A baseline module exports one string[] (the grandfather list); read it at the dynamic-import boundary.
    // SAFETY: generated tree baseline modules export exactly one string[] grandfather list.
    return (Object.values(mod)[0] ?? []) as string[];
  };
  // Permanent hand-edited exemptions are policy, separate from generated debt.
  const loadExempt = async (name: string): Promise<string[]> => {
    const mod = await importBaselineModule(root, STRUCTURE_EXEMPT);
    if (!mod) return [];
    return mod.structureExempt?.[name] ?? [];
  };
  return { loadBaseline, loadExempt };
}
