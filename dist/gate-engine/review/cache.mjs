/**
 * PASS-verdict cache for the review gate. Presence of a key = that reviewer PASSed that
 * exact staged domain diff, so an identical diff re-run (amend, rebase replay, retry after
 * an unrelated gate fix, a re-ship) skips the judge entirely.
 *
 * Storage, worktree anchoring, atomicity, and failure direction live in the shared
 * judge/verdict-store (one `.devkit/review-cache.json` per consumer repo, main-checkout
 * anchored, atomic writes, corrupt → empty → re-review).
 */
import { clearEntries, devkitDataFile, loadEntries, saveEntries, } from "../judge/verdict-store.mjs";
const CACHE_FILE = 'review-cache.json';
/** Absolute cache-file path for a consumer cwd (main-checkout `.devkit/review-cache.json`). */
export function cachePath(cwd) {
    return devkitDataFile(cwd, CACHE_FILE);
}
/** entries map (key → {at, model}); corrupt/absent/foreign-version → {} (fails toward re-review). */
export function loadCache(cwd) {
    return loadEntries(cachePath(cwd));
}
/** Record PASS keys (checkpointed per completed cascade). Prunes to the newest entries. */
export function savePasses(cwd, keyToMeta) {
    saveEntries(cachePath(cwd), keyToMeta);
}
/** Drop the cache file's entries (guard-review clear-cache). */
export function clearCache(cwd) {
    clearEntries(cachePath(cwd));
}
