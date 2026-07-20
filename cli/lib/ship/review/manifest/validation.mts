/** Shared structural invariants for authenticated review manifests. */

import { isAbsolute } from 'node:path';
import { reviewPathWithin } from '../runtime-paths.mts';

export interface ReviewManifestRoots {
  targetRoot: string;
  gitRoot: string;
}

export function hasExactManifestKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export function isSafeManifestAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!isAbsolute(value)) return false;
  return !value.includes('\0');
}

export function hasValidManifestRoots(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  version: number,
): value is Record<string, unknown> & ReviewManifestRoots {
  if (!hasExactManifestKeys(value, expectedKeys)) return false;
  if (value.version !== version) return false;
  if (!isSafeManifestAbsolutePath(value.targetRoot)) return false;
  if (!isSafeManifestAbsolutePath(value.gitRoot)) return false;
  return reviewPathWithin(value.gitRoot, value.targetRoot);
}
