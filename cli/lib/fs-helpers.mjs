/**
 * Filesystem helpers for the devkit CLI. Small, dependency-free primitives shared by
 * init / doctor / sync-skills. Every path is the CONSUMER's unless it comes from
 * `packageDir()` (devkit's own dir, the source of templates + skills).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
export function readJson(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`);
  }
}

/** sha256 hex digest of a file's bytes. */
export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Write `content` to `path` only if the file is absent (idempotent create). With
 * `{ force: true }` it overwrites. Creates parent dirs. Returns one of:
 *   'created'   — file did not exist, written
 *   'forced'    — file existed, overwritten (force)
 *   'exists'    — file existed, left untouched (no force)
 */
export function writeIfAbsent(path, content, { force = false } = {}) {
  const present = existsSync(path);
  if (present && !force) return 'exists';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return present ? 'forced' : 'created';
}
