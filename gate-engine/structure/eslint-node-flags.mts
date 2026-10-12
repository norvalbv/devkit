// ONE decision for spawned eslint, twin of the overlay hook's: --preserve-symlinks only for a linked
// hoisted install. An isolated store (pnpm, bun --linker isolated) links eslint itself; the flag breaks it.

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function eslintNodeFlags(cwd: string): string[] {
  const modules = join(cwd, 'node_modules');
  const preserve =
    isLink(modules) &&
    !isLink(join(modules, 'eslint')) &&
    existsSync(join(modules, 'eslint', 'bin', 'eslint.js'));
  return preserve ? ['--preserve-symlinks'] : [];
}

export const LINKED_ISOLATED_STORE =
  'a linked isolated install (pnpm, bun --linker isolated) cannot root structure lint at this worktree — run it where node_modules is installed';

/** A linked node_modules whose eslint is itself a link: no spawn can root the plugin at this worktree. */
export function linkedIsolatedStore(cwd: string): boolean {
  const modules = join(cwd, 'node_modules');
  return isLink(modules) && isLink(join(modules, 'eslint'));
}
