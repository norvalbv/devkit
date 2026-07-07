/**
 * Deterministic-prefix pass cache: remembers that the deterministic gate prefix (format,
 * ratchets, dup/clone, lint, structure) ran ALL-GREEN for an exact staged tree, so a re-ship
 * of the identical tree (retry after an AI-gate timeout, a re-run after `devkit ship` was
 * killed) skips straight to the AI gates instead of re-verifying ~minutes of unchanged work.
 *
 * Key = sha256(git write-tree ∥ devkit version ∥ sha256(hook file bytes) ∥ scope):
 *   - `git write-tree` hashes the exact staged index — every tracked gate input (source,
 *     guard.config.json, baselines, allowlists) is in-tree, so any change misses.
 *   - the devkit version + literal hook bytes salt the key so upgrading devkit or editing
 *     the hook re-runs the gates.
 *   - `scope` lets a consumer wrap hand-authored gate regions with their own cache line
 *     (`guard-prefix check --scope my-extra-gates`).
 *
 * SHIP-SCOPED both ways: `check` and `record` are no-ops unless DEVKIT_SHIP=1 (exported by
 * the ship path). Some deterministic gates (repo-wide lint, the dup matcher) read the
 * WORKING TREE, and the key hashes the INDEX — the two are only guaranteed identical inside
 * a ship worktree. A non-ship, partially-staged commit must neither trust nor write a key.
 *
 * Known blind spot: gitignored gate inputs (e.g. the `.search-code` embedding index behind
 * guard-dup) can change results without changing the key — same staleness class as the
 * review cache; `guard-prefix clear` is the escape hatch.
 *
 * Storage/atomicity/failure direction: shared judge/verdict-store (`.devkit/prefix-cache.json`,
 * main-checkout anchored, atomic writes, corrupt → empty → run the gates).
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { clearEntries, devkitDataFile, loadEntries, saveEntries } from "../judge/verdict-store.mjs";
const STORE_FILE = 'prefix-cache.json';
// This package's own version — a behaviour salt, not consumer data, so the one sanctioned
// exception to W-3's "no import.meta.url" rule (gate semantics change across versions).
function devkitVersion() {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
        return pkg.version;
    }
    catch {
        return 'unknown';
    }
}
function shipScoped() {
    const v = process.env.DEVKIT_SHIP;
    if (v === undefined)
        return false;
    const t = String(v).trim().toLowerCase();
    return !(t === '' || t === '0' || t === 'false' || t === 'no');
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/**
 * The cache key for the current staged index, or null when it cannot be computed (not a
 * repo, unmerged index, unreadable hook file) — null always means "run the gates".
 */
export function computeKey(cwd, { hookPath, scope = 'devkit-guards', versionSalt } = {}) {
    let tree;
    try {
        tree = execSync('git write-tree', { cwd, encoding: 'utf8' }).trim();
    }
    catch {
        return null;
    }
    let hookHash = '';
    if (hookPath) {
        try {
            hookHash = sha256(readFileSync(path.resolve(cwd, hookPath)));
        }
        catch {
            return null;
        }
    }
    return sha256([tree, versionSalt ?? devkitVersion(), hookHash, scope].join('\0'));
}
/** True when the exact staged tree already ran all-green (ship runs only). */
export function checkPrefix(cwd, opts = {}) {
    if (!shipScoped())
        return false;
    const key = computeKey(cwd, opts);
    if (!key)
        return false;
    return Boolean(loadEntries(devkitDataFile(cwd, STORE_FILE))[key]);
}
/** Record the current staged tree as all-green (ship runs only; best-effort). */
export function recordPrefix(cwd, opts = {}) {
    if (!shipScoped())
        return;
    const key = computeKey(cwd, opts);
    if (!key)
        return;
    saveEntries(devkitDataFile(cwd, STORE_FILE), { [key]: { at: new Date().toISOString() } });
}
/** Drop every cached prefix key (the escape hatch for gitignored-input staleness). */
export function clearPrefix(cwd) {
    clearEntries(devkitDataFile(cwd, STORE_FILE));
}
