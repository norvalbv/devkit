// ONE decision for spawned eslint: --preserve-symlinks only for a symlinked node_modules (gate
// worktrees) — pnpm's isolated layout already roots correctly and the flag breaks it (sc-2309, #469).

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function eslintNodeFlags(cwd: string): string[] {
  try {
    return lstatSync(join(cwd, 'node_modules')).isSymbolicLink() ? ['--preserve-symlinks'] : [];
  } catch {
    return []; // no node_modules at all: nothing to preserve
  }
}
