/**
 * Deterministic-prefix pass cache: remembers that the deterministic gate prefix (format,
 * ratchets, dup/clone, lint, structure) ran ALL-GREEN for an exact staged tree, so a re-ship
 * of the identical tree (retry after an AI-gate timeout, a re-run after `devkit ship` was
 * killed) skips straight to the AI gates instead of re-verifying ~minutes of unchanged work.
 *
 * Key = sha256(git write-tree ∥ devkit version ∥ sha256(hook file bytes) ∥ scope ∥ config fingerprint):
 *   - `git write-tree` hashes the exact staged index — every tracked gate input (source,
 *     guard.config.json, baselines, allowlists) is in-tree, so any change misses.
 *   - the devkit version + literal hook bytes salt the key so upgrading devkit or editing
 *     the hook re-runs the gates.
 *   - `scope` lets a consumer wrap hand-authored gate regions with their own cache line
 *     (`guard-prefix check --scope my-extra-gates`).
 *   - the config fingerprint ({@link gateConfigFingerprint}) covers gate inputs that live OUTSIDE
 *     the tracked index — an untracked/overlay-gitignored guard.config.json, a gitignored baseline,
 *     the `.search-code` index, jscpd availability — so hardening the gates invalidates a PASS earned
 *     under the weaker config. This closes the masking blind spot below for those inputs.
 *
 * SHIP-SCOPED both ways: `check` and `record` are no-ops unless DEVKIT_SHIP=1 (exported by
 * the ship path). Some deterministic gates (repo-wide lint, the dup matcher) read the
 * WORKING TREE, and the key hashes the INDEX — the two are only guaranteed identical inside
 * a ship worktree. A non-ship, partially-staged commit must neither trust nor write a key.
 *
 * The config fingerprint requires those gitignored inputs to be PRESENT in the worktree it reads
 * (the ship linker symlinks them in) — an input that was never linked reads as `absent`, which still
 * flips the key the moment it IS linked, so a pre-link poisoned entry can't survive. `guard-prefix
 * clear` remains the manual escape hatch.
 *
 * Storage/atomicity/failure direction: shared judge/verdict-store (`.devkit/prefix-cache.json`,
 * main-checkout anchored, atomic writes, corrupt → empty → run the gates).
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { clearEntries, devkitDataFile, loadEntries, saveEntries } from '../judge/verdict-store.mts';
import { gateConfigFingerprint } from './config-fingerprint.mts';

const STORE_FILE = 'prefix-cache.json';

// This package's own version — a behaviour salt, not consumer data, so the one sanctioned
// exception to W-3's "no import.meta.url" rule (gate semantics change across versions).
function devkitVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function shipScoped() {
  const v = process.env.DEVKIT_SHIP;
  if (v === undefined) return false;
  const t = String(v).trim().toLowerCase();
  return !(t === '' || t === '0' || t === 'false' || t === 'no');
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// Salt inputs for the cache key. `versionSalt` is injectable for tests; callers omit it.
interface KeyOpts {
  hookPath?: string;
  scope?: string;
  versionSalt?: string;
}

/**
 * The cache key for the current staged index, or null when it cannot be computed (not a
 * repo, unmerged index, unreadable hook file) — null always means "run the gates".
 */
export function computeKey(
  cwd: string,
  { hookPath, scope = 'devkit-guards', versionSalt }: KeyOpts = {},
): string | null {
  let tree: string;
  try {
    tree = execSync('git write-tree', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
  let hookHash = '';
  if (hookPath) {
    try {
      hookHash = sha256(readFileSync(path.resolve(cwd, hookPath)));
    } catch {
      return null;
    }
  }
  // Fold in a fingerprint of the gate config (things outside the staged index). A throw here means the
  // config can't be read (e.g. malformed guard.config.json) — return null (run the gates), never a
  // key that would trust a prior PASS earned under an unknowable config.
  let configHash: string;
  try {
    configHash = gateConfigFingerprint(cwd);
  } catch {
    return null;
  }
  return sha256([tree, versionSalt ?? devkitVersion(), hookHash, scope, configHash].join('\0'));
}

/** True when the exact staged tree already ran all-green (ship runs only). */
export function checkPrefix(cwd: string, opts: KeyOpts = {}) {
  if (!shipScoped()) return false;
  const key = computeKey(cwd, opts);
  if (!key) return false;
  return Boolean(loadEntries(devkitDataFile(cwd, STORE_FILE))[key]);
}

/** Record the current staged tree as all-green (ship runs only; best-effort). */
export function recordPrefix(cwd: string, opts: KeyOpts = {}) {
  if (!shipScoped()) return;
  const key = computeKey(cwd, opts);
  if (!key) return;
  saveEntries(devkitDataFile(cwd, STORE_FILE), { [key]: { at: new Date().toISOString() } });
}

/** Drop every cached prefix key (the escape hatch for gitignored-input staleness). */
export function clearPrefix(cwd: string) {
  clearEntries(devkitDataFile(cwd, STORE_FILE));
}
