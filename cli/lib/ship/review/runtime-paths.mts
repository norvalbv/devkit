/** Shared physical-path invariants for review runtimes and their private manifests. */

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

/** True for one normalized package/repository-relative POSIX path with no traversal syntax. */
export function isSafeReviewRelativePath(path: string): boolean {
  const segments = path.split('/');
  return (
    Boolean(path) &&
    !path.includes('\\') &&
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..')
  );
}

/** Canonicalize harmless dot/slash syntax while rejecting traversal and absolute paths. */
export function normalizeSafeReviewRelativePath(path: string): string | null {
  const value = path.trim();
  if (!value || value.includes('\0') || value.includes('\\') || isAbsolute(value)) return null;
  if (win32.isAbsolute(value)) return null;
  const segments = value.split('/');
  if (segments.includes('..')) return null;
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  return isSafeReviewRelativePath(normalized) ? normalized : null;
}

/** True when candidate is root itself or a descendant, never a lexical sibling. */
export function reviewPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve an existing directory physically so later containment checks cannot follow an ancestor. */
export function canonicalReviewDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(path));
  } catch {
    throw new Error(`devkit review: ${label} is not an available directory: ${path}`);
  }
  if (!lstatSync(canonical).isDirectory())
    throw new Error(`devkit review: ${label} is not a directory: ${path}`);
  return canonical;
}

/** Resolve a prospective leaf through its existing physical parent without following the leaf. */
export function canonicalReviewLeaf(path: string, parentLabel: string): string {
  const requested = resolve(path);
  const parent = canonicalReviewDirectory(dirname(requested), parentLabel);
  return join(parent, basename(requested));
}
