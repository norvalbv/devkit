/**
 * The one definition of what `bun run build` mirrors into dist/: the whole root asset dirs, plus the
 * non-TS files under cli/ and gate-engine/ that tsc never emits.
 *
 * copy-dist-assets.mjs does the copying; tests import the same enumerators so a check over "every
 * file a consumer receives" cannot drift from the set the build actually ships.
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Whole root asset dirs + files consumed via packageDir() / the exports map. */
export const ROOT_DIRS = [
  'biome',
  'tsconfig',
  'oxc',
  'templates',
  'skills',
  'agents',
  'agents-hooks',
];

/** The two trees tsc compiles, and the only ones carrying non-TS files worth mirroring. */
export const TREE_ROOTS = ['cli', 'gate-engine'];

// Dev-only: tsconfig.build.json excludes both, so nothing under dist/ may reference them.
const isDevOnly = (rel) =>
  rel.includes('__tests__') || rel.includes(`${'eval'}/`) || rel.includes('/eval/');

function walk(root, dir, matchRe, skip) {
  const found = [];
  for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !matchRe.test(entry.name)) continue;
    const rel = relative(root, join(entry.parentPath, entry.name));
    if (!skip?.(rel)) found.push(rel);
  }
  return found;
}

/** Repo-relative paths under cli/ + gate-engine/ matching `matchRe`, dev-only trees dropped. */
export function shippedTreeFiles(root, matchRe) {
  return TREE_ROOTS.flatMap((tree) => walk(root, tree, matchRe, isDevOnly));
}

/** Repo-relative paths under the ROOT_DIRS mirror matching `matchRe`. Those dirs ship whole. */
export function shippedRootDirFiles(root, matchRe) {
  return ROOT_DIRS.flatMap((dir) => walk(root, dir, matchRe));
}
