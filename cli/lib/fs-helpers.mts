/**
 * Filesystem helpers for the devkit CLI. Small, dependency-free primitives shared by
 * init / doctor / sync-skills. Every path is the CONSUMER's unless it comes from
 * `packageDir()` (devkit's own dir, the source of templates + skills).
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve devkit's OWN package root from this module's URL. cli/lib/fs-helpers.mjs is
 * two dirs below the package root, so go up twice. This is the ONE place keyed to the
 * package dir — templates/ and skills/ are read from here, never from the consumer cwd.
 */
export function packageDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Read + parse a JSON file. Returns null if absent; throws on malformed JSON (loud, not silent). */
export function readJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e: unknown) {
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** sha256 hex digest of a file's bytes. */
export function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** True iff `path` exists AND is a symlink (does NOT follow it). False if absent. */
function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // absent
  }
}

/**
 * Write `content` to `path` only if the file is absent (idempotent create). With
 * `{ force: true }` it overwrites. Creates parent dirs. Returns one of:
 *   'created'   — file did not exist, written
 *   'forced'    — file existed, overwritten (force)
 *   'exists'    — file existed, left untouched (no force)
 */
export function writeIfAbsent(
  path: string,
  content: string | NodeJS.ArrayBufferView,
  { force = false }: { force?: boolean } = {},
) {
  const present = existsSync(path);
  if (present && !force) return 'exists';
  // A sibling tool can leave the dest dir (or file) as a SYMLINK — e.g. .cursor/skills/<name> →
  // ../../.agents/skills/<name>. devkit owns the exact path it writes, so REPLACE a symlink at the
  // leaf with a real entry rather than follow it: mkdirSync({recursive}) throws ENOENT on a
  // dangling-symlink dir, and a live one would route the write outside devkit's tree. Only the leaf
  // is touched — never an ancestor the user may have symlinked on purpose.
  const dir = dirname(path);
  if (isSymlink(dir)) rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true });
  if (isSymlink(path)) rmSync(path, { force: true });
  writeFileSync(path, content);
  return present ? 'forced' : 'created';
}
