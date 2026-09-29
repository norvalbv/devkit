/** A linked worktree's node_modules symlinked to the main worktree's is copied as a directory. See
 *  docs/decisions/review-dependency-runtime-main-worktree-alias.md. */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  dependencyInstallRemedy,
  missingDeclaredDependencies,
} from '../../dependency-preflight.mts';
import { reviewPathWithin } from '../runtime-paths.mts';
import { fail, gitEnvironment } from '../shared/common.mts';

/** Tool caches a shared install churns under every worktree's runs; the private runtime regenerates
 *  them. Package contents are never skipped, so a real install change still aborts review. */
const TOOL_CACHE_DIRS = new Set(['.cache', '.vite', '.vite-temp']);

/** True for `.git` anywhere and for a known tool cache directly under a `node_modules` directory. */
export function skippedDependencyEntry(directory: string, name: string): boolean {
  return name === '.git' || (basename(directory) === 'node_modules' && TOOL_CACHE_DIRS.has(name));
}

/** Surface path (repo-relative) → physical directory it resolves to in the main worktree. */
export type DependencyAliases = Map<string, string>;

function gitStdout(root: string, args: string[]): string | null {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8',
    env: gitEnvironment(),
  });
  return result.status === 0 ? result.stdout : null;
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** `root`'s counterpart inside the main worktree, or null outside git / in the main worktree. */
export function mainWorktreeAlias(root: string): string | null {
  const top = gitStdout(root, ['rev-parse', '--show-toplevel'])?.trimEnd();
  const list = gitStdout(root, ['worktree', 'list', '--porcelain']);
  if (!top || !list) return null;
  const firstBlock = list.split('\n\n')[0]?.split('\n') ?? [];
  const mainLine = firstBlock[0];
  if (!mainLine?.startsWith('worktree ') || firstBlock.includes('bare')) return null;
  const main = canonical(mainLine.slice('worktree '.length));
  const toplevel = canonical(top);
  if (main === null || toplevel === null || main === toplevel) return null;
  const alias = resolve(main, relative(toplevel, root));
  return reviewPathWithin(main, alias) ? alias : null;
}

function remedy(root: string, surfacePath: string, detail: string): never {
  return fail(
    `${surfacePath} ${detail}; replace it with a real install in ${root}: ` +
      dependencyInstallRemedy(root),
  );
}

/** Classify every symlinked surface: in-repo links stay links, main-worktree links become aliases. */
export function resolveDependencyAliases(root: string, surfaces: string[]): DependencyAliases {
  const aliases: DependencyAliases = new Map();
  let alias: string | null | undefined;
  for (const surface of surfaces) {
    const surfacePath = join(root, ...surface.split('/'));
    if (!lstatSync(surfacePath).isSymbolicLink()) continue;
    const physical = canonical(surfacePath);
    // Dangling and in-repo links keep the generic link-graph validation and its messages.
    if (physical === null || reviewPathWithin(root, physical)) continue;
    alias = alias === undefined ? mainWorktreeAlias(root) : alias;
    const expected = alias === null ? null : join(alias, ...surface.split('/'));
    if (
      expected === null ||
      physical !== canonical(expected) ||
      !statSync(physical).isDirectory()
    ) {
      remedy(root, surfacePath, `links to ${physical}, outside this repository's main worktree`);
    }
    const missing = missingDeclaredDependencies(
      join(dirname(surfacePath), 'package.json'),
      physical,
    );
    if (missing.length > 0) {
      remedy(
        root,
        surfacePath,
        `links to a stale install at ${physical} (missing: ${missing.join(', ')})`,
      );
    }
    aliases.set(surface, physical);
  }
  return aliases;
}

/** Map a physical path inside an aliased surface back onto the lexical surface under `root`. */
export function reRootAliasedPath(root: string, path: string, aliases: DependencyAliases): string {
  for (const [surface, physical] of aliases) {
    if (reviewPathWithin(physical, path)) {
      return join(root, ...surface.split('/'), relative(physical, path));
    }
  }
  return path;
}

/** Name the shared main-worktree install when a frozen topology changed under an aliased surface. */
export function aliasedChangeHint(aliases: DependencyAliases): string {
  if (aliases.size === 0) return '';
  return ` (shared install ${[...aliases.values()].join(', ')} changed — a package install in the main checkout?)`;
}
